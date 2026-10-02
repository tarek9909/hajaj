import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import type {
  DailyCalculationInput,
  DailyCalculationResult,
  DebtLotResult,
  DebtRecoveryAllocation,
  EmployeeCalculationResult,
  EmployeeMonthlyInput,
  PayrollLineItem,
} from './types.js';

// Configure Decimal precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export class CalculationEngine {
  /**
   * Evaluates a single workday's attendance and working time.
   */
  public static evaluateDailyWorkday(
    day: DailyCalculationInput,
    dailySalary: Decimal,
    lateGraceMinutes: number,
    lateDeductionPercentage: number,
    decimalPlaces = 4
  ): DailyCalculationResult {
    let workedMinutes: number | null = null;
    let regularMinutes: number | null = null;
    let shortfallMinutes: number | null = null;
    let additionalMinutes: number | null = null;
    let maxLateMinutes = 0;
    let qualifiesLateDeduction = false;

    // Check if the day is an OFF or EXCUSED day
    if (day.dayType === 'OFF' || day.dayType === 'EXCUSED') {
      if (day.isResolved) {
        workedMinutes = 0;
        regularMinutes = 0;
        shortfallMinutes = 0;
        additionalMinutes = 0;
      }
      return {
        scheduleDayId: day.scheduleDayId,
        attendanceDayId: day.attendanceDayId,
        workDate: day.workDate,
        dayType: day.dayType,
        attendanceStatus: day.attendanceStatus,
        isResolved: day.isResolved,
        requiredMinutes: day.requiredMinutes,
        workedMinutes,
        regularMinutes,
        shortfallMinutes,
        additionalMinutes,
        recoveredMinutes: null,
        eligibleOvertimeMinutes: null,
        lateMinutes: 0,
        qualifiesLateDeduction: false,
        lateDeductionAmount: 0,
      };
    }

    // Evaluate lateness across intervals
    for (let i = 0; i < day.actualIntervals.length; i++) {
      const act = day.actualIntervals[i]!;
      const planned = day.plannedIntervals.find((p) => p.sequenceNumber === act.sequenceNumber) ?? day.plannedIntervals[i];
      if (planned && act.checkInAt) {
        // Parse with setZone: true so the explicit offset/UTC in the ISO string is preserved
        const checkInDt = DateTime.fromISO(act.checkInAt, { setZone: true });
        if (planned.startAt) {
          // Absolute comparison: correct across midnight, DST and server timezone
          const plannedAbs = DateTime.fromISO(planned.startAt, { setZone: true });
          if (plannedAbs.isValid && checkInDt.isValid) {
            const diff = Math.floor(checkInDt.diff(plannedAbs, 'minutes').minutes);
            if (diff > maxLateMinutes) maxLateMinutes = diff;
          }
          continue;
        }
        const [planHour, planMin] = planned.startLocalTime.split(':').map(Number);
        if (planHour !== undefined && planMin !== undefined) {
          const plannedDt = checkInDt.set({ hour: planHour, minute: planMin, second: 0, millisecond: 0 });
          const diffMinutes = Math.floor(checkInDt.diff(plannedDt, 'minutes').minutes);
          if (diffMinutes > maxLateMinutes) {
            maxLateMinutes = diffMinutes;
          }
        }
      }
    }

    if (maxLateMinutes > lateGraceMinutes) {
      qualifiesLateDeduction = true;
    }

    // Evaluate worked time if resolved
    if (day.isResolved && day.attendanceStatus === 'COMPLETED') {
      let totalWorked = 0;
      for (const act of day.actualIntervals) {
        if (act.checkInAt && act.checkOutAt) {
          const inDt = DateTime.fromISO(act.checkInAt);
          const outDt = DateTime.fromISO(act.checkOutAt);
          const rawDuration = Math.floor(outDt.diff(inDt, 'minutes').minutes);
          const netDuration = Math.max(0, rawDuration - (act.unpaidBreakMinutes || 0));
          totalWorked += netDuration;
        }
      }
      if (day.additionalWorkApproved === false) totalWorked = Math.min(totalWorked, day.requiredMinutes);
      workedMinutes = totalWorked;
      regularMinutes = Math.min(workedMinutes, day.requiredMinutes);
      shortfallMinutes = Math.max(0, day.requiredMinutes - workedMinutes);
      additionalMinutes = Math.max(0, workedMinutes - day.requiredMinutes);
    } else if (day.isResolved && day.attendanceStatus === 'CONFIRMED_ABSENT') {
      workedMinutes = 0;
      regularMinutes = 0;
      shortfallMinutes = day.requiredMinutes;
      additionalMinutes = 0;
    }

    const lateDeductionAmount = qualifiesLateDeduction
      ? dailySalary.times(lateDeductionPercentage).dividedBy(100).toDecimalPlaces(decimalPlaces).toNumber()
      : 0;

    return {
      scheduleDayId: day.scheduleDayId,
      attendanceDayId: day.attendanceDayId,
      workDate: day.workDate,
      dayType: day.dayType,
      attendanceStatus: day.attendanceStatus,
      isResolved: day.isResolved,
      requiredMinutes: day.requiredMinutes,
      workedMinutes,
      regularMinutes,
      shortfallMinutes,
      additionalMinutes,
      recoveredMinutes: null, // to be populated during monthly reconciliation
      eligibleOvertimeMinutes: null, // to be populated during monthly reconciliation
      lateMinutes: maxLateMinutes,
      qualifiesLateDeduction,
      lateDeductionAmount,
    };
  }

  /**
   * Authoritative monthly calculation for one employee.
   * Enforces DEBT BEFORE OVERTIME.
   */
  public static calculateEmployeeMonth(input: EmployeeMonthlyInput): EmployeeCalculationResult {
    const blockers: string[] = [];
    const policy = input.policy;
    const decimalPlaces = input.currencyDecimalPlaces;

    const contractualSalaryDec = new Decimal(input.contractualMonthlySalary);
    const divisorDec = new Decimal(policy.salaryWorkingDayDivisor);
    const standardDailyMinutesDec = new Decimal(policy.standardDailyMinutes);
    const overtimeMultiplierDec = new Decimal(policy.overtimeMultiplier);

    // Reference rates
    const dailyRateDec = contractualSalaryDec.dividedBy(divisorDec);
    const hourlyRateDec = dailyRateDec.dividedBy(standardDailyMinutesDec.dividedBy(60));
    const overtimeHourlyRateDec = hourlyRateDec.times(overtimeMultiplierDec);

    const dailyRate = dailyRateDec.toNumber();
    const hourlyRate = hourlyRateDec.toNumber();
    const overtimeHourlyRate = overtimeHourlyRateDec.toNumber();

    // 1. Process daily records
    let scheduledDays = 0;
    let attendedDays = 0;
    let absentDays = 0;
    let daysOff = 0;
    let incompleteDays = 0;
    let totalRequiredMinutes = 0;
    let totalResolvedRequiredMinutes = 0;
    let totalWorkedMinutes = 0;
    let totalRegularMinutes = 0;
    let totalNewShortfalls = 0;
    let totalAdditionalMinutes = 0;
    let lateIncidentCount = 0;
    let totalLateMinutes = 0;
    let totalLateDeductions = new Decimal(0);

    const evaluatedDays: DailyCalculationResult[] = [];

    // Sort days chronologically
    const sortedDays = [...input.days].sort((a, b) => a.workDate.localeCompare(b.workDate));

    for (const day of sortedDays) {
      if (day.dayType === 'WORK') {
        scheduledDays++;
        totalRequiredMinutes += day.requiredMinutes;
      } else if (day.dayType === 'OFF') {
        daysOff++;
      }

      if (!day.isResolved && day.dayType === 'WORK') {
        incompleteDays++;
        blockers.push(`Unresolved attendance on ${day.workDate}`);
      }

      const evalDay = this.evaluateDailyWorkday(
        day,
        dailyRateDec,
        policy.lateGraceMinutes,
        policy.lateDeductionPercentage,
        decimalPlaces
      );

      if (evalDay.isResolved && evalDay.dayType === 'WORK') {
        totalResolvedRequiredMinutes += evalDay.requiredMinutes;
        totalWorkedMinutes += evalDay.workedMinutes ?? 0;
        totalRegularMinutes += evalDay.regularMinutes ?? 0;
        totalNewShortfalls += evalDay.shortfallMinutes ?? 0;
        totalAdditionalMinutes += evalDay.additionalMinutes ?? 0;
      }

      if (evalDay.attendanceStatus === 'COMPLETED' || evalDay.attendanceStatus === 'IN_PROGRESS') {
        attendedDays++;
      } else if (evalDay.attendanceStatus === 'CONFIRMED_ABSENT') {
        absentDays++;
      }

      if (evalDay.qualifiesLateDeduction) {
        lateIncidentCount++;
        totalLateMinutes += evalDay.lateMinutes;
        totalLateDeductions = totalLateDeductions.plus(evalDay.lateDeductionAmount);
      }

      evaluatedDays.push(evalDay);
    }

    // 2. Outstanding Debt Lots and Waivers
    // Opening debt lots
    const debtLots: DebtLotResult[] = [];
    let totalOpeningDebt = 0;

    for (const ex of input.existingDebtSources) {
      totalOpeningDebt += ex.minutes;
      debtLots.push({
        debtSourceId: ex.id,
        sourceType: ex.sourceType,
        originWorkDate: ex.originWorkDate,
        openingMinutes: ex.minutes,
        newMinutes: 0,
        waivedMinutes: 0,
        recoveredMinutes: 0,
        closingMinutes: ex.minutes,
      });
    }

    // Add new shortfalls as debt lots
    for (const d of evaluatedDays) {
      if (d.isResolved && (d.shortfallMinutes ?? 0) > 0) {
        debtLots.push({
          debtSourceId: `shortfall-${d.scheduleDayId}`,
          sourceType: 'ATTENDANCE_SHORTFALL',
          originWorkDate: d.workDate,
          openingMinutes: 0,
          newMinutes: d.shortfallMinutes!,
          waivedMinutes: 0,
          recoveredMinutes: 0,
          closingMinutes: d.shortfallMinutes!,
        });
      }
    }

    // Apply active waivers
    let totalWaivedMinutes = 0;
    for (const waiver of input.waivers) {
      if (waiver.status === 'ACTIVE') {
        const lot = debtLots.find((l) => l.debtSourceId === waiver.debtSourceId);
        if (lot) {
          const maxWaivable = lot.openingMinutes + lot.newMinutes - lot.waivedMinutes;
          if (waiver.minutes > maxWaivable) {
            blockers.push(`Waiver exceeds available debt on source ${waiver.debtSourceId}`);
          }
          const actualWaive = Math.min(waiver.minutes, maxWaivable);
          lot.waivedMinutes += actualWaive;
          lot.closingMinutes -= actualWaive;
          totalWaivedMinutes += actualWaive;
        } else {
          blockers.push(`Waiver references unknown debt source ${waiver.debtSourceId}`);
        }
      }
    }

    // Total debt available to settle
    const debtAvailable = Math.max(0, totalOpeningDebt + totalNewShortfalls - totalWaivedMinutes);

    // 3. Debt Recovery Allocation (DEBT BEFORE OVERTIME)
    const recoveredMinutes = Math.min(debtAvailable, totalAdditionalMinutes);
    const eligibleOvertimeMinutes = totalAdditionalMinutes - recoveredMinutes;
    const closingDebtMinutes = debtAvailable - recoveredMinutes;

    // Deterministic lot allocation
    // Sort debt lots by originWorkDate ASC, then debtSourceId ASC
    debtLots.sort((a, b) => {
      const cmp = a.originWorkDate.localeCompare(b.originWorkDate);
      return cmp !== 0 ? cmp : a.debtSourceId.localeCompare(b.debtSourceId);
    });

    // Sort additional time days by workDate ASC
    const additionalDays = evaluatedDays.filter((d) => (d.additionalMinutes ?? 0) > 0);

    const recoveryAllocations: DebtRecoveryAllocation[] = [];
    let minutesToRecover = recoveredMinutes;

    for (const day of additionalDays) {
      let dayAvailableAdditional = day.additionalMinutes ?? 0;
      let dayAllocatedRecovery = 0;

      for (const lot of debtLots) {
        if (minutesToRecover <= 0) break;
        const lotRemainingDebt = lot.openingMinutes + lot.newMinutes - lot.waivedMinutes - lot.recoveredMinutes;
        if (lotRemainingDebt > 0 && dayAvailableAdditional > 0) {
          const allocation = Math.min(lotRemainingDebt, dayAvailableAdditional, minutesToRecover);
          lot.recoveredMinutes += allocation;
          lot.closingMinutes -= allocation;
          dayAllocatedRecovery += allocation;
          dayAvailableAdditional -= allocation;
          minutesToRecover -= allocation;

          recoveryAllocations.push({
            additionalTimeDailyResultDate: day.workDate,
            additionalTimeScheduleDayId: day.scheduleDayId,
            debtSourceId: lot.debtSourceId,
            allocatedMinutes: allocation,
          });
        }
      }

      day.recoveredMinutes = dayAllocatedRecovery;
      day.eligibleOvertimeMinutes = (day.additionalMinutes ?? 0) - dayAllocatedRecovery;
    }

    // Days with 0 additional minutes
    for (const day of evaluatedDays) {
      if (day.isResolved && (day.additionalMinutes ?? 0) === 0) {
        day.recoveredMinutes = 0;
        day.eligibleOvertimeMinutes = 0;
      }
    }

    // 4. Invariant Validation
    if (totalAdditionalMinutes !== recoveredMinutes + eligibleOvertimeMinutes) {
      throw new Error(
        `Invariant failure: additionalMinutes (${totalAdditionalMinutes}) !== recovered (${recoveredMinutes}) + overtime (${eligibleOvertimeMinutes})`
      );
    }
    if (totalOpeningDebt + totalNewShortfalls - totalWaivedMinutes !== recoveredMinutes + closingDebtMinutes) {
      throw new Error(
        `Invariant failure: debt balance mismatch: ${totalOpeningDebt} + ${totalNewShortfalls} - ${totalWaivedMinutes} !== ${recoveredMinutes} + ${closingDebtMinutes}`
      );
    }
    if (eligibleOvertimeMinutes > 0 && closingDebtMinutes > 0) {
      throw new Error(
        `Invariant failure: Cannot have both positive eligible overtime (${eligibleOvertimeMinutes}) and closing debt (${closingDebtMinutes})`
      );
    }

    // 5. Overtime Pay Calculation
    const overtimeHoursDec = new Decimal(eligibleOvertimeMinutes).dividedBy(60);
    const overtimeAmountDec = overtimeHoursDec.times(overtimeHourlyRateDec).toDecimalPlaces(decimalPlaces);
    const overtimeAmount = overtimeAmountDec.toNumber();

    // 6. Warnings
    let automaticWarningCount = 0;
    let customWarningCount = 0;
    let validWarningCount = 0;
    let countedWarningCount = 0;

    for (const w of input.warnings) {
      if (w.systemQualifies && !w.adminVoided) {
        if (w.origin === 'AUTOMATIC_LATE') {
          automaticWarningCount++;
        } else {
          customWarningCount++;
        }
        validWarningCount++;
        if (w.countsTowardLimit) {
          countedWarningCount++;
        }
      }
    }

    const warningLimitReached = countedWarningCount >= policy.warningThreshold;

    // 7. Salary Adjustments & Lines
    let baseSalaryDueDec = contractualSalaryDec;
    let additionsDec = new Decimal(0);
    let otherDeductionsDec = new Decimal(0);

    const payrollLines: PayrollLineItem[] = [];

    // Base salary line
    payrollLines.push({
      lineKey: 'BASE',
      lineType: 'BASE_SALARY',
      description: 'Monthly Contractual Base Salary',
      quantity: 1,
      unit: 'MONTH',
      rateSnapshot: contractualSalaryDec.toNumber(),
      signedAmount: contractualSalaryDec.toNumber(),
    });

    // Overtime line
    if (eligibleOvertimeMinutes > 0) {
      payrollLines.push({
        lineKey: 'OVERTIME',
        lineType: 'OVERTIME',
        description: `Eligible Overtime (${eligibleOvertimeMinutes} mins / ${overtimeHoursDec.toFixed(2)} hrs @ ${overtimeHourlyRate.toFixed(2)}/hr)`,
        quantity: overtimeHoursDec.toNumber(),
        unit: 'HOUR',
        rateSnapshot: overtimeHourlyRate,
        signedAmount: overtimeAmount,
      });
    }

    // Late deduction lines
    if (lateIncidentCount > 0) {
      payrollLines.push({
        lineKey: 'LATE_DEDUCTIONS',
        lineType: 'LATE_DEDUCTION',
        description: `Lateness Penalties (${lateIncidentCount} qualifying late days @ ${policy.lateDeductionPercentage}% of daily salary)`,
        quantity: lateIncidentCount,
        unit: 'DAY',
        rateSnapshot: dailyRateDec.times(policy.lateDeductionPercentage).dividedBy(100).toNumber(),
        signedAmount: -totalLateDeductions.toNumber(),
      });
    }

    // Custom Adjustments
    for (const adj of input.adjustments) {
      if (adj.status === 'ACTIVE') {
        let lineAmountDec: Decimal;
        if (adj.calculationMethod === 'DAILY_PERCENTAGE') {
          lineAmountDec = dailyRateDec.times(adj.adjustmentValue).dividedBy(100).toDecimalPlaces(decimalPlaces);
        } else {
          lineAmountDec = new Decimal(adj.adjustmentValue).toDecimalPlaces(decimalPlaces);
        }

        if (adj.category === 'BASE_ADJUSTMENT') {
          if (adj.direction === 'INCREASE') {
            baseSalaryDueDec = baseSalaryDueDec.plus(lineAmountDec);
          } else {
            baseSalaryDueDec = baseSalaryDueDec.minus(lineAmountDec);
          }
          payrollLines.push({
            lineKey: `ADJ_${adj.id}`,
            lineType: 'BASE_ADJUSTMENT',
            sourceRecordId: adj.id,
            description: adj.reason,
            quantity: 1,
            unit: 'ITEM',
            rateSnapshot: lineAmountDec.toNumber(),
            signedAmount: adj.direction === 'INCREASE' ? lineAmountDec.toNumber() : -lineAmountDec.toNumber(),
          });
        } else if (adj.category === 'ADDITION') {
          additionsDec = additionsDec.plus(lineAmountDec);
          payrollLines.push({
            lineKey: `ADD_${adj.id}`,
            lineType: 'ADDITION',
            sourceRecordId: adj.id,
            description: adj.reason,
            quantity: 1,
            unit: 'ITEM',
            rateSnapshot: lineAmountDec.toNumber(),
            signedAmount: lineAmountDec.toNumber(),
          });
        } else if (adj.category === 'DEDUCTION') {
          otherDeductionsDec = otherDeductionsDec.plus(lineAmountDec);
          payrollLines.push({
            lineKey: `DED_${adj.id}`,
            lineType: 'OTHER_DEDUCTION',
            sourceRecordId: adj.id,
            description: adj.reason,
            quantity: 1,
            unit: 'ITEM',
            rateSnapshot: lineAmountDec.toNumber(),
            signedAmount: -lineAmountDec.toNumber(),
          });
        }
      }
    }

    const netSalaryDec = baseSalaryDueDec
      .plus(overtimeAmountDec)
      .plus(additionsDec)
      .minus(totalLateDeductions)
      .minus(otherDeductionsDec);

    if (baseSalaryDueDec.isNegative()) {
      blockers.push('Base salary after adjustments is negative');
    }
    if (netSalaryDec.isNegative()) {
      blockers.push('Net salary is negative: deductions exceed earnings');
    }

    const netSalary = netSalaryDec.toNumber();

    return {
      employeeId: input.employeeId,
      employeeNumber: input.employeeNumber,
      fullName: input.fullName,
      positionName: input.positionName,
      currencyCode: input.currencyCode,
      currencyDecimalPlaces: input.currencyDecimalPlaces,
      contractualMonthlySalary: input.contractualMonthlySalary,
      dailyRate,
      hourlyRate,
      overtimeHourlyRate,
      scheduledDays,
      attendedDays,
      absentDays,
      daysOff,
      incompleteDays,
      requiredMinutes: totalRequiredMinutes,
      resolvedRequiredMinutes: totalResolvedRequiredMinutes,
      workedMinutes: totalWorkedMinutes,
      regularMinutes: totalRegularMinutes,
      openingDebtMinutes: totalOpeningDebt,
      newShortfallMinutes: totalNewShortfalls,
      waivedMinutes: totalWaivedMinutes,
      recoveredMinutes,
      closingDebtMinutes,
      additionalMinutes: totalAdditionalMinutes,
      eligibleOvertimeMinutes,
      lateIncidentCount,
      lateMinutes: totalLateMinutes,
      automaticWarningCount,
      customWarningCount,
      validWarningCount,
      countedWarningCount,
      warningThreshold: policy.warningThreshold,
      warningLimitReached,
      baseSalaryDue: baseSalaryDueDec.toNumber(),
      overtimeAmount,
      additionAmount: additionsDec.toNumber(),
      lateDeductionAmount: totalLateDeductions.toNumber(),
      otherDeductionAmount: otherDeductionsDec.toNumber(),
      netSalary,
      blockers,
      dailyResults: evaluatedDays,
      debtLotResults: debtLots,
      recoveryAllocations,
      payrollLines,
    };
  }
}
