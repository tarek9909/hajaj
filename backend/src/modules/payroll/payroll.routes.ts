import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { PayrollService } from './payrollService.js';
import { reopenPayrollPeriodSchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const payrollRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/payroll/periods
payrollRouter.get('/periods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        p.id,
        DATE_FORMAT(p.month_start, '%Y-%m-01') AS month_start,
        DATE_FORMAT(p.month_start, '%Y-%m') AS month,
        p.status,
        p.source_revision,
        p.current_calculation_run_id,
        p.active_finalized_run_id,
        p.finalized_at,
        r.completed_at AS calculated_at,
        r.input_revision,
        CASE WHEN r.input_revision <> p.source_revision OR r.id IS NULL THEN 1 ELSE 0 END AS is_stale,
        fa.full_name AS finalized_by_name
       FROM payroll_periods p
       LEFT JOIN calculation_runs r ON r.id = p.current_calculation_run_id
       LEFT JOIN admin_accounts fa ON fa.id = p.finalized_by
       WHERE p.restaurant_id = ?
       ORDER BY p.month_start DESC`,
      [restaurantId]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        monthStart: r.month_start,
        month: r.month,
        status: r.status,
        sourceRevision: Number(r.source_revision),
        currentCalculationRunId: r.current_calculation_run_id ? String(r.current_calculation_run_id) : null,
        activeFinalizedRunId: r.active_finalized_run_id ? String(r.active_finalized_run_id) : null,
        finalizedAt: r.finalized_at,
        calculatedAt: r.calculated_at,
        isStale: Boolean(r.is_stale),
        finalizedByName: r.finalized_by_name,
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/payroll/periods/:month
payrollRouter.get('/periods/:month', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = String(req.params.month);
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        p.id,
        DATE_FORMAT(p.month_start, '%Y-%m-01') AS month_start,
        DATE_FORMAT(p.month_start, '%Y-%m') AS month,
        p.status,
        p.source_revision,
        p.current_calculation_run_id,
        p.active_finalized_run_id,
        p.finalized_at,
        r.completed_at AS calculated_at,
        r.input_revision,
        CASE WHEN r.input_revision <> p.source_revision OR r.id IS NULL THEN 1 ELSE 0 END AS is_stale,
        fa.full_name AS finalized_by_name
       FROM payroll_periods p
       LEFT JOIN calculation_runs r ON r.id = p.current_calculation_run_id
       LEFT JOIN admin_accounts fa ON fa.id = p.finalized_by
       WHERE p.restaurant_id = ? AND p.month_start = ?`,
      [restaurantId, monthStart]
    );

    const period = rows[0];
    if (!period) {
      throw new AppError(404, 'PAYROLL_PERIOD_NOT_FOUND', `Payroll period ${month} not found`);
    }

    const runId = period.status === 'FINALIZED' && period.active_finalized_run_id
      ? period.active_finalized_run_id
      : period.current_calculation_run_id;

    let employeesList: any[] = [];
    if (runId) {
      const [empRows] = await pool.execute<RowDataPacket[]>(
        `SELECT 
          id,
          employee_id,
          employee_number_snapshot,
          full_name_snapshot,
          position_name_snapshot,
          contractual_monthly_salary,
          base_salary_due,
          overtime_amount,
          addition_amount,
          late_deduction_amount,
          other_deduction_amount,
          net_salary,
          scheduled_days,
          attended_days,
          absent_days,
          days_off,
          incomplete_days,
          required_minutes,
          resolved_required_minutes,
          worked_minutes,
          regular_minutes,
          opening_debt_minutes,
          new_shortfall_minutes,
          waived_minutes,
          recovered_minutes,
          closing_debt_minutes,
          additional_minutes,
          eligible_overtime_minutes,
          late_incident_count,
          late_minutes,
          automatic_warning_count,
          custom_warning_count,
          valid_warning_count,
          counted_warning_count,
          warning_threshold,
          blockers
         FROM payroll_employee_results
         WHERE calculation_run_id = ?
         ORDER BY employee_number_snapshot ASC`,
        [runId]
      );

      const [lineRows] = await pool.execute<RowDataPacket[]>(
        `SELECT 
          id,
          employee_id,
          line_type,
          line_key,
          description,
          quantity,
          unit,
          rate_snapshot AS rate,
          signed_amount
         FROM payroll_lines
         WHERE calculation_run_id = ?
         ORDER BY employee_id ASC, id ASC`,
        [runId]
      );

      const linesByEmp = new Map<string, any[]>();
      for (const line of lineRows) {
        const empId = String(line.employee_id);
        if (!linesByEmp.has(empId)) linesByEmp.set(empId, []);
        linesByEmp.get(empId)!.push({
          id: String(line.id),
          lineType: line.line_type,
          lineKey: line.line_key,
          description: line.description,
          quantity: line.quantity ? Number(line.quantity) : null,
          unit: line.unit,
          rate: line.rate ? Number(line.rate) : null,
          signedAmount: Number(line.signed_amount),
        });
      }

      employeesList = empRows.map((e) => {
        const empId = String(e.employee_id);
        const blockersList = typeof e.blockers === 'string' ? JSON.parse(e.blockers) : e.blockers || [];
        const counted = Number(e.counted_warning_count || 0);
        const threshold = Number(e.warning_threshold || 3);

        return {
          id: String(e.id),
          employeeId: empId,
          employeeNumber: e.employee_number_snapshot,
          employeeNumberSnapshot: e.employee_number_snapshot,
          fullName: e.full_name_snapshot,
          fullNameSnapshot: e.full_name_snapshot,
          positionName: e.position_name_snapshot,
          positionNameSnapshot: e.position_name_snapshot,
          contractualMonthlySalary: Number(e.contractual_monthly_salary),
          baseSalary: Number(e.base_salary_due),
          baseSalaryDue: Number(e.base_salary_due),
          overtimePay: Number(e.overtime_amount),
          overtimeAmount: Number(e.overtime_amount),
          additionAmount: Number(e.addition_amount),
          lateDeductions: Number(e.late_deduction_amount),
          lateDeductionAmount: Number(e.late_deduction_amount),
          otherDeductions: Number(e.other_deduction_amount),
          otherDeductionAmount: Number(e.other_deduction_amount),
          netSalary: Number(e.net_salary),
          scheduledDays: Number(e.scheduled_days),
          attendedDays: Number(e.attended_days),
          absentDays: Number(e.absent_days),
          daysOff: Number(e.days_off),
          incompleteDays: Number(e.incomplete_days),
          requiredMinutes: Number(e.required_minutes),
          resolvedRequiredMinutes: Number(e.resolved_required_minutes),
          workedMinutes: Number(e.worked_minutes),
          regularMinutes: Number(e.regular_minutes),
          openingDebtMinutes: Number(e.opening_debt_minutes),
          newShortfallMinutes: Number(e.new_shortfall_minutes),
          waivedMinutes: Number(e.waived_minutes),
          recoveredMinutes: Number(e.recovered_minutes),
          closingDebtMinutes: Number(e.closing_debt_minutes),
          additionalMinutes: Number(e.additional_minutes),
          eligibleOvertimeMinutes: Number(e.eligible_overtime_minutes),
          lateIncidentCount: Number(e.late_incident_count),
          lateMinutes: Number(e.late_minutes),
          activeWarningsCount: counted,
          countedWarningCount: counted,
          warningThreshold: threshold,
          warningLimitReached: counted >= threshold,
          blockers: blockersList,
          lines: linesByEmp.get(empId) || [],
        };
      });
    }

    const summary = {
      totalEmployees: employeesList.length,
      totalContractualSalary: employeesList.reduce((acc, cur) => acc + cur.contractualMonthlySalary, 0),
      totalBaseDue: employeesList.reduce((acc, cur) => acc + cur.baseSalaryDue, 0),
      totalOvertimePay: employeesList.reduce((acc, cur) => acc + cur.overtimeAmount, 0),
      totalAdditions: employeesList.reduce((acc, cur) => acc + cur.additionAmount, 0),
      totalLateDeductions: employeesList.reduce((acc, cur) => acc + cur.lateDeductionAmount, 0),
      totalOtherDeductions: employeesList.reduce((acc, cur) => acc + cur.otherDeductionAmount, 0),
      totalNetPayable: employeesList.reduce((acc, cur) => acc + cur.netSalary, 0),
      totalRecoveredDebtMinutes: employeesList.reduce((acc, cur) => acc + cur.recoveredMinutes, 0),
      totalRemainingDebtMinutes: employeesList.reduce((acc, cur) => acc + cur.closingDebtMinutes, 0),
      warningLimitCount: employeesList.filter((e) => e.warningLimitReached).length,
    };

    res.json({
      data: {
        period: {
          id: String(period.id),
          monthStart: period.month_start,
          month: period.month,
          status: period.status,
          sourceRevision: Number(period.source_revision),
          currentCalculationRunId: period.current_calculation_run_id ? String(period.current_calculation_run_id) : null,
          activeFinalizedRunId: period.active_finalized_run_id ? String(period.active_finalized_run_id) : null,
          finalizedAt: period.finalized_at,
          calculatedAt: period.calculated_at,
          isStale: Boolean(period.is_stale),
          finalizedByName: period.finalized_by_name,
        },
        summary,
        employees: employeesList,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/payroll/periods/:month/calculate
// and alias /recalculate
const handleCalculation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = String(req.params.month);
    const actorId = req.tenantContext!.actorId;

    const calculationRunId = await PayrollService.executeCalculationRun(restaurantId, month, actorId);

    res.json({
      data: {
        calculationRunId,
        message: 'Payroll calculated successfully.',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};

payrollRouter.post('/periods/:month/calculate', handleCalculation);
payrollRouter.post('/periods/:month/recalculate', handleCalculation);

// GET /api/v1/restaurants/:restaurantId/payroll/periods/:month/blockers
payrollRouter.get('/periods/:month/blockers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = String(req.params.month);
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        e.employee_id,
        e.full_name_snapshot,
        e.employee_number_snapshot,
        e.blockers
       FROM payroll_periods p
       JOIN payroll_employee_results e ON e.calculation_run_id = p.current_calculation_run_id
       WHERE p.restaurant_id = ? AND p.month_start = ?`,
      [restaurantId, monthStart]
    );

    const allBlockers: Array<{ employeeId: string; fullName: string; blockers: string[] }> = [];
    for (const r of rows) {
      const bList = typeof r.blockers === 'string' ? JSON.parse(r.blockers) : r.blockers;
      if (Array.isArray(bList) && bList.length > 0) {
        allBlockers.push({
          employeeId: String(r.employee_id),
          fullName: r.full_name_snapshot,
          blockers: bList,
        });
      }
    }

    res.json({
      data: {
        totalBlockersCount: allBlockers.reduce((acc, cur) => acc + cur.blockers.length, 0),
        affectedEmployees: allBlockers,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/payroll/periods/:month/finalize
payrollRouter.post('/periods/:month/finalize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = req.params.month;
    const monthStart = `${month}-01`;
    const actorId = req.tenantContext!.actorId;

    await withTransaction(async (conn) => {
      // 1. Lock period FOR UPDATE
      const [periodRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status, source_revision, current_calculation_run_id 
         FROM payroll_periods 
         WHERE restaurant_id = ? AND month_start = ? 
         FOR UPDATE`,
        [restaurantId, monthStart]
      );
      const period = periodRows[0];
      if (!period) throw new AppError(404, 'PAYROLL_PERIOD_NOT_FOUND', `Period ${month} not found`);
      if (period.status === 'FINALIZED') {
        throw new AppError(400, 'ALREADY_FINALIZED', 'This payroll period is already finalized');
      }
      if (!period.current_calculation_run_id) {
        throw new AppError(400, 'CALCULATION_REQUIRED', 'Please calculate this period before finalizing');
      }

      // 2. Check calculation freshness
      const [runRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, input_revision, status FROM calculation_runs WHERE id = ?`,
        [period.current_calculation_run_id]
      );
      const run = runRows[0];
      if (!run || run.status !== 'COMPLETE') {
        throw new AppError(400, 'CALCULATION_INCOMPLETE', 'Calculation run is not complete');
      }
      if (Number(run.input_revision) !== Number(period.source_revision)) {
        throw new AppError(409, 'CALCULATION_STALE', 'Calculations are stale. Please recalculate before finalization.');
      }

      // 3. Check for employee blockers
      const [empResults] = await conn.execute<RowDataPacket[]>(
        `SELECT blockers, incomplete_days FROM payroll_employee_results 
         WHERE calculation_run_id = ?`,
        [period.current_calculation_run_id]
      );
      for (const er of empResults) {
        if (Number(er.incomplete_days) > 0) {
          throw new AppError(409, 'UNRESOLVED_ATTENDANCE', 'All attendance records must be resolved before finalization');
        }
        const bList = typeof er.blockers === 'string' ? JSON.parse(er.blockers) : er.blockers;
        if (Array.isArray(bList) && bList.length > 0) {
          throw new AppError(409, 'CALCULATION_BLOCKERS', `Cannot finalize: ${bList.join(', ')}`);
        }
      }

      // 4. Check preceding period dependency (if exists, must be finalized)
      const [prevRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status FROM payroll_periods 
         WHERE restaurant_id = ? AND month_start = DATE_SUB(?, INTERVAL 1 MONTH)`,
        [restaurantId, monthStart]
      );
      if (prevRows[0] && prevRows[0].status !== 'FINALIZED') {
        throw new AppError(
          409,
          'PRECEDING_PERIOD_UNFINALIZED',
          'The preceding month must be finalized before this month can be finalized.'
        );
      }

      // 5. Finalize atomically
      await conn.execute(
        `UPDATE payroll_periods 
         SET status = 'FINALIZED',
             active_finalized_run_id = ?,
             finalized_by = ?,
             finalized_at = NOW(3),
             row_version = row_version + 1
         WHERE id = ?`,
        [period.current_calculation_run_id, actorId, period.id]
      );

      // Record event
      await conn.execute(
        `INSERT INTO payroll_period_events 
          (restaurant_id, payroll_period_id, calculation_run_id, event_type, actor_id, reason)
         VALUES (?, ?, ?, 'FINALIZED', ?, 'Monthly payroll finalization')`,
        [restaurantId, period.id, period.current_calculation_run_id, actorId]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'FINALIZE_PAYROLL',
          entityType: 'PAYROLL_PERIOD',
          entityId: String(period.id),
          requestId: req.requestId,
          afterValues: { month, calculationRunId: String(period.current_calculation_run_id) },
        },
        conn
      );
    });

    res.json({
      data: { message: `Payroll for ${month} finalized successfully.` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/payroll/periods/:month/reopen
payrollRouter.post('/periods/:month/reopen', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = req.params.month;
    const monthStart = `${month}-01`;
    const actorId = req.tenantContext!.actorId;
    const body = reopenPayrollPeriodSchema.parse(req.body);

    await withTransaction(async (conn) => {
      // 1. Lock period
      const [periodRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status, active_finalized_run_id, current_calculation_run_id 
         FROM payroll_periods 
         WHERE restaurant_id = ? AND month_start = ? 
         FOR UPDATE`,
        [restaurantId, monthStart]
      );
      const period = periodRows[0];
      if (!period) throw new AppError(404, 'PAYROLL_PERIOD_NOT_FOUND', `Period ${month} not found`);
      if (period.status !== 'FINALIZED') {
        throw new AppError(400, 'NOT_FINALIZED', 'Only finalized periods can be reopened');
      }

      // 2. Check if later finalized periods exist
      const [laterFinalized] = await conn.execute<RowDataPacket[]>(
        `SELECT DATE_FORMAT(month_start, '%Y-%m') AS month 
         FROM payroll_periods 
         WHERE restaurant_id = ? AND month_start > ? AND status = 'FINALIZED' 
         ORDER BY month_start DESC`,
        [restaurantId, monthStart]
      );
      if (laterFinalized.length > 0) {
        throw new AppError(
          409,
          'DEPENDENT_PERIODS_FINALIZED',
          `Cannot reopen ${month}. Later periods are finalized: ${laterFinalized.map((l) => l.month).join(', ')}. Please reopen later periods first in reverse chronological order.`
        );
      }

      // 3. Reopen period
      await conn.execute(
        `UPDATE payroll_periods 
         SET status = 'REOPENED',
             active_finalized_run_id = NULL,
             finalized_by = NULL,
             finalized_at = NULL,
             source_revision = source_revision + 1,
             row_version = row_version + 1
         WHERE id = ?`,
        [period.id]
      );

      // Record event
      await conn.execute(
        `INSERT INTO payroll_period_events 
          (restaurant_id, payroll_period_id, calculation_run_id, event_type, actor_id, reason)
         VALUES (?, ?, ?, 'REOPENED', ?, ?)`,
        [restaurantId, period.id, period.current_calculation_run_id, actorId, body.reason]
      );

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'REOPEN_PAYROLL',
          entityType: 'PAYROLL_PERIOD',
          entityId: String(period.id),
          requestId: req.requestId,
          reason: body.reason,
        },
        conn
      );
    });

    res.json({
      data: { message: `Payroll for ${month} reopened successfully.` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
