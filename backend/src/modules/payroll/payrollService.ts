import crypto from 'crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { Decimal } from 'decimal.js';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { CalculationEngine } from '../../calculation-engine/engine.js';
import type {
  EmployeeMonthlyInput,
  DailyCalculationInput,
  DebtSourceInput,
  DebtWaiverInput,
  WarningInput,
  AdjustmentInput,
  PolicySnapshot,
} from '../../calculation-engine/types.js';
import { AppError } from '../../middleware/errorHandler.js';

export class PayrollService {
  /**
   * Performs an authoritative calculation run for a restaurant and month.
   */
  public static async executeCalculationRun(
    restaurantId: string,
    month: string, // YYYY-MM
    actorId?: string | null
  ): Promise<string> {
    const monthStart = `${month}-01`;

    return await withTransaction(async (conn) => {
      // 1. Ensure the payroll period exists, then lock it
      await conn.execute(
        `INSERT IGNORE INTO payroll_periods (restaurant_id, month_start, status, source_revision)
         VALUES (?, ?, 'DRAFT', 1)`,
        [restaurantId, monthStart]
      );
      const [periodRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, status, source_revision, current_calculation_run_id, active_finalized_run_id
         FROM payroll_periods
         WHERE restaurant_id = ? AND month_start = ?
         FOR UPDATE`,
        [restaurantId, monthStart]
      );
      const payrollPeriodId = Number(periodRows[0]!.id);
      const periodStatus = String(periodRows[0]!.status);
      const currentSourceRevision = Number(periodRows[0]!.source_revision);

      if (periodStatus === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot recalculate a finalized month without reopening');
      }

      // 2. Fetch Restaurant Currency & Decimal Places
      const [restRows] = await conn.execute<RowDataPacket[]>(
        `SELECT currency_code, currency_decimal_places, timezone FROM restaurants WHERE id = ?`,
        [restaurantId]
      );
      const restaurant = restRows[0]!;
      const currencyCode = restaurant.currency_code;
      const currencyDecimalPlaces = Number(restaurant.currency_decimal_places);

      // 3. Fetch Applicable Policy Version
      const [policyRows] = await conn.execute<RowDataPacket[]>(
        `SELECT * FROM restaurant_policy_versions 
         WHERE restaurant_id = ? AND effective_from_month <= ? 
         ORDER BY effective_from_month DESC, revision_no DESC 
         LIMIT 1`,
        [restaurantId, monthStart]
      );
      const policyRecord = policyRows[0];
      if (!policyRecord) {
        throw new AppError(400, 'NO_POLICY_CONFIGURED', 'No effective policy configured for this month');
      }

      const policySnapshot: PolicySnapshot = {
        salaryWorkingDayDivisor: Number(policyRecord.salary_working_day_divisor),
        standardDailyMinutes: Number(policyRecord.standard_daily_minutes),
        overtimeMultiplier: Number(policyRecord.overtime_multiplier),
        lateGraceMinutes: Number(policyRecord.late_grace_minutes),
        lateDeductionPercentage: Number(policyRecord.late_deduction_percentage),
        warningThreshold: Number(policyRecord.warning_threshold),
        customWarningsCountByDefault: Boolean(policyRecord.custom_warnings_count_by_default),
      };

      // 4. Fetch Previous Finalized Period (if any) to check preceding dependency
      const [prevPeriodRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, active_finalized_run_id FROM payroll_periods 
         WHERE restaurant_id = ? AND month_start = DATE_SUB(?, INTERVAL 1 MONTH)`,
        [restaurantId, monthStart]
      );
      const prevPeriod = prevPeriodRows[0];
      const previousFinalizedRunId = prevPeriod?.active_finalized_run_id ? Number(prevPeriod.active_finalized_run_id) : null;
      const previousPayrollPeriodId = previousFinalizedRunId ? Number(prevPeriod!.id) : null;
      const previousNotFinalized = Boolean(prevPeriod) && !previousFinalizedRunId;

      // 5. Gather All Included Employees
      // Include active employees + inactive employees who worked in this month
      const [employees] = await conn.execute<RowDataPacket[]>(
        `SELECT DISTINCT e.id, e.employee_number, e.full_name, p.name AS position_name,
                DATE_FORMAT(e.employment_start_date, '%Y-%m-%d') AS employment_start_date,
                DATE_FORMAT(e.employment_end_date, '%Y-%m-%d') AS employment_end_date
         FROM employees e
         JOIN positions p ON p.id = e.position_id
         LEFT JOIN schedule_days sd ON sd.employee_id = e.id AND sd.payroll_month = ?
         WHERE e.restaurant_id = ? AND (e.status = 'ACTIVE' OR sd.id IS NOT NULL)
           AND (e.employment_end_date IS NULL OR e.employment_end_date >= ?)
           AND e.employment_start_date < DATE_ADD(?, INTERVAL 1 MONTH)`,
        [monthStart, restaurantId, monthStart, monthStart]
      );

      // 6. Gather all schedule days and attendance for this month
      const [scheduleDays] = await conn.execute<RowDataPacket[]>(
        `SELECT d.id AS schedule_day_id, d.employee_id, DATE_FORMAT(d.work_date, '%Y-%m-%d') AS work_date,
                d.day_type, d.required_minutes, a.id AS attendance_day_id, a.status AS attendance_status,
                a.additional_work_approved
         FROM schedule_days d
         LEFT JOIN attendance_days a ON a.restaurant_id = d.restaurant_id AND a.schedule_day_id = d.id
         WHERE d.restaurant_id = ? AND d.payroll_month = ?
         ORDER BY d.work_date ASC`,
        [restaurantId, monthStart]
      );

      const [plannedIntervals] = await conn.execute<RowDataPacket[]>(
        `SELECT i.schedule_day_id, i.sequence_number, i.planned_start_at, i.planned_end_at, i.planned_unpaid_break_minutes 
         FROM schedule_intervals i
         JOIN schedule_days d ON d.id = i.schedule_day_id
         WHERE i.restaurant_id = ? AND d.payroll_month = ?
         ORDER BY i.schedule_day_id ASC, i.sequence_number ASC`,
        [restaurantId, monthStart]
      );

      const [actualIntervals] = await conn.execute<RowDataPacket[]>(
        `SELECT ai.attendance_day_id, ai.sequence_number, ai.check_in_at, ai.check_out_at, ai.unpaid_break_minutes 
         FROM attendance_intervals ai
         JOIN attendance_days a ON a.id = ai.attendance_day_id
         WHERE ai.restaurant_id = ? AND a.work_date >= ? AND a.work_date < DATE_ADD(?, INTERVAL 1 MONTH)
         ORDER BY ai.attendance_day_id ASC, ai.sequence_number ASC`,
        [restaurantId, monthStart, monthStart]
      );

      // 7. Gather Debt Sources, Waivers, Warnings, Adjustments, Salaries
      const [debtSources] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, source_type, attendance_day_id,
                DATE_FORMAT(origin_work_date, '%Y-%m-%d') AS origin_work_date,
                DATE_FORMAT(opening_month, '%Y-%m-%d') AS opening_month,
                imported_minutes
         FROM hour_debt_sources
         WHERE restaurant_id = ?`,
        [restaurantId]
      );
      const debtSourceById = new Map(debtSources.map((s) => [String(s.id), s]));

      // Debt carried in from earlier months is the closing balance of the previous finalized run
      const [previousLots] = previousFinalizedRunId
        ? await conn.execute<RowDataPacket[]>(
            `SELECT employee_id, debt_source_id, closing_minutes
             FROM debt_lot_results
             WHERE restaurant_id = ? AND calculation_run_id = ?`,
            [restaurantId, previousFinalizedRunId]
          )
        : [[] as RowDataPacket[]];

      const [waivers] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, debt_source_id, minutes, status 
         FROM debt_waivers 
         WHERE restaurant_id = ? AND effective_month = ? AND status = 'ACTIVE'`,
        [restaurantId, monthStart]
      );

      const [warnings] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, origin, automatic_attendance_day_id AS attendance_day_id, DATE_FORMAT(incident_date, '%Y-%m-%d') AS incident_date,
                title, reason, late_minutes, system_qualifies, counts_toward_limit, admin_voided 
         FROM warnings 
         WHERE restaurant_id = ? AND incident_date >= ? AND incident_date < DATE_ADD(?, INTERVAL 1 MONTH)`,
        [restaurantId, monthStart, monthStart]
      );

      const [adjustments] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, category, direction, calculation_method, adjustment_value, reason, status 
         FROM salary_adjustments 
         WHERE restaurant_id = ? AND payroll_month = ? AND status = 'ACTIVE'`,
        [restaurantId, monthStart]
      );

      const [salaries] = await conn.execute<RowDataPacket[]>(
        `SELECT id, employee_id, monthly_salary 
         FROM employee_salary_versions 
         WHERE restaurant_id = ? AND effective_from_month <= ? 
         ORDER BY effective_from_month DESC, revision_no DESC`,
        [restaurantId, monthStart]
      );

      // 8. Create calculation_runs record (BUILDING status)
      const inputSnapshot = {
        month: monthStart,
        restaurantId,
        sourceRevision: currentSourceRevision,
        employeeCount: employees.length,
      };
      const inputHash = crypto.createHash('sha256').update(JSON.stringify(inputSnapshot)).digest();

      const [runRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO calculation_runs 
          (restaurant_id, payroll_period_id, previous_payroll_period_id, previous_finalized_run_id, input_revision, engine_version, input_hash, input_snapshot, as_of_at, status, created_by)
         VALUES (?, ?, ?, ?, ?, '1.0.0', ?, ?, NOW(3), 'BUILDING', ?)`,
        [
          restaurantId,
          payrollPeriodId,
          previousPayrollPeriodId,
          previousFinalizedRunId,
          currentSourceRevision,
          inputHash,
          JSON.stringify(inputSnapshot),
          actorId || null,
        ]
      );
      const calculationRunId = runRes.insertId;

      // 9. Run CalculationEngine for each employee and persist results
      for (const emp of employees) {
        const empId = String(emp.id);

        // Find active salary version
        const empSalaryRecord = salaries.find((s) => String(s.employee_id) === empId);
        const contractualMonthlySalary = empSalaryRecord ? Number(empSalaryRecord.monthly_salary) : 0;

        // Build DailyCalculationInput
        const empDays = scheduleDays.filter((d) => String(d.employee_id) === empId);
        const dailyInputs: DailyCalculationInput[] = empDays.map((sd) => {
          const pl = plannedIntervals.filter((i) => String(i.schedule_day_id) === String(sd.schedule_day_id));
          const act = actualIntervals.filter((i) => String(i.attendance_day_id) === String(sd.attendance_day_id));
          const status: string | null = sd.attendance_status ?? null;
          // An excused attendance record removes the day's obligation
          const dayType: 'WORK' | 'OFF' | 'EXCUSED' =
            sd.day_type === 'WORK' && status === 'EXCUSED' ? 'EXCUSED' : sd.day_type;
          const isResolved =
            dayType !== 'WORK' || status === 'COMPLETED' || status === 'CONFIRMED_ABSENT';

          return {
            attendanceDayId: sd.attendance_day_id ? String(sd.attendance_day_id) : `synth-${sd.schedule_day_id}`,
            scheduleDayId: String(sd.schedule_day_id),
            workDate: sd.work_date,
            dayType,
            requiredMinutes: dayType === 'WORK' ? Number(sd.required_minutes) : 0,
            isResolved,
            additionalWorkApproved: Boolean(sd.additional_work_approved),
            attendanceStatus: (status ?? (dayType === 'WORK' ? 'NOT_RECORDED' : 'OFF')) as DailyCalculationInput['attendanceStatus'],
            plannedIntervals: pl.map((i) => {
              const startAt = new Date(i.planned_start_at);
              const endAt = new Date(i.planned_end_at);
              return {
                sequenceNumber: i.sequence_number,
                startLocalTime: startAt.toISOString().slice(11, 19),
                endLocalTime: endAt.toISOString().slice(11, 19),
                startAt: startAt.toISOString(),
              };
            }),
            actualIntervals: act.map((i) => ({
              sequenceNumber: i.sequence_number,
              checkInAt: i.check_in_at ? new Date(i.check_in_at).toISOString() : '',
              checkOutAt: i.check_out_at ? new Date(i.check_out_at).toISOString() : null,
              unpaidBreakMinutes: Number(i.unpaid_break_minutes || 0),
            })),
          };
        });

        // Build DebtSourceInput (previous debt sources)
        const empDebtSources: DebtSourceInput[] = [];
        const carriedIds = new Set<string>();
        for (const lot of previousLots.filter((l) => String(l.employee_id) === empId)) {
          const src = debtSourceById.get(String(lot.debt_source_id));
          carriedIds.add(String(lot.debt_source_id));
          const closing = Number(lot.closing_minutes);
          if (src && closing > 0) {
            empDebtSources.push({
              id: String(src.id),
              sourceType: src.source_type,
              attendanceDayId: src.attendance_day_id ? String(src.attendance_day_id) : null,
              originWorkDate: src.origin_work_date,
              minutes: closing,
              isOpening: true,
            });
          }
        }
        for (const src of debtSources) {
          if (
            String(src.employee_id) === empId &&
            src.source_type === 'OPENING_IMPORT' &&
            src.opening_month &&
            src.opening_month <= monthStart &&
            !carriedIds.has(String(src.id))
          ) {
            empDebtSources.push({
              id: String(src.id),
              sourceType: src.source_type,
              attendanceDayId: null,
              originWorkDate: src.origin_work_date,
              minutes: Number(src.imported_minutes || 0),
              isOpening: true,
            });
          }
        }

        // Build Waivers
        const empWaivers: DebtWaiverInput[] = waivers
          .filter((w) => String(w.employee_id) === empId)
          .map((w) => {
            // A waiver on this month's own shortfall targets the engine's per-day lot, not the stored source id
            const src = debtSourceById.get(String(w.debt_source_id));
            const originDay = src?.attendance_day_id
              ? dailyInputs.find((d) => d.attendanceDayId === String(src.attendance_day_id))
              : undefined;
            return {
            id: String(w.id),
            debtSourceId: originDay ? `shortfall-${originDay.scheduleDayId}` : String(w.debt_source_id),
            effectiveMonth: monthStart,
            minutes: Number(w.minutes),
            status: w.status,
            };
          });

        // Build Warnings
        const empWarnings: WarningInput[] = warnings
          .filter((w) => String(w.employee_id) === empId)
          .map((w) => ({
            id: String(w.id),
            origin: w.origin,
            attendanceDayId: w.attendance_day_id ? String(w.attendance_day_id) : null,
            incidentDate: w.incident_date,
            title: w.title,
            reason: w.reason,
            lateMinutes: w.late_minutes ? Number(w.late_minutes) : null,
            systemQualifies: Boolean(w.system_qualifies),
            countsTowardLimit: Boolean(w.counts_toward_limit),
            adminVoided: Boolean(w.admin_voided),
          }));

        // Build Adjustments
        const empAdjustments: AdjustmentInput[] = adjustments
          .filter((a) => String(a.employee_id) === empId)
          .map((a) => ({
            id: String(a.id),
            category: a.category,
            direction: a.direction,
            calculationMethod: a.calculation_method,
            adjustmentValue: Number(a.adjustment_value),
            reason: a.reason,
            status: a.status,
          }));

        const empInput: EmployeeMonthlyInput = {
          employeeId: empId,
          employeeNumber: emp.employee_number,
          fullName: emp.full_name,
          positionName: emp.position_name,
          contractualMonthlySalary,
          currencyCode,
          currencyDecimalPlaces,
          policy: policySnapshot,
          days: dailyInputs,
          existingDebtSources: empDebtSources,
          waivers: empWaivers,
          warnings: empWarnings,
          adjustments: empAdjustments,
        };

        const calc = CalculationEngine.calculateEmployeeMonth(empInput);
        if (!empSalaryRecord) calc.blockers.push('No salary on file for this employee');
        if (previousNotFinalized) calc.blockers.push('Previous month must be finalized before this month');

        // Insert into payroll_employee_results
        const [empResHeader] = await conn.execute<ResultSetHeader>(
          `INSERT INTO payroll_employee_results 
            (restaurant_id, calculation_run_id, employee_id, policy_version_id, salary_version_id,
             employee_number_snapshot, full_name_snapshot, position_name_snapshot,
             employee_snapshot, policy_snapshot, salary_snapshot,
             currency_code, currency_decimal_places, contractual_monthly_salary, daily_rate, hourly_rate, overtime_hourly_rate,
             scheduled_days, attended_days, absent_days, days_off, incomplete_days,
             required_minutes, resolved_required_minutes, worked_minutes, regular_minutes,
             opening_debt_minutes, new_shortfall_minutes, waived_minutes, recovered_minutes, closing_debt_minutes,
             additional_minutes, eligible_overtime_minutes,
             late_incident_count, late_minutes, automatic_warning_count, custom_warning_count, valid_warning_count, counted_warning_count,
             warning_threshold, base_salary_due, overtime_amount, addition_amount, late_deduction_amount, other_deduction_amount,
             net_salary, blockers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            restaurantId,
            calculationRunId,
            empId,
            policyRecord.id,
            empSalaryRecord?.id || null,
            emp.employee_number,
            emp.full_name,
            emp.position_name,
            JSON.stringify({ employeeNumber: emp.employee_number, fullName: emp.full_name, position: emp.position_name }),
            JSON.stringify(policySnapshot),
            JSON.stringify({ monthlySalary: contractualMonthlySalary, versionId: empSalaryRecord?.id || null }),
            currencyCode,
            currencyDecimalPlaces,
            calc.contractualMonthlySalary,
            calc.dailyRate,
            calc.hourlyRate,
            calc.overtimeHourlyRate,
            calc.scheduledDays,
            calc.attendedDays,
            calc.absentDays,
            calc.daysOff,
            calc.incompleteDays,
            calc.requiredMinutes,
            calc.resolvedRequiredMinutes,
            calc.workedMinutes,
            calc.regularMinutes,
            calc.openingDebtMinutes,
            calc.newShortfallMinutes,
            calc.waivedMinutes,
            calc.recoveredMinutes,
            calc.closingDebtMinutes,
            calc.additionalMinutes,
            calc.eligibleOvertimeMinutes,
            calc.lateIncidentCount,
            calc.lateMinutes,
            calc.automaticWarningCount,
            calc.customWarningCount,
            calc.validWarningCount,
            calc.countedWarningCount,
            calc.warningThreshold,
            calc.baseSalaryDue,
            calc.overtimeAmount,
            calc.additionAmount,
            calc.lateDeductionAmount,
            calc.otherDeductionAmount,
            calc.netSalary,
            JSON.stringify(calc.blockers),
          ]
        );
        const empResultId = empResHeader.insertId;

        // Insert into payroll_daily_results
        const dailyResultIdMap = new Map<string, number>();
        for (const day of calc.dailyResults) {
          const matchingInput = dailyInputs.find((d) => d.scheduleDayId === day.scheduleDayId);
          const [dRes] = await conn.execute<ResultSetHeader>(
            `INSERT INTO payroll_daily_results 
              (restaurant_id, calculation_run_id, employee_id, schedule_day_id, attendance_day_id, work_date,
               planned_intervals_snapshot, actual_intervals_snapshot, attendance_status, is_resolved,
               required_minutes, worked_minutes, regular_minutes, late_minutes, shortfall_minutes,
               additional_minutes, recovered_minutes, eligible_overtime_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              restaurantId,
              calculationRunId,
              empId,
              day.scheduleDayId,
              day.attendanceDayId.startsWith('synth-') ? null : day.attendanceDayId,
              day.workDate,
              JSON.stringify(matchingInput?.plannedIntervals || []),
              JSON.stringify(matchingInput?.actualIntervals || []),
              day.attendanceStatus,
              day.isResolved ? 1 : 0,
              day.requiredMinutes,
              day.workedMinutes,
              day.regularMinutes,
              day.lateMinutes,
              day.shortfallMinutes,
              day.additionalMinutes,
              day.recoveredMinutes,
              day.eligibleOvertimeMinutes,
            ]
          );
          dailyResultIdMap.set(day.workDate, dRes.insertId);
        }

        // Insert into debt_lot_results
        for (const lot of calc.debtLotResults) {
          let realDebtSourceId: string | null = null;
          if (lot.debtSourceId.startsWith('shortfall-')) {
            const scheduleDayId = lot.debtSourceId.slice('shortfall-'.length);
            const dayInput = dailyInputs.find((d) => d.scheduleDayId === scheduleDayId);
            const attDayId = dayInput && !dayInput.attendanceDayId.startsWith('synth-') ? dayInput.attendanceDayId : null;
            if (attDayId) {
              // Debt sources are immutable facts; create the one this shortfall needs if attendance did not
              await conn.execute(
                `INSERT IGNORE INTO hour_debt_sources
                  (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
                 VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
                [restaurantId, empId, attDayId, lot.originWorkDate]
              );
              const [srcRows] = await conn.execute<RowDataPacket[]>(
                `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
                [restaurantId, attDayId]
              );
              realDebtSourceId = srcRows[0] ? String(srcRows[0].id) : null;
            }
          } else {
            realDebtSourceId = lot.debtSourceId;
          }
          if (!realDebtSourceId) continue;

          await conn.execute(
            `INSERT INTO debt_lot_results
              (restaurant_id, calculation_run_id, employee_id, debt_source_id, source_snapshot,
               opening_minutes, new_minutes, waived_minutes, recovered_minutes, closing_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              restaurantId,
              calculationRunId,
              empId,
              realDebtSourceId,
              JSON.stringify({ originWorkDate: lot.originWorkDate, sourceType: lot.sourceType }),
              lot.openingMinutes,
              lot.newMinutes,
              lot.waivedMinutes,
              lot.recoveredMinutes,
              lot.closingMinutes,
            ]
          );
        }

        // Insert into payroll_lines
        // 1. Contractual Base Salary
        await conn.execute(
          `INSERT INTO payroll_lines 
            (restaurant_id, calculation_run_id, employee_id, line_key, line_type, salary_adjustment_id, late_penalty_id, payroll_daily_result_id, description, quantity, unit, rate_snapshot, signed_amount, source_snapshot)
           VALUES (?, ?, ?, 'BASE', 'BASE_SALARY', NULL, NULL, NULL, 'Monthly Contractual Base Salary', 1, 'MONTH', ?, ?, ?)`,
          [
            restaurantId,
            calculationRunId,
            empId,
            calc.contractualMonthlySalary,
            calc.contractualMonthlySalary,
            JSON.stringify({ contractualSalary: calc.contractualMonthlySalary }),
          ]
        );

        // 2. Daily overtime lines: per-day amounts are allocated so they sum exactly to the monthly overtime
        const otDays = calc.dailyResults.filter((d) => (d.eligibleOvertimeMinutes ?? 0) > 0);
        if (otDays.length > 0) {
          const amounts = otDays.map((d) =>
            new Decimal(d.eligibleOvertimeMinutes!).dividedBy(60).times(calc.overtimeHourlyRate).toDecimalPlaces(currencyDecimalPlaces)
          );
          const diff = new Decimal(calc.overtimeAmount).minus(amounts.reduce((a, b) => a.plus(b), new Decimal(0)));
          if (!diff.isZero()) {
            let largest = 0;
            amounts.forEach((a, i) => { if (a.greaterThan(amounts[largest]!)) largest = i; });
            amounts[largest] = amounts[largest]!.plus(diff);
          }
          for (let i = 0; i < otDays.length; i++) {
            const day = otDays[i]!;
            await conn.execute(
              `INSERT INTO payroll_lines
                (restaurant_id, calculation_run_id, employee_id, line_key, line_type, salary_adjustment_id, late_penalty_id, payroll_daily_result_id, description, quantity, unit, rate_snapshot, signed_amount, source_snapshot)
               VALUES (?, ?, ?, ?, 'OVERTIME', NULL, NULL, ?, ?, ?, 'HOUR', ?, ?, ?)`,
              [
                restaurantId,
                calculationRunId,
                empId,
                `OT_${day.workDate}`,
                dailyResultIdMap.get(day.workDate)!,
                `Eligible overtime (${day.eligibleOvertimeMinutes} mins) on ${day.workDate}`,
                new Decimal(day.eligibleOvertimeMinutes!).dividedBy(60).toNumber(),
                calc.overtimeHourlyRate,
                amounts[i]!.toNumber(),
                JSON.stringify({ workDate: day.workDate, minutes: day.eligibleOvertimeMinutes }),
              ]
            );
          }
        }

        // 3. Late penalty lines (one per qualifying day, amounts already rounded by the engine)
        if (empSalaryRecord) {
          for (const day of calc.dailyResults) {
            if (!day.qualifiesLateDeduction) continue;
            const inputDay = dailyInputs.find((di) => di.scheduleDayId === day.scheduleDayId);
            if (!inputDay || inputDay.attendanceDayId.startsWith('synth-')) continue;
            const attDayId = inputDay.attendanceDayId;

            await conn.execute(
              `INSERT INTO late_penalties
                (restaurant_id, employee_id, attendance_day_id, policy_version_id, salary_version_id, qualifies, late_minutes, daily_salary_basis, deduction_percentage, calculated_amount, source_attendance_version)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
               ON DUPLICATE KEY UPDATE
                policy_version_id = VALUES(policy_version_id),
                salary_version_id = VALUES(salary_version_id),
                qualifies = VALUES(qualifies),
                late_minutes = VALUES(late_minutes),
                daily_salary_basis = VALUES(daily_salary_basis),
                deduction_percentage = VALUES(deduction_percentage),
                calculated_amount = VALUES(calculated_amount)`,
              [
                restaurantId,
                empId,
                attDayId,
                policyRecord.id,
                empSalaryRecord.id,
                day.lateMinutes,
                calc.dailyRate,
                policySnapshot.lateDeductionPercentage,
                day.lateDeductionAmount,
              ]
            );
            const [penRows] = await conn.execute<RowDataPacket[]>(
              `SELECT id FROM late_penalties WHERE restaurant_id = ? AND attendance_day_id = ?`,
              [restaurantId, attDayId]
            );
            const penaltyId = penRows[0]?.id;
            if (!penaltyId) continue;

            await conn.execute(
              `INSERT INTO payroll_lines
                (restaurant_id, calculation_run_id, employee_id, line_key, line_type, salary_adjustment_id, late_penalty_id, payroll_daily_result_id, description, quantity, unit, rate_snapshot, signed_amount, source_snapshot)
               VALUES (?, ?, ?, ?, 'LATE_DEDUCTION', NULL, ?, NULL, ?, 1, 'DAY', ?, ?, ?)`,
              [
                restaurantId,
                calculationRunId,
                empId,
                `LATE_${day.workDate}`,
                penaltyId,
                `Late arrival penalty (${day.lateMinutes} mins) on ${day.workDate}`,
                day.lateDeductionAmount,
                -day.lateDeductionAmount,
                JSON.stringify({ workDate: day.workDate, lateMinutes: day.lateMinutes }),
              ]
            );
          }
        }

        // 4. Adjustment lines come straight from the engine so they always reconcile with the totals
        for (const line of calc.payrollLines.filter((l) => l.sourceRecordId)) {
          await conn.execute(
            `INSERT INTO payroll_lines
              (restaurant_id, calculation_run_id, employee_id, line_key, line_type, salary_adjustment_id, late_penalty_id, payroll_daily_result_id, description, quantity, unit, rate_snapshot, signed_amount, source_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, 'ITEM', ?, ?, ?)`,
            [
              restaurantId,
              calculationRunId,
              empId,
              line.lineKey,
              line.lineType,
              line.sourceRecordId!,
              line.description,
              line.rateSnapshot,
              line.signedAmount,
              JSON.stringify({ adjustmentId: line.sourceRecordId, reason: line.description }),
            ]
          );
        }
      }

      // 10. Close run: Update calculation_runs status to COMPLETE
      await conn.execute(
        `UPDATE calculation_runs SET status = 'COMPLETE', completed_at = NOW(3) WHERE id = ?`,
        [calculationRunId]
      );

      // 11. Point payroll_periods.current_calculation_run_id to this run
      await conn.execute(
        `UPDATE payroll_periods SET current_calculation_run_id = ? WHERE id = ?`,
        [calculationRunId, payrollPeriodId]
      );

      // Record event
      await conn.execute(
        `INSERT INTO payroll_period_events 
          (restaurant_id, payroll_period_id, calculation_run_id, event_type, actor_id, reason)
         VALUES (?, ?, ?, 'CALCULATED', ?, 'Periodic or triggered recalculation')`,
        [restaurantId, payrollPeriodId, calculationRunId, actorId || null]
      );

      return String(calculationRunId);
    });
  }
}
