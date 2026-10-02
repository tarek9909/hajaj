import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { createCustomWarningSchema, voidWarningSchema, monthQuerySchema } from '../../contracts/schemas.js';
import { lockOpenPeriod, bumpSourceRevision } from '../payroll/periodLock.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const warningRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/warnings?month=YYYY-MM
warningRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = monthQuerySchema.parse(req.query.month || new Date().toISOString().slice(0, 7));
    const monthStart = `${month}-01`;

    // Policy effective for this month (latest revision of the latest effective version)
    const [policyRows] = await pool.execute<RowDataPacket[]>(
      `SELECT warning_threshold FROM restaurant_policy_versions
       WHERE restaurant_id = ? AND effective_from_month <= ?
       ORDER BY effective_from_month DESC, revision_no DESC
       LIMIT 1`,
      [restaurantId, monthStart]
    );
    const threshold = policyRows[0] ? Number(policyRows[0].warning_threshold) : 3;

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

    const employeeWarningCounts: Record<string, { total: number; counted: number; limitReached: boolean }> = {};
    for (const r of rows) {
      const key = String(r.employee_id);
      const entry = (employeeWarningCounts[key] ??= { total: 0, counted: 0, limitReached: false });
      entry.total += 1;
      if (r.system_qualifies && !r.admin_voided && r.counts_toward_limit) entry.counted += 1;
      entry.limitReached = entry.counted >= threshold;
    }

    const warnings = rows.map((r) => ({
        id: String(r.id),
        employeeId: String(r.employee_id),
        fullName: r.employee_name,
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
      }));

    res.json({
      data: { threshold, warnings, employeeWarningCounts },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /warnings, /warnings/custom or /warnings/employees/:employeeId
const handleCreateWarning = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const rawEmployeeId = req.params.employeeId ?? req.body?.employeeId;
    if (rawEmployeeId === undefined || rawEmployeeId === null || String(rawEmployeeId).trim() === '') {
      throw new AppError(400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required');
    }
    const employeeId = String(rawEmployeeId);
    const actorId = req.tenantContext!.actorId;
    const body = createCustomWarningSchema.parse(req.body ?? {});

    const monthStart = `${body.incidentDate.slice(0, 7)}-01`;

    let newWarningId: number = 0;
    await withTransaction(async (conn) => {
      // Check employee
      const [empRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM employees WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, employeeId]
      );
      if (!empRows[0]) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

      // Lock the payroll period and make sure it is not finalized
      await lockOpenPeriod(conn, restaurantId, monthStart, 'Cannot add warning to a finalized period', true);

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

      await bumpSourceRevision(conn, restaurantId, monthStart);

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
warningRouter.post('/custom', handleCreateWarning);
warningRouter.post('/', handleCreateWarning);

// POST /api/v1/restaurants/:restaurantId/warnings/:warningId/void
warningRouter.post('/:warningId/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const warningId = String(req.params.warningId);
    const actorId = req.tenantContext!.actorId;
    const body = voidWarningSchema.parse(req.body ?? {});

    await withTransaction(async (conn) => {
      const [wRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, DATE_FORMAT(incident_date, '%Y-%m-01') AS month_start, admin_voided, row_version
         FROM warnings WHERE restaurant_id = ? AND id = ? FOR UPDATE`,
        [restaurantId, warningId]
      );
      const w = wRows[0];
      if (!w) throw new AppError(404, 'WARNING_NOT_FOUND', 'Warning not found');
      if (w.admin_voided) throw new AppError(400, 'ALREADY_VOIDED', 'Warning is already voided');
      if (Number(w.row_version) !== body.expectedVersion) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Warning was modified by another administrator');
      }

      const monthStart = String(w.month_start);
      await lockOpenPeriod(conn, restaurantId, monthStart, 'Cannot void warning in a finalized month');

      const [upd] = await conn.execute<ResultSetHeader>(
        `UPDATE warnings
         SET admin_voided = 1,
             void_reason = ?,
             voided_by = ?,
             voided_at = NOW(3),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [body.voidReason, actorId, actorId, restaurantId, warningId, body.expectedVersion]
      );
      if (upd.affectedRows !== 1) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Warning was modified by another administrator');
      }

      await bumpSourceRevision(conn, restaurantId, monthStart);

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
