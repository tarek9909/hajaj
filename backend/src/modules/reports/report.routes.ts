import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import ExcelJS from 'exceljs';
import { pool } from '../../infrastructure/database/pool.js';
import { AppError } from '../../middleware/errorHandler.js';

export const reportRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/reports/monthly?month=YYYY-MM
reportRouter.get('/monthly', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    // 1. Get period and active/current calculation run
    const [periodRows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        p.id,
        p.status AS period_status,
        p.source_revision,
        p.current_calculation_run_id,
        p.active_finalized_run_id,
        p.finalized_at,
        r.completed_at AS calculated_at,
        r.input_revision,
        CASE WHEN r.input_revision <> p.source_revision OR r.id IS NULL THEN 1 ELSE 0 END AS is_stale,
        CASE WHEN p.status = 'FINALIZED' THEN 0 ELSE 1 END AS is_provisional
       FROM payroll_periods p
       LEFT JOIN calculation_runs r ON r.id = COALESCE(p.active_finalized_run_id, p.current_calculation_run_id)
       WHERE p.restaurant_id = ? AND p.month_start = ?`,
      [restaurantId, monthStart]
    );

    const period = periodRows[0];
    const runId = period?.active_finalized_run_id || period?.current_calculation_run_id;

    if (!runId) {
      res.json({
        data: {
          periodStatus: period?.period_status || 'DRAFT',
          isCalculated: false,
          overview: null,
          employees: [],
        },
        meta: { requestId: req.requestId },
      });
      return;
    }

    // 2. Fetch employee results for this calculation run
    const [empRows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM payroll_employee_results 
       WHERE restaurant_id = ? AND calculation_run_id = ?
       ORDER BY full_name_snapshot ASC`,
      [restaurantId, runId]
    );

    if (req.query.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Restaurant Workforce Management Platform';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet(`Payroll ${month}`);
      sheet.columns = [
        { header: 'Ref #', key: 'ref', width: 12 },
        { header: 'Full Name', key: 'name', width: 25 },
        { header: 'Position', key: 'pos', width: 18 },
        { header: 'Base Salary', key: 'base', width: 14 },
        { header: 'Req Hours', key: 'req_hours', width: 12 },
        { header: 'Worked Hours', key: 'worked_hours', width: 14 },
        { header: 'Opening Debt (min)', key: 'open_debt', width: 18 },
        { header: 'New Shortfall (min)', key: 'shortfall', width: 18 },
        { header: 'Recovered (min)', key: 'recovered', width: 16 },
        { header: 'Closing Debt (min)', key: 'close_debt', width: 18 },
        { header: 'Overtime (min)', key: 'ot_min', width: 16 },
        { header: 'Overtime Pay', key: 'ot_pay', width: 14 },
        { header: 'Late Incidents', key: 'late_inc', width: 14 },
        { header: 'Late Deductions', key: 'late_ded', width: 16 },
        { header: 'Other Deductions', key: 'other_ded', width: 16 },
        { header: 'Net Salary', key: 'net', width: 16 },
        { header: 'Warnings', key: 'warn', width: 12 },
      ];

      for (const er of empRows) {
        sheet.addRow({
          ref: er.employee_number_snapshot,
          name: er.full_name_snapshot,
          pos: er.position_name_snapshot,
          base: Number(er.base_salary_due).toFixed(2),
          req_hours: (Number(er.required_minutes) / 60).toFixed(1),
          worked_hours: (Number(er.worked_minutes) / 60).toFixed(1),
          open_debt: er.opening_debt_minutes,
          shortfall: er.new_shortfall_minutes,
          recovered: er.recovered_minutes,
          close_debt: er.closing_debt_minutes,
          ot_min: er.eligible_overtime_minutes,
          ot_pay: Number(er.overtime_amount).toFixed(2),
          late_inc: er.late_incident_count,
          late_ded: Number(er.late_deduction_amount).toFixed(2),
          other_ded: Number(er.other_deduction_amount).toFixed(2),
          net: Number(er.net_salary).toFixed(2),
          warn: `${er.counted_warning_count}/${er.warning_threshold}`,
        });
      }

      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFEFEFEF' },
      };

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Payroll_Summary_${month}.xlsx"`);
      res.send(Buffer.from(buffer));
      return;
    }

    // Compute overview totals
    const overview = {
      employeeCount: empRows.length,
      scheduledDays: empRows.reduce((a, b) => a + Number(b.scheduled_days), 0),
      attendedDays: empRows.reduce((a, b) => a + Number(b.attended_days), 0),
      absentDays: empRows.reduce((a, b) => a + Number(b.absent_days), 0),
      incompleteDays: empRows.reduce((a, b) => a + Number(b.incomplete_days), 0),
      requiredMinutes: empRows.reduce((a, b) => a + Number(b.required_minutes), 0),
      workedMinutes: empRows.reduce((a, b) => a + Number(b.worked_minutes), 0),
      additionalMinutes: empRows.reduce((a, b) => a + Number(b.additional_minutes), 0),
      openingDebtMinutes: empRows.reduce((a, b) => a + Number(b.opening_debt_minutes), 0),
      newShortfallMinutes: empRows.reduce((a, b) => a + Number(b.new_shortfall_minutes), 0),
      recoveredMinutes: empRows.reduce((a, b) => a + Number(b.recovered_minutes), 0),
      waivedMinutes: empRows.reduce((a, b) => a + Number(b.waived_minutes), 0),
      closingDebtMinutes: empRows.reduce((a, b) => a + Number(b.closing_debt_minutes), 0),
      eligibleOvertimeMinutes: empRows.reduce((a, b) => a + Number(b.eligible_overtime_minutes), 0),
      overtimeAmount: empRows.reduce((a, b) => a + Number(b.overtime_amount || 0), 0),
      lateIncidentCount: empRows.reduce((a, b) => a + Number(b.late_incident_count), 0),
      lateMinutes: empRows.reduce((a, b) => a + Number(b.late_minutes), 0),
      lateDeductionsAmount: empRows.reduce((a, b) => a + Number(b.late_deduction_amount || 0), 0),
      baseSalaryDue: empRows.reduce((a, b) => a + Number(b.base_salary_due || 0), 0),
      netSalary: empRows.reduce((a, b) => a + Number(b.net_salary || 0), 0),
      employeesAtWarningLimit: empRows.filter((e) => Number(e.counted_warning_count) >= Number(e.warning_threshold)).length,
    };

    const employees = empRows.map((e) => {
      const blockers = typeof e.blockers === 'string' ? JSON.parse(e.blockers) : e.blockers;
      return {
        id: String(e.id),
        employeeId: String(e.employee_id),
        employeeNumber: e.employee_number_snapshot,
        fullName: e.full_name_snapshot,
        positionName: e.position_name_snapshot,
        currencyCode: e.currency_code,
        contractualMonthlySalary: Number(e.contractual_monthly_salary || 0),
        baseSalaryDue: Number(e.base_salary_due || 0),
        dailyRate: Number(e.daily_rate || 0),
        hourlyRate: Number(e.hourly_rate || 0),
        overtimeHourlyRate: Number(e.overtime_hourly_rate || 0),
        scheduledDays: Number(e.scheduled_days),
        attendedDays: Number(e.attended_days),
        absentDays: Number(e.absent_days),
        incompleteDays: Number(e.incomplete_days),
        requiredMinutes: Number(e.required_minutes),
        workedMinutes: Number(e.worked_minutes),
        openingDebtMinutes: Number(e.opening_debt_minutes),
        newShortfallMinutes: Number(e.new_shortfall_minutes),
        recoveredMinutes: Number(e.recovered_minutes),
        waivedMinutes: Number(e.waived_minutes),
        closingDebtMinutes: Number(e.closing_debt_minutes),
        additionalMinutes: Number(e.additional_minutes),
        eligibleOvertimeMinutes: Number(e.eligible_overtime_minutes),
        overtimeAmount: Number(e.overtime_amount || 0),
        lateIncidentCount: Number(e.late_incident_count),
        lateMinutes: Number(e.late_minutes),
        lateDeductionAmount: Number(e.late_deduction_amount || 0),
        additionAmount: Number(e.addition_amount || 0),
        otherDeductionAmount: Number(e.other_deduction_amount || 0),
        netSalary: Number(e.net_salary || 0),
        validWarningCount: Number(e.valid_warning_count),
        countedWarningCount: Number(e.counted_warning_count),
        warningThreshold: Number(e.warning_threshold),
        warningLimitReached: Number(e.counted_warning_count) >= Number(e.warning_threshold),
        blockers,
      };
    });

    res.json({
      data: {
        periodStatus: period.period_status,
        isCalculated: true,
        isStale: Boolean(period.is_stale),
        isProvisional: Boolean(period.is_provisional),
        calculatedAt: period.calculated_at,
        finalizedAt: period.finalized_at,
        calculationRunId: String(runId),
        overview,
        employees,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/reports/employees/:employeeId?month=YYYY-MM
reportRouter.get('/employees/:employeeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const employeeId = req.params.employeeId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const [periodRows] = await pool.execute<RowDataPacket[]>(
      `SELECT current_calculation_run_id, active_finalized_run_id, status 
       FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
      [restaurantId, monthStart]
    );
    const period = periodRows[0];
    const runId = period?.active_finalized_run_id || period?.current_calculation_run_id;

    if (!runId) {
      throw new AppError(404, 'NOT_CALCULATED', 'No calculation available for this month');
    }

    // 1. Employee summary result
    const [empRows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM payroll_employee_results 
       WHERE restaurant_id = ? AND calculation_run_id = ? AND employee_id = ?`,
      [restaurantId, runId, employeeId]
    );
    const emp = empRows[0];
    if (!emp) throw new AppError(404, 'EMPLOYEE_RESULT_NOT_FOUND', 'Employee not found in this calculation run');

    // 2. Daily breakdown
    const [dailyRows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        id, schedule_day_id, attendance_day_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date,
        attendance_status, is_resolved, required_minutes, worked_minutes, regular_minutes,
        late_minutes, shortfall_minutes, additional_minutes, recovered_minutes, eligible_overtime_minutes,
        planned_intervals_snapshot, actual_intervals_snapshot
       FROM payroll_daily_results 
       WHERE restaurant_id = ? AND calculation_run_id = ? AND employee_id = ?
       ORDER BY work_date ASC`,
      [restaurantId, runId, employeeId]
    );

    // 3. Debt lot results
    const [debtLots] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        d.id, d.debt_source_id, s.source_type, DATE_FORMAT(s.origin_work_date, '%Y-%m-%d') AS origin_work_date,
        d.opening_minutes, d.new_minutes, d.waived_minutes, d.recovered_minutes, d.closing_minutes
       FROM debt_lot_results d
       JOIN hour_debt_sources s ON s.id = d.debt_source_id
       WHERE d.restaurant_id = ? AND d.calculation_run_id = ? AND d.employee_id = ?
       ORDER BY s.origin_work_date ASC`,
      [restaurantId, runId, employeeId]
    );

    // 4. Payroll lines
    const [lines] = await pool.execute<RowDataPacket[]>(
      `SELECT line_key, line_type, description, quantity, unit, rate_snapshot, signed_amount 
       FROM payroll_lines 
       WHERE restaurant_id = ? AND calculation_run_id = ? AND employee_id = ?
       ORDER BY id ASC`,
      [restaurantId, runId, employeeId]
    );

    res.json({
      data: {
        summary: {
          id: String(emp.id),
          employeeId: String(emp.employee_id),
          employeeNumber: emp.employee_number_snapshot,
          fullName: emp.full_name_snapshot,
          positionName: emp.position_name_snapshot,
          currencyCode: emp.currency_code,
          contractualMonthlySalary: Number(emp.contractual_monthly_salary || 0),
          baseSalaryDue: Number(emp.base_salary_due || 0),
          dailyRate: Number(emp.daily_rate || 0),
          hourlyRate: Number(emp.hourly_rate || 0),
          overtimeHourlyRate: Number(emp.overtime_hourly_rate || 0),
          scheduledDays: Number(emp.scheduled_days),
          attendedDays: Number(emp.attended_days),
          absentDays: Number(emp.absent_days),
          incompleteDays: Number(emp.incomplete_days),
          requiredMinutes: Number(emp.required_minutes),
          workedMinutes: Number(emp.worked_minutes),
          openingDebtMinutes: Number(emp.opening_debt_minutes),
          newShortfallMinutes: Number(emp.new_shortfall_minutes),
          recoveredMinutes: Number(emp.recovered_minutes),
          waivedMinutes: Number(emp.waived_minutes),
          closingDebtMinutes: Number(emp.closing_debt_minutes),
          additionalMinutes: Number(emp.additional_minutes),
          eligibleOvertimeMinutes: Number(emp.eligible_overtime_minutes),
          overtimeAmount: Number(emp.overtime_amount || 0),
          lateIncidentCount: Number(emp.late_incident_count),
          lateMinutes: Number(emp.late_minutes),
          lateDeductionAmount: Number(emp.late_deduction_amount || 0),
          additionAmount: Number(emp.addition_amount || 0),
          otherDeductionAmount: Number(emp.other_deduction_amount || 0),
          netSalary: Number(emp.net_salary || 0),
          validWarningCount: Number(emp.valid_warning_count),
          countedWarningCount: Number(emp.counted_warning_count),
          warningThreshold: Number(emp.warning_threshold),
          warningLimitReached: Number(emp.counted_warning_count) >= Number(emp.warning_threshold),
          blockers: typeof emp.blockers === 'string' ? JSON.parse(emp.blockers) : emp.blockers,
        },
        dailyResults: dailyRows.map((d) => ({
          id: String(d.id),
          workDate: d.work_date,
          attendanceStatus: d.attendance_status,
          isResolved: Boolean(d.is_resolved),
          requiredMinutes: Number(d.required_minutes),
          workedMinutes: d.worked_minutes !== null ? Number(d.worked_minutes) : null,
          regularMinutes: d.regular_minutes !== null ? Number(d.regular_minutes) : null,
          shortfallMinutes: d.shortfall_minutes !== null ? Number(d.shortfall_minutes) : null,
          additionalMinutes: d.additional_minutes !== null ? Number(d.additional_minutes) : null,
          recoveredMinutes: d.recovered_minutes !== null ? Number(d.recovered_minutes) : null,
          eligibleOvertimeMinutes: d.eligible_overtime_minutes !== null ? Number(d.eligible_overtime_minutes) : null,
          lateMinutes: Number(d.late_minutes || 0),
          plannedIntervals: typeof d.planned_intervals_snapshot === 'string' ? JSON.parse(d.planned_intervals_snapshot) : d.planned_intervals_snapshot,
          actualIntervals: typeof d.actual_intervals_snapshot === 'string' ? JSON.parse(d.actual_intervals_snapshot) : d.actual_intervals_snapshot,
        })),
        debtLots: debtLots.map((l) => ({
          id: String(l.id),
          debtSourceId: String(l.debt_source_id),
          sourceType: l.source_type,
          originWorkDate: l.origin_work_date,
          openingMinutes: Number(l.opening_minutes),
          newMinutes: Number(l.new_minutes),
          waivedMinutes: Number(l.waived_minutes),
          recoveredMinutes: Number(l.recovered_minutes),
          closingMinutes: Number(l.closing_minutes),
        })),
        payrollLines: lines.map((l) => ({
          lineKey: l.line_key,
          lineType: l.line_type,
          description: l.description,
          quantity: Number(l.quantity),
          unit: l.unit,
          rateSnapshot: Number(l.rate_snapshot),
          signedAmount: Number(l.signed_amount),
        })),
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/reports/debt?month=YYYY-MM
reportRouter.get('/debt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM v_current_debt_details WHERE restaurant_id = ? AND month_start = ?`,
      [restaurantId, monthStart]
    );

    res.json({
      data: rows.map((r) => ({
        employeeId: String(r.employee_id),
        fullName: r.full_name_snapshot,
        debtSourceId: String(r.debt_source_id),
        sourceType: r.source_type,
        originWorkDate: r.origin_work_date,
        openingMinutes: Number(r.opening_minutes),
        newMinutes: Number(r.new_minutes),
        waivedMinutes: Number(r.waived_minutes),
        recoveredMinutes: Number(r.recovered_minutes),
        closingMinutes: Number(r.closing_minutes),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/reports/warnings?month=YYYY-MM
reportRouter.get('/warnings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        v.*,
        e.full_name,
        e.employee_number,
        p.name AS position_name
       FROM v_warning_monthly_counts v
       JOIN employees e ON e.id = v.employee_id
       JOIN positions p ON p.id = e.position_id
       WHERE v.restaurant_id = ? AND v.month_start = ?`,
      [restaurantId, monthStart]
    );

    res.json({
      data: rows.map((r) => ({
        employeeId: String(r.employee_id),
        fullName: r.full_name,
        employeeNumber: r.employee_number,
        positionName: r.position_name,
        automaticWarningCount: Number(r.automatic_warning_count),
        customWarningCount: Number(r.custom_warning_count),
        validWarningCount: Number(r.valid_warning_count),
        countedWarningCount: Number(r.counted_warning_count),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/exports
reportRouter.post('/exports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    const [periodRows] = await pool.execute<RowDataPacket[]>(
      `SELECT current_calculation_run_id, active_finalized_run_id, status 
       FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
      [restaurantId, monthStart]
    );
    const period = periodRows[0];
    const runId = period?.active_finalized_run_id || period?.current_calculation_run_id;

    if (!runId) {
      throw new AppError(400, 'CALCULATION_REQUIRED', 'Please calculate payroll before generating exports');
    }

    // Generate Excel directly with ExcelJS
    const [empRows] = await pool.execute<RowDataPacket[]>(
      `SELECT * FROM payroll_employee_results 
       WHERE restaurant_id = ? AND calculation_run_id = ? 
       ORDER BY full_name_snapshot ASC`,
      [restaurantId, runId]
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Restaurant Workforce Management Platform';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(`Payroll ${month}`);
    sheet.columns = [
      { header: 'Ref #', key: 'ref', width: 12 },
      { header: 'Full Name', key: 'name', width: 25 },
      { header: 'Position', key: 'pos', width: 18 },
      { header: 'Base Salary', key: 'base', width: 14 },
      { header: 'Req Hours', key: 'req_hours', width: 12 },
      { header: 'Worked Hours', key: 'worked_hours', width: 14 },
      { header: 'Opening Debt (min)', key: 'open_debt', width: 18 },
      { header: 'New Shortfall (min)', key: 'shortfall', width: 18 },
      { header: 'Recovered (min)', key: 'recovered', width: 16 },
      { header: 'Closing Debt (min)', key: 'close_debt', width: 18 },
      { header: 'Overtime (min)', key: 'ot_min', width: 16 },
      { header: 'Overtime Pay', key: 'ot_pay', width: 14 },
      { header: 'Late Incidents', key: 'late_inc', width: 14 },
      { header: 'Late Deductions', key: 'late_ded', width: 16 },
      { header: 'Other Deductions', key: 'other_ded', width: 16 },
      { header: 'Net Salary', key: 'net', width: 16 },
      { header: 'Warnings', key: 'warn', width: 12 },
    ];

    for (const er of empRows) {
      sheet.addRow({
        ref: er.employee_number_snapshot,
        name: er.full_name_snapshot,
        pos: er.position_name_snapshot,
        base: Number(er.base_salary_due).toFixed(2),
        req_hours: (Number(er.required_minutes) / 60).toFixed(1),
        worked_hours: (Number(er.worked_minutes) / 60).toFixed(1),
        open_debt: er.opening_debt_minutes,
        shortfall: er.new_shortfall_minutes,
        recovered: er.recovered_minutes,
        close_debt: er.closing_debt_minutes,
        ot_min: er.eligible_overtime_minutes,
        ot_pay: Number(er.overtime_amount).toFixed(2),
        late_inc: er.late_incident_count,
        late_ded: Number(er.late_deduction_amount).toFixed(2),
        other_ded: Number(er.other_deduction_amount).toFixed(2),
        net: Number(er.net_salary).toFixed(2),
        warn: `${er.counted_warning_count}/${er.warning_threshold}`,
      });
    }

    // Format headers
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFEF' },
    };

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Payroll_Summary_${month}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});
