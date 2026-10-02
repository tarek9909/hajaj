import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { createDebtWaiverSchema, voidDebtWaiverSchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const debtRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/debt?month=YYYY-MM
debtRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    // 1. Fetch debt sources with waiver status and shortfall minutes
    const [sources] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        s.id,
        s.employee_id,
        e.full_name AS employee_name,
        e.employee_number,
        s.source_type,
        s.attendance_day_id,
        DATE_FORMAT(s.origin_work_date, '%Y-%m-%d') AS origin_work_date,
        s.imported_minutes,
        s.reason,
        s.created_at,
        w.id AS waiver_id,
        COALESCE(w.minutes, 0) AS waived_minutes,
        CASE WHEN w.id IS NOT NULL AND w.status = 'ACTIVE' THEN 1 ELSE 0 END AS has_active_waiver,
        COALESCE(s.imported_minutes, d.shortfall_minutes, 90) AS shortfall_minutes
       FROM hour_debt_sources s
       JOIN employees e ON e.id = s.employee_id
       LEFT JOIN debt_waivers w ON w.debt_source_id = s.id AND w.status = 'ACTIVE'
       LEFT JOIN payroll_daily_results d ON d.attendance_day_id = s.attendance_day_id
       WHERE s.restaurant_id = ?
       ORDER BY s.origin_work_date ASC, s.id ASC`,
      [restaurantId]
    );

    // 2. Fetch debt waivers for this month
    const [waivers] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        w.id,
        w.employee_id,
        e.full_name AS employee_name,
        w.debt_source_id,
        DATE_FORMAT(w.effective_month, '%Y-%m-01') AS effective_month,
        w.minutes,
        w.reason,
        w.status,
        w.void_reason,
        w.row_version,
        w.created_at,
        ca.full_name AS created_by_name,
        va.full_name AS voided_by_name
       FROM debt_waivers w
       JOIN employees e ON e.id = w.employee_id
       LEFT JOIN admin_accounts ca ON ca.id = w.created_by
       LEFT JOIN admin_accounts va ON va.id = w.voided_by
       WHERE w.restaurant_id = ? AND w.effective_month = ?
       ORDER BY w.created_at DESC`,
      [restaurantId, monthStart]
    );

    const mappedSources = sources.map((s) => ({
      id: String(s.id),
      employeeId: String(s.employee_id),
      employeeName: s.employee_name,
      fullName: s.employee_name,
      employeeNumber: s.employee_number,
      sourceType: s.source_type,
      attendanceDayId: s.attendance_day_id ? String(s.attendance_day_id) : null,
      originWorkDate: s.origin_work_date,
      importedMinutes: s.imported_minutes ? Number(s.imported_minutes) : null,
      shortfallMinutes: Number(s.shortfall_minutes || s.imported_minutes || 0),
      waivedMinutes: Number(s.waived_minutes || 0),
      hasActiveWaiver: Boolean(s.has_active_waiver),
      waiverId: s.waiver_id ? String(s.waiver_id) : null,
      reason: s.reason,
      createdAt: s.created_at,
    }));

    const mappedWaivers = waivers.map((w) => ({
      id: String(w.id),
      employeeId: String(w.employee_id),
      employeeName: w.employee_name,
      fullName: w.employee_name,
      debtSourceId: String(w.debt_source_id),
      effectiveMonth: w.effective_month,
      minutes: Number(w.minutes),
      reason: w.reason,
      status: w.status,
      voidReason: w.void_reason,
      createdByName: w.created_by_name,
      voidedByName: w.voided_by_name,
      rowVersion: Number(w.row_version),
      createdAt: w.created_at,
    }));

    res.json({
      data: {
        sources: mappedSources,
        debtSources: mappedSources,
        waivers: mappedWaivers,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/employees/:employeeId/debt-waivers
debtRouter.post('/employees/:employeeId/debt-waivers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);
    const actorId = req.tenantContext!.actorId;
    const body = createDebtWaiverSchema.parse(req.body);

    await withTransaction(async (conn) => {
      // 1. Verify debt source exists and belongs to employee
      const [sourceRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, source_type, imported_minutes, attendance_day_id 
         FROM hour_debt_sources 
         WHERE restaurant_id = ? AND employee_id = ? AND id = ?`,
        [restaurantId, employeeId, body.debtSourceId]
      );
      const source = sourceRows[0];
      if (!source) throw new AppError(404, 'DEBT_SOURCE_NOT_FOUND', 'Debt source not found for this employee');

      // 2. Check payroll period not finalized
      const [perRows] = await conn.execute<RowDataPacket[]>(
        `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, body.effectiveMonth]
      );
      if (perRows[0]?.status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot apply debt waiver to a finalized month');
      }

      // 3. Insert waiver
      const [resHeader] = await conn.execute<ResultSetHeader>(
        `INSERT INTO debt_waivers 
          (restaurant_id, employee_id, debt_source_id, effective_month, minutes, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          restaurantId,
          employeeId,
          body.debtSourceId,
          body.effectiveMonth,
          body.minutes,
          body.reason,
          actorId,
        ]
      );

      // 4. Increment source_revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, body.effectiveMonth]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_DEBT_WAIVER',
          entityType: 'DEBT_WAIVER',
          entityId: String(resHeader.insertId),
          requestId: req.requestId,
          afterValues: body,
        },
        conn
      );
    });

    res.status(201).json({
      data: { message: 'Debt waiver created successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/debt-waivers/:waiverId/void
debtRouter.post('/debt-waivers/:waiverId/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const waiverId = String(req.params.waiverId);
    const actorId = req.tenantContext!.actorId;
    const body = voidDebtWaiverSchema.parse(req.body);

    await withTransaction(async (conn) => {
      const [wRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, effective_month, status, row_version FROM debt_waivers WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, waiverId]
      );
      const w = wRows[0];
      if (!w) throw new AppError(404, 'WAIVER_NOT_FOUND', 'Debt waiver not found');
      if (w.status === 'VOID') throw new AppError(400, 'ALREADY_VOIDED', 'Debt waiver is already voided');
      if (Number(w.row_version) !== body.expectedVersion) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      const [perRows] = await conn.execute<RowDataPacket[]>(
        `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, w.effective_month]
      );
      if (perRows[0]?.status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot void waiver in a finalized month');
      }

      await conn.execute(
        `UPDATE debt_waivers 
         SET status = 'VOID',
             void_reason = ?,
             voided_by = ?,
             voided_at = NOW(3),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ?`,
        [body.voidReason, actorId, actorId, restaurantId, waiverId]
      );

      // Increment source_revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, w.effective_month]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'VOID_DEBT_WAIVER',
          entityType: 'DEBT_WAIVER',
          entityId: waiverId,
          requestId: req.requestId,
          reason: body.voidReason,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Debt waiver voided successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
