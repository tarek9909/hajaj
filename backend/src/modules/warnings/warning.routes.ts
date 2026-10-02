import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { createCustomWarningSchema, voidWarningSchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const warningRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/warnings?month=YYYY-MM
warningRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        w.id,
        w.employee_id,
        e.full_name AS employee_name,
        e.employee_number,
        p.name AS position_name,
        w.origin,
        w.automatic_attendance_day_id,
        DATE_FORMAT(w.incident_date, '%Y-%m-%d') AS incident_date,
        w.title,
        w.reason,
        w.late_minutes,
        w.system_qualifies,
        w.counts_toward_limit,
        w.admin_voided,
        w.void_reason,
        w.voided_at,
        w.created_at,
        w.row_version,
        va.full_name AS voided_by_name,
        ca.full_name AS created_by_name
       FROM warnings w
       JOIN employees e ON e.id = w.employee_id
       JOIN positions p ON p.id = e.position_id
       LEFT JOIN admin_accounts va ON va.id = w.voided_by
       LEFT JOIN admin_accounts ca ON ca.id = w.created_by
       WHERE w.restaurant_id = ? 
         AND w.incident_date >= ? AND w.incident_date < DATE_ADD(?, INTERVAL 1 MONTH)
       ORDER BY w.incident_date DESC, w.created_at DESC`,
      [restaurantId, monthStart, monthStart]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        employeeId: String(r.employee_id),
        employeeName: r.employee_name,
        employeeNumber: r.employee_number,
        positionName: r.position_name,
        origin: r.origin,
        automaticAttendanceDayId: r.automatic_attendance_day_id ? String(r.automatic_attendance_day_id) : null,
        incidentDate: r.incident_date,
        title: r.title,
        reason: r.reason,
        lateMinutes: r.late_minutes,
        systemQualifies: Boolean(r.system_qualifies),
        countsTowardLimit: Boolean(r.counts_toward_limit),
        adminVoided: Boolean(r.admin_voided),
        isValid: Boolean(r.system_qualifies) && !r.admin_voided,
        voidReason: r.void_reason,
        voidedByName: r.voided_by_name,
        voidedAt: r.voided_at,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/employees/:employeeId/warnings or /warnings
const handleCreateWarning = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId || req.body.employeeId);
    if (!employeeId || employeeId === 'undefined') {
      throw new AppError(400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required');
    }
    const actorId = req.tenantContext!.actorId;
    const body = createCustomWarningSchema.parse(req.body);

    const monthStart = `${body.incidentDate.slice(0, 7)}-01`;

    let newWarningId: number = 0;
    await withTransaction(async (conn) => {
      // Check employee
      const [empRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM employees WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, employeeId]
      );
      if (!empRows[0]) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

      // Check payroll period is not finalized
      const [perRows] = await conn.execute<RowDataPacket[]>(
        `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, monthStart]
      );
      if (perRows[0]?.status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot add warning to a finalized period');
      }

      const [resHeader] = await conn.execute<ResultSetHeader>(
        `INSERT INTO warnings 
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, admin_voided, created_by)
         VALUES (?, ?, 'CUSTOM', NULL, ?, ?, ?, NULL, 1, ?, 0, ?)`,
        [
          restaurantId,
          employeeId,
          body.incidentDate,
          body.title,
          body.reason,
          body.countsTowardLimit ? 1 : 0,
          actorId,
        ]
      );
      newWarningId = resHeader.insertId;

      // Increment source_revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, monthStart]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_CUSTOM_WARNING',
          entityType: 'WARNING',
          entityId: String(resHeader.insertId),
          requestId: req.requestId,
          afterValues: body,
        },
        conn
      );
    });

    res.status(201).json({
      data: { id: String(newWarningId), message: 'Custom warning created successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};

warningRouter.post('/employees/:employeeId', handleCreateWarning);
warningRouter.post('/', handleCreateWarning);

// POST /api/v1/restaurants/:restaurantId/warnings/:warningId/void
warningRouter.post('/:warningId/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const warningId = String(req.params.warningId);
    const actorId = req.tenantContext!.actorId;
    const body = voidWarningSchema.parse(req.body);

    await withTransaction(async (conn) => {
      const [wRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, incident_date, admin_voided, row_version FROM warnings WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, warningId]
      );
      const w = wRows[0];
      if (!w) throw new AppError(404, 'WARNING_NOT_FOUND', 'Warning not found');
      if (w.admin_voided) throw new AppError(400, 'ALREADY_VOIDED', 'Warning is already voided');
      if (Number(w.row_version) !== body.expectedVersion) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Warning was modified by another administrator');
      }

      const monthStart = `${DateTime.fromJSDate(w.incident_date).toISODate()!.slice(0, 7)}-01`;

      const [perRows] = await conn.execute<RowDataPacket[]>(
        `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, monthStart]
      );
      if (perRows[0]?.status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot void warning in a finalized month');
      }

      await conn.execute(
        `UPDATE warnings 
         SET admin_voided = 1,
             void_reason = ?,
             voided_by = ?,
             voided_at = NOW(3),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ?`,
        [body.voidReason, actorId, actorId, restaurantId, warningId]
      );

      // Increment source_revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, monthStart]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'VOID_WARNING',
          entityType: 'WARNING',
          entityId: warningId,
          requestId: req.requestId,
          reason: body.voidReason,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Warning voided successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
