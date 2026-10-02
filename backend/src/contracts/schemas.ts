import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const passwordSetupSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

export const passwordResetCompleteSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export const createRestaurantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).optional().nullable(),
  contactMobile: z.string().trim().max(30).optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  currencyCode: z.string().trim().length(3).toUpperCase(),
  currencyDecimalPlaces: z.number().int().min(0).max(4).default(2),
  timezone: z.string().trim().min(1).max(64),
  payrollStartMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  initialAdmin: z.object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().email(),
    mobile: z.string().trim().max(30).optional().nullable(),
    password: z.string().min(8).optional(),
  }),
  initialPolicy: z.object({
    salaryWorkingDayDivisor: z.number().int().min(1).max(31).default(26),
    standardDailyMinutes: z.number().int().min(1).max(1440).default(480),
    overtimeMultiplier: z.number().min(1).default(1.5),
    lateGraceMinutes: z.number().int().min(0).max(1440).default(10),
    lateDeductionPercentage: z.number().min(0).max(100).default(10),
    warningThreshold: z.number().int().min(1).default(3),
    customWarningsCountByDefault: z.boolean().default(true),
    reason: z.string().trim().min(1).default('Initial policy'),
  }),
});

export const updateRestaurantSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  contactName: z.string().trim().max(200).optional().nullable(),
  contactMobile: z.string().trim().max(30).optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  expectedVersion: z.number().int().positive(),
});

export const createAdministratorSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().email(),
  mobile: z.string().trim().max(30).optional().nullable(),
  password: z.string().min(8).optional(),
});

export const updateAdministratorSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  mobile: z.string().trim().max(30).optional().nullable(),
  expectedVersion: z.number().int().positive(),
});

export const createPositionSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updatePositionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  expectedVersion: z.number().int().positive(),
});

export const createDeductionTypeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']),
  defaultValue: z.number().min(0),
});

export const updateDeductionTypeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']).optional(),
  defaultValue: z.number().min(0).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  expectedVersion: z.number().int().positive(),
});

export const createShiftTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  intervals: z
    .array(
      z.object({
        sequenceNumber: z.number().int().positive(),
        startLocalTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
        startDayOffset: z.number().int().min(0).max(1).default(0),
        endLocalTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
        endDayOffset: z.number().int().min(0).max(1).default(0),
        plannedUnpaidBreakMinutes: z.number().int().min(0).default(0),
      })
    )
    .min(1),
});

export const createEmployeeSchema = z.object({
  employeeNumber: z.string().trim().min(1).max(50),
  fullName: z.string().trim().min(1).max(200),
  mobile: z.string().trim().min(1).max(30),
  positionId: z.string(),
  monthlySalary: z.number().min(0),
  employmentStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  employmentEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  reason: z.string().trim().min(1).default('Initial salary'),
});

export const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  mobile: z.string().trim().max(30).optional(),
  positionId: z.string().optional(),
  employmentEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  expectedVersion: z.number().int().positive(),
});

export const createSalaryVersionSchema = z.object({
  effectiveFromMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  monthlySalary: z.number().min(0),
  reason: z.string().trim().min(1).max(500),
});

export const createPolicyVersionSchema = z.object({
  effectiveFromMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  salaryWorkingDayDivisor: z.number().int().min(1).max(31),
  standardDailyMinutes: z.number().int().min(1).max(1440),
  overtimeMultiplier: z.number().min(1),
  lateGraceMinutes: z.number().int().min(0).max(1440),
  lateDeductionPercentage: z.number().min(0).max(100),
  warningThreshold: z.number().int().min(1),
  customWarningsCountByDefault: z.boolean().default(true),
  reason: z.string().trim().min(1).max(500),
});

export const bulkScheduleSchema = z.object({
  employeeIds: z.array(z.string()).min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekdays: z.array(z.number().int().min(1).max(7)), // 1=Mon ... 7=Sun
  shiftTemplateId: z.string().optional().nullable(),
  dayType: z.enum(['WORK', 'OFF']).default('WORK'),
  existingEntryPolicy: z.enum(['REJECT_CONFLICTS', 'OVERWRITE']).default('OVERWRITE'),
});

export const updateScheduleDaySchema = z.object({
  dayType: z.enum(['WORK', 'OFF', 'EXCUSED']),
  shiftTemplateId: z.string().optional().nullable(),
  intervals: z
    .array(
      z.object({
        sequenceNumber: z.number().int().positive(),
        plannedStartAt: z.string(),
        plannedEndAt: z.string(),
        plannedUnpaidBreakMinutes: z.number().int().min(0).default(0),
      })
    )
    .optional(),
  exceptionReason: z.string().trim().max(500).optional().nullable(),
  expectedVersion: z.number().int().positive(),
});

export const updateAttendanceDaySchema = z.object({
  status: z.enum(['NOT_RECORDED', 'IN_PROGRESS', 'COMPLETED', 'CONFIRMED_ABSENT', 'EXCUSED', 'NEEDS_REVIEW']),
  additionalWorkApproved: z.boolean().default(false),
  notes: z.string().optional().nullable(),
  expectedVersion: z.number().int().positive(),
  intervals: z.array(
    z.object({
      scheduleIntervalId: z.string().optional().nullable(),
      sequenceNumber: z.number().int().positive(),
      checkInAt: z.string(),
      checkOutAt: z.string().optional().nullable(),
      unpaidBreakMinutes: z.number().int().min(0).default(0),
    })
  ),
});

export const createCustomWarningSchema = z.object({
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1),
  countsTowardLimit: z.boolean().default(true),
});

export const voidWarningSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const createSalaryAdjustmentSchema = z.object({
  payrollMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  category: z.enum(['BASE_ADJUSTMENT', 'ADDITION', 'DEDUCTION']),
  direction: z.enum(['INCREASE', 'DECREASE']),
  deductionTypeId: z.string().optional().nullable(),
  calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']),
  adjustmentValue: z.number().positive(),
  reason: z.string().trim().min(1),
});

export const voidSalaryAdjustmentSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const createDebtWaiverSchema = z.object({
  debtSourceId: z.string(),
  effectiveMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
  minutes: z.number().int().positive(),
  reason: z.string().trim().min(1),
});

export const voidDebtWaiverSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const reopenPayrollPeriodSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
