export interface PolicySnapshot {
  salaryWorkingDayDivisor: number;
  standardDailyMinutes: number;
  overtimeMultiplier: number;
  lateGraceMinutes: number;
  lateDeductionPercentage: number;
  warningThreshold: number;
  customWarningsCountByDefault: boolean;
}

export interface DailyCalculationInput {
  attendanceDayId: string;
  scheduleDayId: string;
  workDate: string; // YYYY-MM-DD
  dayType: 'WORK' | 'OFF' | 'EXCUSED';
  requiredMinutes: number;
  isResolved: boolean;
  attendanceStatus: 'OFF' | 'NOT_RECORDED' | 'IN_PROGRESS' | 'COMPLETED' | 'CONFIRMED_ABSENT' | 'EXCUSED' | 'NEEDS_REVIEW';
  plannedIntervals: Array<{
    sequenceNumber: number;
    startLocalTime: string; // HH:mm or ISO
    endLocalTime: string;
  }>;
  actualIntervals: Array<{
    sequenceNumber: number;
    checkInAt: string; // ISO
    checkOutAt: string | null; // ISO
    unpaidBreakMinutes: number;
  }>;
}

export interface DebtSourceInput {
  id: string;
  sourceType: 'ATTENDANCE_SHORTFALL' | 'OPENING_IMPORT';
  attendanceDayId?: string | null;
  originWorkDate: string;
  minutes: number;
  isOpening: boolean;
}

export interface DebtWaiverInput {
  id: string;
  debtSourceId: string;
  effectiveMonth: string;
  minutes: number;
  status: 'ACTIVE' | 'VOID';
}

export interface WarningInput {
  id: string;
  origin: 'AUTOMATIC_LATE' | 'CUSTOM';
  attendanceDayId?: string | null;
  incidentDate: string;
  title: string;
  reason: string;
  lateMinutes?: number | null;
  systemQualifies: boolean;
  countsTowardLimit: boolean;
  adminVoided: boolean;
}

export interface AdjustmentInput {
  id: string;
  category: 'BASE_ADJUSTMENT' | 'ADDITION' | 'DEDUCTION';
  direction: 'INCREASE' | 'DECREASE';
  calculationMethod: 'FIXED' | 'DAILY_PERCENTAGE';
  adjustmentValue: number;
  reason: string;
  status: 'ACTIVE' | 'VOID';
}

export interface EmployeeMonthlyInput {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  positionName: string;
  contractualMonthlySalary: number;
  currencyCode: string;
  currencyDecimalPlaces: number;
  policy: PolicySnapshot;
  days: DailyCalculationInput[];
  existingDebtSources: DebtSourceInput[]; // opening debt lots from previous periods
  waivers: DebtWaiverInput[];
  warnings: WarningInput[];
  adjustments: AdjustmentInput[];
}

export interface DailyCalculationResult {
  scheduleDayId: string;
  attendanceDayId: string;
  workDate: string;
  dayType: 'WORK' | 'OFF' | 'EXCUSED';
  attendanceStatus: string;
  isResolved: boolean;
  requiredMinutes: number;
  workedMinutes: number | null;
  regularMinutes: number | null;
  shortfallMinutes: number | null;
  additionalMinutes: number | null;
  recoveredMinutes: number | null;
  eligibleOvertimeMinutes: number | null;
  lateMinutes: number;
  qualifiesLateDeduction: boolean;
  lateDeductionAmount: number;
}

export interface DebtLotResult {
  debtSourceId: string;
  sourceType: 'ATTENDANCE_SHORTFALL' | 'OPENING_IMPORT';
  originWorkDate: string;
  openingMinutes: number;
  newMinutes: number;
  waivedMinutes: number;
  recoveredMinutes: number;
  closingMinutes: number;
}

export interface DebtRecoveryAllocation {
  additionalTimeDailyResultDate: string;
  additionalTimeScheduleDayId: string;
  debtSourceId: string;
  allocatedMinutes: number;
}

export interface PayrollLineItem {
  lineKey: string;
  lineType: 'BASE_SALARY' | 'BASE_ADJUSTMENT' | 'OVERTIME' | 'LATE_DEDUCTION' | 'ADDITION' | 'OTHER_DEDUCTION';
  sourceRecordId?: string;
  description: string;
  quantity: number;
  unit: 'MONTH' | 'DAY' | 'HOUR' | 'ITEM';
  rateSnapshot: number;
  signedAmount: number; // positive for additions/base, negative for deductions
}

export interface EmployeeCalculationResult {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  positionName: string;
  currencyCode: string;
  currencyDecimalPlaces: number;
  contractualMonthlySalary: number;
  dailyRate: number;
  hourlyRate: number;
  overtimeHourlyRate: number;
  scheduledDays: number;
  attendedDays: number;
  absentDays: number;
  daysOff: number;
  incompleteDays: number;
  requiredMinutes: number;
  resolvedRequiredMinutes: number;
  workedMinutes: number;
  regularMinutes: number;
  openingDebtMinutes: number;
  newShortfallMinutes: number;
  waivedMinutes: number;
  recoveredMinutes: number;
  closingDebtMinutes: number;
  additionalMinutes: number;
  eligibleOvertimeMinutes: number;
  lateIncidentCount: number;
  lateMinutes: number;
  automaticWarningCount: number;
  customWarningCount: number;
  validWarningCount: number;
  countedWarningCount: number;
  warningThreshold: number;
  warningLimitReached: boolean;
  baseSalaryDue: number;
  overtimeAmount: number;
  additionAmount: number;
  lateDeductionAmount: number;
  otherDeductionAmount: number;
  netSalary: number;
  blockers: string[];
  dailyResults: DailyCalculationResult[];
  debtLotResults: DebtLotResult[];
  recoveryAllocations: DebtRecoveryAllocation[];
  payrollLines: PayrollLineItem[];
}
