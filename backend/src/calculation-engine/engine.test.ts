import { describe, it, expect } from 'vitest';
import { CalculationEngine } from './engine.js';
import type { DailyCalculationInput, EmployeeMonthlyInput, PolicySnapshot } from './types.js';

describe('CalculationEngine - Daily Evaluation', () => {
  const defaultPolicy: PolicySnapshot = {
    salaryWorkingDayDivisor: 26,
    standardDailyMinutes: 480,
    overtimeMultiplier: 1.5,
    lateGraceMinutes: 10,
    lateDeductionPercentage: 10,
    warningThreshold: 3,
    customWarningsCountByDefault: true,
  };

  it('Example A: Planned 10:00-18:00, actual 10:30-18:00 -> 450 worked, 30 shortfall, 0 overtime', () => {
    const day: DailyCalculationInput = {
      attendanceDayId: 'att-1',
      scheduleDayId: 'sch-1',
      workDate: '2026-10-01',
      dayType: 'WORK',
      requiredMinutes: 480,
      isResolved: true,
      attendanceStatus: 'COMPLETED',
      plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '10:00:00', endLocalTime: '18:00:00' }],
      actualIntervals: [
        {
          sequenceNumber: 1,
          checkInAt: '2026-10-01T10:30:00.000Z',
          checkOutAt: '2026-10-01T18:00:00.000Z',
          unpaidBreakMinutes: 0,
        },
      ],
    };

    const result = CalculationEngine.evaluateDailyWorkday(
      day,
      new (require('decimal.js'))(40),
      defaultPolicy.lateGraceMinutes,
      defaultPolicy.lateDeductionPercentage
    );

    expect(result.workedMinutes).toBe(450);
    expect(result.shortfallMinutes).toBe(30);
    expect(result.additionalMinutes).toBe(0);
    expect(result.qualifiesLateDeduction).toBe(true);
    expect(result.lateMinutes).toBe(30);
  });

  it('Example B: Planned 10:00-18:00, actual 10:30-18:30 -> 480 worked, 0 shortfall, 0 overtime, late penalty remains', () => {
    const day: DailyCalculationInput = {
      attendanceDayId: 'att-2',
      scheduleDayId: 'sch-2',
      workDate: '2026-10-02',
      dayType: 'WORK',
      requiredMinutes: 480,
      isResolved: true,
      attendanceStatus: 'COMPLETED',
      plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '10:00:00', endLocalTime: '18:00:00' }],
      actualIntervals: [
        {
          sequenceNumber: 1,
          checkInAt: '2026-10-02T10:30:00.000Z',
          checkOutAt: '2026-10-02T18:30:00.000Z',
          unpaidBreakMinutes: 0,
        },
      ],
    };

    const result = CalculationEngine.evaluateDailyWorkday(
      day,
      new (require('decimal.js'))(40),
      defaultPolicy.lateGraceMinutes,
      defaultPolicy.lateDeductionPercentage
    );

    expect(result.workedMinutes).toBe(480);
    expect(result.shortfallMinutes).toBe(0);
    expect(result.additionalMinutes).toBe(0);
    expect(result.qualifiesLateDeduction).toBe(true);
    expect(result.lateDeductionAmount).toBe(4.0); // 10% of $40
  });

  it('Grace period does not shorten working hours: 8 mins late leaves on time -> 0 late penalty, 8 mins shortfall', () => {
    const day: DailyCalculationInput = {
      attendanceDayId: 'att-3',
      scheduleDayId: 'sch-3',
      workDate: '2026-10-03',
      dayType: 'WORK',
      requiredMinutes: 480,
      isResolved: true,
      attendanceStatus: 'COMPLETED',
      plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '10:00:00', endLocalTime: '18:00:00' }],
      actualIntervals: [
        {
          sequenceNumber: 1,
          checkInAt: '2026-10-03T10:08:00.000Z',
          checkOutAt: '2026-10-03T18:00:00.000Z',
          unpaidBreakMinutes: 0,
        },
      ],
    };

    const result = CalculationEngine.evaluateDailyWorkday(
      day,
      new (require('decimal.js'))(40),
      defaultPolicy.lateGraceMinutes,
      defaultPolicy.lateDeductionPercentage
    );

    expect(result.workedMinutes).toBe(472);
    expect(result.shortfallMinutes).toBe(8);
    expect(result.additionalMinutes).toBe(0);
    expect(result.qualifiesLateDeduction).toBe(false);
    expect(result.lateDeductionAmount).toBe(0);
  });
});

describe('CalculationEngine - Monthly Financial Benchmark Fixture', () => {
  it('passes the exact benchmark calculation yielding Net Salary = $1,076.25', () => {
    const policy: PolicySnapshot = {
      salaryWorkingDayDivisor: 26,
      standardDailyMinutes: 480, // 8 hours
      overtimeMultiplier: 1.5,
      lateGraceMinutes: 10,
      lateDeductionPercentage: 10,
      warningThreshold: 3,
      customWarningsCountByDefault: true,
    };

    // We build an input corresponding to:
    // Monthly salary: 1,040
    // Opening debt: 120 minutes
    // New shortfalls: 210 minutes
    // Additional work: 780 minutes
    // Waivers: 0
    // 3 late incidents
    // 1 custom warning
    // 1 other approved deduction of 8.00
    const input: EmployeeMonthlyInput = {
      employeeId: 'emp-1052',
      employeeNumber: 'E1052',
      fullName: 'Ali Hassan',
      positionName: 'Waiter',
      contractualMonthlySalary: 1040,
      currencyCode: 'USD',
      currencyDecimalPlaces: 2,
      policy,
      days: [
        // Day 1: Late by 30 mins, worked 270 mins against 480 mins -> 210 mins shortfall, 1 late penalty
        {
          attendanceDayId: 'att-101',
          scheduleDayId: 'sch-101',
          workDate: '2026-10-01',
          dayType: 'WORK',
          requiredMinutes: 480,
          isResolved: true,
          attendanceStatus: 'COMPLETED',
          plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '10:00:00', endLocalTime: '18:00:00' }],
          actualIntervals: [
            {
              sequenceNumber: 1,
              checkInAt: '2026-10-01T10:30:00.000Z',
              checkOutAt: '2026-10-01T15:00:00.000Z',
              unpaidBreakMinutes: 0,
            },
          ],
        },
        // Day 2: Late by 15 mins, worked 480 + 780 = 1260 mins -> 780 additional mins, 1 late penalty
        {
          attendanceDayId: 'att-102',
          scheduleDayId: 'sch-102',
          workDate: '2026-10-02',
          dayType: 'WORK',
          requiredMinutes: 480,
          isResolved: true,
          attendanceStatus: 'COMPLETED',
          plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '08:00:00', endLocalTime: '16:00:00' }],
          actualIntervals: [
            {
              sequenceNumber: 1,
              checkInAt: '2026-10-02T08:15:00.000Z',
              checkOutAt: '2026-10-03T05:15:00.000Z',
              unpaidBreakMinutes: 0,
            },
          ],
        },
        // Day 3: Late by 20 mins, worked 480 mins -> 0 shortfall, 0 additional, 1 late penalty
        {
          attendanceDayId: 'att-103',
          scheduleDayId: 'sch-103',
          workDate: '2026-10-03',
          dayType: 'WORK',
          requiredMinutes: 480,
          isResolved: true,
          attendanceStatus: 'COMPLETED',
          plannedIntervals: [{ sequenceNumber: 1, startLocalTime: '10:00:00', endLocalTime: '18:00:00' }],
          actualIntervals: [
            {
              sequenceNumber: 1,
              checkInAt: '2026-10-03T10:20:00.000Z',
              checkOutAt: '2026-10-03T18:20:00.000Z',
              unpaidBreakMinutes: 0,
            },
          ],
        },
      ],
      existingDebtSources: [
        {
          id: 'opening-debt-1',
          sourceType: 'OPENING_IMPORT',
          originWorkDate: '2026-09-15',
          minutes: 120,
          isOpening: true,
        },
      ],
      waivers: [],
      warnings: [
        {
          id: 'w-1',
          origin: 'AUTOMATIC_LATE',
          incidentDate: '2026-10-01',
          title: 'Late Arrival',
          reason: '30 mins late',
          systemQualifies: true,
          countsTowardLimit: true,
          adminVoided: false,
        },
        {
          id: 'w-2',
          origin: 'AUTOMATIC_LATE',
          incidentDate: '2026-10-02',
          title: 'Late Arrival',
          reason: '15 mins late',
          systemQualifies: true,
          countsTowardLimit: true,
          adminVoided: false,
        },
        {
          id: 'w-3',
          origin: 'AUTOMATIC_LATE',
          incidentDate: '2026-10-03',
          title: 'Late Arrival',
          reason: '20 mins late',
          systemQualifies: true,
          countsTowardLimit: true,
          adminVoided: false,
        },
        {
          id: 'w-4',
          origin: 'CUSTOM',
          incidentDate: '2026-10-10',
          title: 'Uniform Violation',
          reason: 'Missing name tag',
          systemQualifies: true,
          countsTowardLimit: true,
          adminVoided: false,
        },
      ],
      adjustments: [
        {
          id: 'adj-1',
          category: 'DEDUCTION',
          direction: 'DECREASE',
          calculationMethod: 'FIXED',
          adjustmentValue: 8.0,
          reason: 'Broken glassware deduction',
          status: 'ACTIVE',
        },
      ],
    };

    const result = CalculationEngine.calculateEmployeeMonth(input);

    expect(result.dailyRate).toBe(40);
    expect(result.hourlyRate).toBe(5);
    expect(result.overtimeHourlyRate).toBe(7.5);

    expect(result.openingDebtMinutes).toBe(120);
    expect(result.newShortfallMinutes).toBe(210);
    expect(result.additionalMinutes).toBe(780);
    expect(result.waivedMinutes).toBe(0);

    // Debt available: 120 + 210 = 330 mins
    // Recovered: min(330, 780) = 330 mins
    // Eligible overtime: 780 - 330 = 450 mins
    // Closing debt: 330 - 330 = 0 mins
    expect(result.recoveredMinutes).toBe(330);
    expect(result.eligibleOvertimeMinutes).toBe(450);
    expect(result.closingDebtMinutes).toBe(0);

    // Overtime pay: (450 / 60) * 7.50 = 7.5 * 7.50 = $56.25
    expect(result.overtimeAmount).toBe(56.25);

    // Late deductions: 3 * (10% of $40) = 3 * 4 = $12.00
    expect(result.lateIncidentCount).toBe(3);
    expect(result.lateDeductionAmount).toBe(12);

    // Other deductions: $8.00
    expect(result.otherDeductionAmount).toBe(8);

    // Base salary due: $1,040.00
    expect(result.baseSalaryDue).toBe(1040);

    // Net salary: 1040 + 56.25 - 12 - 8 = $1,076.25
    expect(result.netSalary).toBe(1076.25);

    // Warnings: 3 automatic + 1 custom = 4 valid warnings, threshold = 3 -> limit reached!
    expect(result.validWarningCount).toBe(4);
    expect(result.warningLimitReached).toBe(true);

    // Blockers: should be empty because all 3 days are resolved
    expect(result.blockers.length).toBe(0);
  });
});
