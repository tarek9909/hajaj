import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  createSalaryVersionSchema,
} from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';
import { z } from 'zod';
import { assertMonthNotFinalized, bumpSourceRevision, normalizeMonthStart } from '../configuration/periodGuards.js';

export const employeeRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/employees
employeeRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const status = req.query.status as string | undefined;
    const positionId = req.query.positionId as string | undefined;
    const search = req.query.search as string | undefined;

    let sql = `
      SELECT 
        e.id,
        e.employee_number,
        e.full_name,
        e.mobile,
        e.position_id,
        p.name AS position_name,
        e.status,
        DATE_FORMAT(e.employment_start_date, '%Y-%m-%d') AS employment_start_date,
        DATE_FORMAT(e.employment_end_date, '%Y-%m-%d') AS employment_end_date,
        e.row_version,
        (
          SELECT s.monthly_salary 
          FROM employee_salary_versions s 
          WHERE s.restaurant_id = e.restaurant_id AND s.employee_id = e.id 
            AND s.effective_from_month <= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          ORDER BY s.effective_from_month DESC, s.revision_no DESC 
          LIMIT 1
        ) AS current_monthly_salary,
        COALESCE(
          (
            SELECT SUM(w.counts_toward_limit) 
            FROM warnings w 
            WHERE w.restaurant_id = e.restaurant_id 
              AND w.employee_id = e.id 
              AND w.system_qualifies = 1 
              AND w.admin_voided = 0
              AND w.incident_date >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          ), 0
        ) AS current_month_warnings,
        COALESCE(
          (
            SELECT SUM(v.closing_minutes)
            FROM v_current_debt_details v
            WHERE v.restaurant_id = e.restaurant_id AND v.employee_id = e.id
              AND v.month_start = (
                SELECT MAX(v2.month_start) FROM v_current_debt_details v2
                WHERE v2.restaurant_id = e.restaurant_id AND v2.employee_id = e.id
              )
          ), 0
        ) AS total_debt_minutes
      FROM employees e
      JOIN positions p ON p.id = e.position_id
      WHERE e.restaurant_id = ?
    `;
    const params: any[] = [restaurantId];

    if (status && ['ACTIVE', 'INACTIVE'].includes(status)) {
      sql += ` AND e.status = ?`;
      params.push(status);
    }
    if (positionId) {
      sql += ` AND e.position_id = ?`;
      params.push(positionId);
    }
    if (search) {
      sql += ` AND (e.full_name LIKE ? OR e.employee_number LIKE ? OR e.mobile LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY e.status ASC, e.full_name ASC`;

    const [rows] = await pool.execute<RowDataPacket[]>(sql, params);

    // Fetch current policy warning threshold
    const [polRows] = await pool.execute<RowDataPacket[]>(
      `SELECT warning_threshold FROM restaurant_policy_versions 
       WHERE restaurant_id = ? AND effective_from_month <= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
       ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
      [restaurantId]
    );
    const warningThreshold = polRows[0] ? Number(polRows[0].warning_threshold) : 3;

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        employeeNumber: r.employee_number,
        fullName: r.full_name,
        mobile: r.mobile,
        positionId: String(r.position_id),
        positionName: r.position_name,
        status: r.status,
        employmentStartDate: r.employment_start_date,
        employmentEndDate: r.employment_end_date,
        monthlySalary: r.current_monthly_salary === null ? null : Number(r.current_monthly_salary),
        currentMonthlySalary: Number(r.current_monthly_salary || 0),
        currentMonthWarnings: Number(r.current_month_warnings || 0),
        warningThreshold,
        warningLimitReached: Number(r.current_month_warnings || 0) >= warningThreshold,
        totalDebtMinutes: Number(r.total_debt_minutes || 0),
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/employees
employeeRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createEmployeeSchema.parse(req.body);

    const result = await withTransaction(async (conn) => {
      // 1. Check unique employee_number in this restaurant
      const [dup] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM employees WHERE restaurant_id = ? AND employee_number = ?`,
        [restaurantId, body.employeeNumber]
      );
      if (dup.length > 0) {
        throw new AppError(409, 'DUPLICATE_EMPLOYEE_NUMBER', 'Employee reference number already in use');
      }

      // 2. Insert employee
      const [empRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO employees 
          (restaurant_id, employee_number, full_name, mobile, position_id, employment_start_date, employment_end_date, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          restaurantId,
          body.employeeNumber,
          body.fullName,
          body.mobile,
          body.positionId,
          body.employmentStartDate,
          body.employmentEndDate || null,
          actorId,
        ]
      );
      const employeeId = empRes.insertId;

      // 3. Insert initial salary version (effective from 1st of start date's month)
      const startMonth = `${body.employmentStartDate.slice(0, 7)}-01`;
      await conn.execute(
        `INSERT INTO employee_salary_versions 
          (restaurant_id, employee_id, effective_from_month, revision_no, monthly_salary, reason, created_by)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
        [restaurantId, employeeId, startMonth, body.monthlySalary, body.reason, actorId]
      );

      // 4. Audit
      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_EMPLOYEE',
          entityType: 'EMPLOYEE',
          entityId: String(employeeId),
          requestId: req.requestId,
          afterValues: { fullName: body.fullName, employeeNumber: body.employeeNumber },
        },
        conn
      );

      return employeeId;
    });

    res.status(201).json({
      data: { id: String(result), message: 'Employee created successfully with initial salary version' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/employees/:employeeId
employeeRouter.get('/:employeeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        e.id,
        e.employee_number,
        e.full_name,
        e.mobile,
        e.position_id,
        p.name AS position_name,
        e.status,
        DATE_FORMAT(e.employment_start_date, '%Y-%m-%d') AS employment_start_date,
        DATE_FORMAT(e.employment_end_date, '%Y-%m-%d') AS employment_end_date,
        e.row_version,
        e.created_at,
        (
          SELECT s.monthly_salary 
          FROM employee_salary_versions s 
          WHERE s.restaurant_id = e.restaurant_id AND s.employee_id = e.id 
            AND s.effective_from_month <= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          ORDER BY s.effective_from_month DESC, s.revision_no DESC 
          LIMIT 1
        ) AS current_monthly_salary,
        COALESCE(
          (
            SELECT SUM(w.counts_toward_limit) 
            FROM warnings w 
            WHERE w.restaurant_id = e.restaurant_id 
              AND w.employee_id = e.id 
              AND w.system_qualifies = 1 
              AND w.admin_voided = 0
              AND w.incident_date >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          ), 0
        ) AS current_month_warnings
      FROM employees e
      JOIN positions p ON p.id = e.position_id
      WHERE e.restaurant_id = ? AND e.id = ?`,
      [restaurantId, employeeId]
    );

    const emp = rows[0];
    if (!emp) {
      throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    }

    const [polRows] = await pool.execute<RowDataPacket[]>(
      `SELECT warning_threshold FROM restaurant_policy_versions 
       WHERE restaurant_id = ? AND effective_from_month <= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
       ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
      [restaurantId]
    );
    const warningThreshold = polRows[0] ? Number(polRows[0].warning_threshold) : 3;

    res.json({
      data: {
        id: String(emp.id),
        employeeNumber: emp.employee_number,
        fullName: emp.full_name,
        mobile: emp.mobile,
        positionId: String(emp.position_id),
        positionName: emp.position_name,
        status: emp.status,
        employmentStartDate: emp.employment_start_date,
        employmentEndDate: emp.employment_end_date,
        monthlySalary: emp.current_monthly_salary === null ? null : Number(emp.current_monthly_salary),
        currentMonthlySalary: Number(emp.current_monthly_salary || 0),
        currentMonthWarnings: Number(emp.current_month_warnings || 0),
        warningThreshold,
        warningLimitReached: Number(emp.current_month_warnings || 0) >= warningThreshold,
        rowVersion: Number(emp.row_version),
        createdAt: emp.created_at,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/restaurants/:restaurantId/employees/:employeeId
employeeRouter.patch('/:employeeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);
    const actorId = req.tenantContext!.actorId;
    const body = updateEmployeeSchema.parse(req.body);

    if (body.mobile !== undefined && body.mobile.trim() === '') {
      throw new AppError(422, 'INVALID_INPUT', 'mobile cannot be empty');
    }

    await withTransaction(async (conn) => {
      const [curRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, full_name, mobile, position_id, row_version,
                DATE_FORMAT(employment_start_date, '%Y-%m-%d') AS employment_start_date,
                DATE_FORMAT(employment_end_date, '%Y-%m-%d') AS employment_end_date
         FROM employees WHERE restaurant_id = ? AND id = ? FOR UPDATE`,
        [restaurantId, employeeId]
      );
      const cur = curRows[0];
      if (!cur) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      if (Number(cur.row_version) !== body.expectedVersion) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Employee record was modified by another administrator');
      }

      if (body.positionId !== undefined) {
        if (!/^\d+$/.test(body.positionId)) {
          throw new AppError(422, 'INVALID_POSITION', 'positionId is invalid');
        }
        const [posRows] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM positions WHERE restaurant_id = ? AND id = ?`,
          [restaurantId, body.positionId]
        );
        if (posRows.length === 0) {
          throw new AppError(422, 'INVALID_POSITION', 'Position does not exist in this restaurant');
        }
      }

      // employmentEndDate: undefined = unchanged, null = clear, string = set
      const endDateProvided = body.employmentEndDate !== undefined;
      const newEnd: string | null = endDateProvided ? (body.employmentEndDate as string | null) : cur.employment_end_date;
      if (newEnd && newEnd < cur.employment_start_date) {
        throw new AppError(422, 'INVALID_DATE_RANGE', 'employmentEndDate cannot be before employmentStartDate');
      }

      const sets: string[] = [];
      const params: any[] = [];
      if (body.fullName !== undefined) { sets.push('full_name = ?'); params.push(body.fullName); }
      if (body.mobile !== undefined) { sets.push('mobile = ?'); params.push(body.mobile.trim()); }
      if (body.positionId !== undefined) { sets.push('position_id = ?'); params.push(body.positionId); }
      if (endDateProvided) { sets.push('employment_end_date = ?'); params.push(body.employmentEndDate); }

      const [updateRes] = await conn.execute<ResultSetHeader>(
        `UPDATE employees
         SET ${sets.length ? sets.join(', ') + ',' : ''} row_version = row_version + 1, updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [...params, actorId, restaurantId, employeeId, body.expectedVersion]
      );
      if (updateRes.affectedRows === 0) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Employee record was modified by another administrator');
      }

      const positionChanged = body.positionId !== undefined && String(cur.position_id) !== body.positionId;
      const endChanged = endDateProvided && (cur.employment_end_date ?? null) !== (body.employmentEndDate ?? null);
      if (positionChanged || endChanged) {
        const startMonth = `${String(cur.employment_start_date).slice(0, 7)}-01`;
        await bumpSourceRevision(conn, restaurantId, startMonth);
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_EMPLOYEE',
          entityType: 'EMPLOYEE',
          entityId: employeeId,
          requestId: req.requestId,
          beforeValues: {
            fullName: cur.full_name,
            mobile: cur.mobile,
            positionId: String(cur.position_id),
            employmentEndDate: cur.employment_end_date,
          },
          afterValues: {
            fullName: body.fullName,
            mobile: body.mobile,
            positionId: body.positionId,
            employmentEndDate: endDateProvided ? body.employmentEndDate : undefined,
          },
        },
        conn
      );
    });

    res.json({
      data: { message: 'Employee updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/restaurants/:restaurantId/employees/:employeeId/status
employeeRouter.patch('/:employeeId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);
    const actorId = req.tenantContext!.actorId;
    const { status, expectedVersion } = req.body;

    if (!['ACTIVE', 'INACTIVE'].includes(status) || typeof expectedVersion !== 'number') {
      throw new AppError(422, 'INVALID_INPUT', 'Status must be ACTIVE or INACTIVE and expectedVersion is required');
    }

    await withTransaction(async (conn) => {
      const [updateRes] = await conn.execute<ResultSetHeader>(
        `UPDATE employees
         SET status = ?, row_version = row_version + 1, updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [status, actorId, restaurantId, employeeId, expectedVersion]
      );

      if (updateRes.affectedRows === 0) {
        const [exists] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM employees WHERE restaurant_id = ? AND id = ?`,
          [restaurantId, employeeId]
        );
        if (exists.length === 0) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Employee record was modified by another administrator');
      }

      const [startRows] = await conn.execute<RowDataPacket[]>(
        `SELECT DATE_FORMAT(employment_start_date, '%Y-%m-01') AS start_month FROM employees WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, employeeId]
      );
      await bumpSourceRevision(conn, restaurantId, startRows[0]!.start_month);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: status === 'ACTIVE' ? 'ACTIVATE_EMPLOYEE' : 'DEACTIVATE_EMPLOYEE',
          entityType: 'EMPLOYEE',
          entityId: employeeId,
          requestId: req.requestId,
          afterValues: { status },
        },
        conn
      );
    });

    res.json({
      data: { message: `Employee ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/employees/:employeeId/salary-history
employeeRouter.get('/:employeeId/salary-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        s.id,
        DATE_FORMAT(s.effective_from_month, '%Y-%m-01') AS effective_from_month,
        s.revision_no,
        s.monthly_salary,
        s.reason,
        s.created_at,
        a.full_name AS created_by_name
       FROM employee_salary_versions s
       JOIN admin_accounts a ON a.id = s.created_by
       WHERE s.restaurant_id = ? AND s.employee_id = ?
       ORDER BY s.effective_from_month DESC, s.revision_no DESC`,
      [restaurantId, employeeId]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        effectiveFromMonth: r.effective_from_month,
        revisionNo: r.revision_no,
        monthlySalary: Number(r.monthly_salary),
        reason: r.reason,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

const salaryVersionBodySchema = createSalaryVersionSchema.extend({
  effectiveFromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/, 'effectiveFromMonth must be YYYY-MM or YYYY-MM-01'),
});

// POST /api/v1/restaurants/:restaurantId/employees/:employeeId/salaries  (alias: /salary-versions)
const createSalaryVersion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = String(req.params.employeeId);
    const actorId = req.tenantContext!.actorId;
    const body = salaryVersionBodySchema.parse(req.body);
    const effectiveFromMonth = normalizeMonthStart(body.effectiveFromMonth, 'effectiveFromMonth');

    const result = await withTransaction(async (conn) => {
      // Lock the employee row to serialize revision numbering
      const [empRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM employees WHERE restaurant_id = ? AND id = ? FOR UPDATE`,
        [restaurantId, employeeId]
      );
      if (empRows.length === 0) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

      await assertMonthNotFinalized(conn, restaurantId, effectiveFromMonth);

      const [latest] = await conn.execute<RowDataPacket[]>(
        `SELECT revision_no FROM employee_salary_versions
         WHERE restaurant_id = ? AND employee_id = ? AND effective_from_month = ?
         ORDER BY revision_no DESC LIMIT 1`,
        [restaurantId, employeeId, effectiveFromMonth]
      );
      const nextRevision = latest[0] ? Number(latest[0].revision_no) + 1 : 1;

      const [insertRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO employee_salary_versions
          (restaurant_id, employee_id, effective_from_month, revision_no, monthly_salary, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [restaurantId, employeeId, effectiveFromMonth, nextRevision, body.monthlySalary, body.reason, actorId]
      );

      // Only non-finalized periods from the effective month onward are affected
      await bumpSourceRevision(conn, restaurantId, effectiveFromMonth);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_EMPLOYEE_SALARY',
          entityType: 'EMPLOYEE_SALARY',
          entityId: String(insertRes.insertId),
          requestId: req.requestId,
          afterValues: { ...body, effectiveFromMonth, employeeId },
        },
        conn
      );
      return { id: insertRes.insertId, revisionNo: nextRevision };
    });

    res.status(201).json({
      data: {
        id: String(result.id),
        revisionNo: result.revisionNo,
        message: 'New salary version created successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};
employeeRouter.post('/:employeeId/salaries', createSalaryVersion);
employeeRouter.post('/:employeeId/salary-versions', createSalaryVersion);
