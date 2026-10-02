import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { createSalaryAdjustmentSchema, voidSalaryAdjustmentSchema, monthQuerySchema } from '../../contracts/schemas.js';
import { lockOpenPeriod, bumpSourceRevision } from '../payroll/periodLock.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const adjustmentRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/adjustments?month=YYYY-MM
adjustmentRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = monthQuerySchema.parse(req.query.month || new Date().toISOString().slice(0, 7));
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        a.id,
        a.employee_id,
        e.full_name AS employee_name,
        e.employee_number,
        DATE_FORMAT(a.payroll_month, '%Y-%m-01') AS payroll_month,
        DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
        a.category,
        a.direction,
        a.deduction_type_id,
        dt.name AS deduction_type_name,
        a.calculation_method,
        a.adjustment_value,
        a.reason,
        a.status,
        a.void_reason,
        a.voided_at,
        a.row_version,
        a.created_at,
        ca.full_name AS created_by_name,
        va.full_name AS voided_by_name
       FROM salary_adjustments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN deduction_types dt ON dt.id = a.deduction_type_id
       LEFT JOIN admin_accounts ca ON ca.id = a.created_by
       LEFT JOIN admin_accounts va ON va.id = a.voided_by
       WHERE a.restaurant_id = ? AND a.payroll_month = ?
       ORDER BY a.created_at DESC`,
      [restaurantId, monthStart]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        employeeId: String(r.employee_id),
        fullName: r.employee_name,
        employeeName: r.employee_name,
        employeeNumber: r.employee_number,
        payrollMonth: r.payroll_month,
        workDate: r.work_date,
        category: r.category,
        direction: r.direction,
        deductionTypeId: r.deduction_type_id ? String(r.deduction_type_id) : null,
        deductionTypeName: r.deduction_type_name,
        calculationMethod: r.calculation_method,
        adjustmentValue: Number(r.adjustment_value),
        reason: r.reason,
        status: r.status,
        voidReason: r.void_reason,
        createdByName: r.created_by_name,
        voidedByName: r.voided_by_name,
        rowVersion: Number(r.row_version),
        createdAt: r.created_at,
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/employees/:employeeId/adjustments or /adjustments
const handleCreateAdjustment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const rawEmployeeId = req.params.employeeId ?? req.body?.employeeId;
    if (rawEmployeeId === undefined || rawEmployeeId === null || String(rawEmployeeId).trim() === '') {
      throw new AppError(400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required');
    }
    const employeeId = String(rawEmployeeId);
    const actorId = req.tenantContext!.actorId;

    // Normalize payload
    const rawBody = { ...(req.body ?? {}) };
    if (!rawBody.payrollMonth && rawBody.effectiveMonth) {
      rawBody.payrollMonth = rawBody.effectiveMonth.length === 7 ? `${rawBody.effectiveMonth}-01` : rawBody.effectiveMonth;
    }
    if (rawBody.adjustmentType && !rawBody.category) {
      rawBody.category = rawBody.adjustmentType;
    }
    if (!rawBody.direction) {
      rawBody.direction = rawBody.category === 'ADDITION' ? 'INCREASE' : 'DECREASE';
    }
    if (!rawBody.calculationMethod) {
      rawBody.calculationMethod = 'FIXED';
    }
    if (rawBody.amount !== undefined && rawBody.adjustmentValue === undefined) {
      rawBody.adjustmentValue = rawBody.amount;
    }

    const body = createSalaryAdjustmentSchema.parse(rawBody);

    let newAdjustmentId: number = 0;
    await withTransaction(async (conn) => {
      // Check employee
      const [empRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM employees WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, employeeId]
      );
      if (!empRows[0]) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

      // Ensure the period exists, lock it and reject if finalized
      await lockOpenPeriod(conn, restaurantId, body.payrollMonth, 'Cannot add adjustments to a finalized month', true);

      const [resHeader] = await conn.execute<ResultSetHeader>(
        `INSERT INTO salary_adjustments 
          (restaurant_id, employee_id, payroll_month, work_date, category, direction, deduction_type_id, calculation_method, adjustment_value, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          restaurantId,
          employeeId,
          body.payrollMonth,
          body.workDate || null,
          body.category,
          body.direction,
          body.deductionTypeId || null,
          body.calculationMethod,
          body.adjustmentValue,
          body.reason,
          actorId,
        ]
      );
      newAdjustmentId = resHeader.insertId;

      await bumpSourceRevision(conn, restaurantId, body.payrollMonth);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_SALARY_ADJUSTMENT',
          entityType: 'SALARY_ADJUSTMENT',
          entityId: String(resHeader.insertId),
          requestId: req.requestId,
          afterValues: body,
        },
        conn
      );
    });

    res.status(201).json({
      data: { id: String(newAdjustmentId), message: 'Salary adjustment added successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};

adjustmentRouter.post('/employees/:employeeId', handleCreateAdjustment);
adjustmentRouter.post('/', handleCreateAdjustment);

// POST /api/v1/restaurants/:restaurantId/adjustments/:adjustmentId/void
adjustmentRouter.post('/:adjustmentId/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const adjustmentId = String(req.params.adjustmentId);
    const actorId = req.tenantContext!.actorId;
    const body = voidSalaryAdjustmentSchema.parse(req.body ?? {});

    await withTransaction(async (conn) => {
      const [adjRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, DATE_FORMAT(payroll_month, '%Y-%m-01') AS payroll_month, status, row_version
         FROM salary_adjustments WHERE restaurant_id = ? AND id = ? FOR UPDATE`,
        [restaurantId, adjustmentId]
      );
      const adj = adjRows[0];
      if (!adj) throw new AppError(404, 'ADJUSTMENT_NOT_FOUND', 'Adjustment not found');
      if (adj.status === 'VOID') throw new AppError(400, 'ALREADY_VOIDED', 'Adjustment is already voided');
      if (Number(adj.row_version) !== body.expectedVersion) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      await lockOpenPeriod(conn, restaurantId, adj.payroll_month, 'Cannot void adjustments in a finalized month');

      const [upd] = await conn.execute<ResultSetHeader>(
        `UPDATE salary_adjustments 
         SET status = 'VOID',
             void_reason = ?,
             voided_by = ?,
             voided_at = NOW(3),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [body.voidReason, actorId, actorId, restaurantId, adjustmentId, body.expectedVersion]
      );
      if (upd.affectedRows !== 1) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      await bumpSourceRevision(conn, restaurantId, adj.payroll_month);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'VOID_SALARY_ADJUSTMENT',
          entityType: 'SALARY_ADJUSTMENT',
          entityId: adjustmentId,
          requestId: req.requestId,
          reason: body.voidReason,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Salary adjustment voided successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
