import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { createDebtWaiverSchema, voidDebtWaiverSchema, monthQuerySchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';
import { lockOpenPeriod, bumpSourceRevision } from '../payroll/periodLock.js';

export const debtRouter = Router({ mergeParams: true });

/**
 * Debt sources with their shortfall and the waivers applied in a given month.
 *
 * Shortfall minutes are never invented:
 *  - OPENING_IMPORT: the imported minutes.
 *  - ATTENDANCE_SHORTFALL: the shortfall of the origin day from the period's current
 *    (or finalized) calculation run; if that day has not been calculated, it is derived
 *    from the attendance data (required minutes minus worked minutes of closed intervals).
 *
 * Bind order: [restaurantId (attendance subquery), restaurantId, monthStart (waiver subquery), ...extraParams]
 */
const DEBT_SOURCES_SQL = (extraWhere: string): string => `
  SELECT
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
    wm.waiver_id,
    COALESCE(wm.waived_minutes, 0) AS waived_minutes,
    CASE WHEN s.source_type = 'OPENING_IMPORT' THEN s.imported_minutes
         ELSE COALESCE(d.shortfall_minutes, GREATEST(COALESCE(sd.required_minutes, 0) - COALESCE(att.worked_minutes, 0), 0))
    END AS shortfall_minutes
  FROM hour_debt_sources s
  JOIN employees e ON e.restaurant_id = s.restaurant_id AND e.id = s.employee_id
  LEFT JOIN payroll_periods op
    ON op.restaurant_id = s.restaurant_id AND op.month_start = DATE_FORMAT(s.origin_work_date, '%Y-%m-01')
  LEFT JOIN payroll_daily_results d
    ON d.restaurant_id = s.restaurant_id
   AND d.calculation_run_id = COALESCE(op.active_finalized_run_id, op.current_calculation_run_id)
   AND d.employee_id = s.employee_id
   AND d.attendance_day_id = s.attendance_day_id
  LEFT JOIN attendance_days ad ON ad.restaurant_id = s.restaurant_id AND ad.id = s.attendance_day_id
  LEFT JOIN schedule_days sd ON sd.restaurant_id = ad.restaurant_id AND sd.id = ad.schedule_day_id
  LEFT JOIN (
    SELECT attendance_day_id,
           SUM(GREATEST(TIMESTAMPDIFF(MINUTE, check_in_at, check_out_at) - unpaid_break_minutes, 0)) AS worked_minutes
    FROM attendance_intervals
    WHERE restaurant_id = ? AND check_out_at IS NOT NULL
    GROUP BY attendance_day_id
  ) att ON att.attendance_day_id = s.attendance_day_id
  LEFT JOIN (
    SELECT debt_source_id, SUM(minutes) AS waived_minutes, MAX(id) AS waiver_id
    FROM debt_waivers
    WHERE restaurant_id = ? AND status = 'ACTIVE' AND effective_month = ?
    GROUP BY debt_source_id
  ) wm ON wm.debt_source_id = s.id
  WHERE s.restaurant_id = ? ${extraWhere}
  ORDER BY s.origin_work_date ASC, s.id ASC`;

// GET /api/v1/restaurants/:restaurantId/debt?month=YYYY-MM
debtRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = monthQuerySchema.parse(req.query.month || new Date().toISOString().slice(0, 7));
    const monthStart = `${month}-01`;

    // 1. Debt sources originating up to the end of the month, with waiver status for the month
    const [sources] = await pool.execute<RowDataPacket[]>(
      DEBT_SOURCES_SQL(`AND s.origin_work_date < DATE_ADD(?, INTERVAL 1 MONTH)`),
      [restaurantId, restaurantId, monthStart, restaurantId, monthStart]
    );

    // 2. Waivers effective in this month
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
      importedMinutes: s.imported_minutes !== null ? Number(s.imported_minutes) : null,
      shortfallMinutes: Number(s.shortfall_minutes || 0),
      waivedMinutes: Number(s.waived_minutes || 0),
      hasActiveWaiver: s.waiver_id !== null && s.waiver_id !== undefined,
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

// POST /debt/waivers, /debt/employees/:employeeId/debt-waivers
const handleCreateWaiver = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createDebtWaiverSchema.parse(req.body ?? {});
    const requestedEmployeeId = req.params.employeeId ?? body.employeeId ?? null;

    let newWaiverId = 0;
    await withTransaction(async (conn) => {
      // 1. Lock the debt source (serializes concurrent waivers) and verify ownership
      const [sourceRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, DATE_FORMAT(origin_work_date, '%Y-%m-01') AS origin_month
         FROM hour_debt_sources
         WHERE restaurant_id = ? AND id = ?
         FOR UPDATE`,
        [restaurantId, body.debtSourceId]
      );
      const source = sourceRows[0];
      if (!source || (requestedEmployeeId !== null && String(source.employee_id) !== String(requestedEmployeeId))) {
        throw new AppError(404, 'DEBT_SOURCE_NOT_FOUND', 'Debt source not found for this employee');
      }
      const employeeId = String(source.employee_id);

      if (body.effectiveMonth < String(source.origin_month)) {
        throw new AppError(422, 'INVALID_EFFECTIVE_MONTH', 'Waiver cannot take effect before the month the debt originated');
      }

      // 2. Ensure the period exists, lock it and reject if finalized
      await lockOpenPeriod(conn, restaurantId, body.effectiveMonth, 'Cannot apply debt waiver to a finalized month', true);

      // 3. Waived minutes cannot exceed the remaining debt of this source
      const [debtRows] = await conn.execute<RowDataPacket[]>(
        DEBT_SOURCES_SQL(`AND s.id = ?`),
        [restaurantId, restaurantId, body.effectiveMonth, restaurantId, body.debtSourceId]
      );
      const shortfall = Number(debtRows[0]?.shortfall_minutes || 0);
      const [waivedRows] = await conn.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(minutes), 0) AS total FROM debt_waivers
         WHERE restaurant_id = ? AND debt_source_id = ? AND status = 'ACTIVE'`,
        [restaurantId, body.debtSourceId]
      );
      const remaining = shortfall - Number(waivedRows[0]?.total || 0);
      if (body.minutes > remaining) {
        throw new AppError(
          422,
          'WAIVER_EXCEEDS_DEBT',
          `Waiver of ${body.minutes} minutes exceeds the remaining debt of ${Math.max(remaining, 0)} minutes for this source`
        );
      }

      // 4. Insert waiver
      const [resHeader] = await conn.execute<ResultSetHeader>(
        `INSERT INTO debt_waivers
          (restaurant_id, employee_id, debt_source_id, effective_month, minutes, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [restaurantId, employeeId, body.debtSourceId, body.effectiveMonth, body.minutes, body.reason, actorId]
      );
      newWaiverId = resHeader.insertId;

      // 5. Mark calculation inputs as changed
      await bumpSourceRevision(conn, restaurantId, body.effectiveMonth);

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
      data: { id: String(newWaiverId), message: 'Debt waiver created successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};

debtRouter.post('/waivers', handleCreateWaiver);
debtRouter.post('/employees/:employeeId/debt-waivers', handleCreateWaiver);

// POST /debt/waivers/:waiverId/void (alias: /debt/debt-waivers/:waiverId/void)
const handleVoidWaiver = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const waiverId = String(req.params.waiverId);
    const actorId = req.tenantContext!.actorId;
    const body = voidDebtWaiverSchema.parse(req.body ?? {});

    await withTransaction(async (conn) => {
      const [wRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, DATE_FORMAT(effective_month, '%Y-%m-01') AS effective_month, status, row_version
         FROM debt_waivers WHERE restaurant_id = ? AND id = ? FOR UPDATE`,
        [restaurantId, waiverId]
      );
      const w = wRows[0];
      if (!w) throw new AppError(404, 'WAIVER_NOT_FOUND', 'Debt waiver not found');
      if (w.status === 'VOID') throw new AppError(400, 'ALREADY_VOIDED', 'Debt waiver is already voided');
      if (Number(w.row_version) !== body.expectedVersion) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      await lockOpenPeriod(conn, restaurantId, w.effective_month, 'Cannot void waiver in a finalized month');

      const [upd] = await conn.execute<ResultSetHeader>(
        `UPDATE debt_waivers
         SET status = 'VOID',
             void_reason = ?,
             voided_by = ?,
             voided_at = NOW(3),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [body.voidReason, actorId, actorId, restaurantId, waiverId, body.expectedVersion]
      );
      if (upd.affectedRows !== 1) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      await bumpSourceRevision(conn, restaurantId, w.effective_month);

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
};

debtRouter.post('/waivers/:waiverId/void', handleVoidWaiver);
debtRouter.post('/debt-waivers/:waiverId/void', handleVoidWaiver);
