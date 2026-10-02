export type AccountKind = 'SUPERADMIN' | 'RESTAURANT_ADMIN';
export type RestaurantStatus = 'ACTIVE' | 'INACTIVE';
export type PositionStatus = 'ACTIVE' | 'INACTIVE';
export type ShiftTemplateStatus = 'ACTIVE' | 'INACTIVE';
export type DeductionTypeStatus = 'ACTIVE' | 'INACTIVE';
export type EmployeeStatus = 'ACTIVE' | 'INACTIVE';
export type DayType = 'WORK' | 'OFF' | 'EXCUSED';
export type AttendanceStatus =
  | 'NOT_RECORDED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONFIRMED_ABSENT'
  | 'EXCUSED'
  | 'NEEDS_REVIEW';
export type WarningOrigin = 'AUTOMATIC_LATE' | 'CUSTOM';
export type PayrollPeriodStatus = 'DRAFT' | 'READY_FOR_REVIEW' | 'FINALIZED' | 'REOPENED';
export type CalculationRunStatus = 'BUILDING' | 'COMPLETE' | 'OBSOLETE' | 'FAILED';
export type DeductionMethod = 'FIXED' | 'DAILY_PERCENTAGE';
export type AdjustmentCategory = 'BASE_ADJUSTMENT' | 'ADDITION' | 'DEDUCTION';
export type AdjustmentDirection = 'INCREASE' | 'DECREASE';
export type AdjustmentStatus = 'ACTIVE' | 'VOID';
export type ExceptionType = 'REDUCED_OBLIGATION' | 'PAID_EXCUSED' | 'UNPAID_ABSENCE';
export type DebtSourceType = 'ATTENDANCE_SHORTFALL' | 'OPENING_IMPORT';
export type WaiverStatus = 'ACTIVE' | 'VOID';
export type LineType =
  | 'BASE_SALARY'
  | 'BASE_ADJUSTMENT'
  | 'OVERTIME'
  | 'LATE_DEDUCTION'
  | 'ADDITION'
  | 'OTHER_DEDUCTION';
export type LineUnit = 'MONTH' | 'DAY' | 'HOUR' | 'ITEM';
export type JobType = 'PAYROLL_RECALCULATE' | 'REPORT_EXPORT' | 'ACCOUNT_EMAIL';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type ReportType =
  | 'MONTHLY_SUMMARY'
  | 'EMPLOYEE_STATEMENT'
  | 'ATTENDANCE'
  | 'DEBT'
  | 'WARNINGS';
export type ExportFileType = 'XLSX' | 'CSV' | 'PDF';
export type ExportStatus = 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED' | 'EXPIRED';

export interface TenantContext {
  restaurantId: string;
  actorId: string;
  accountKind: AccountKind;
  requestId: string;
}

export interface UserSession {
  sessionId: string;
  adminAccountId: string;
  accountKind: AccountKind;
  restaurantId: string | null;
  fullName: string;
  email: string;
  csrfToken: string;
}
