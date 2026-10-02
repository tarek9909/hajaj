import { z } from 'zod';
import { DateTime } from 'luxon';

// ---------- shared validators ----------

const isRealDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v, { zone: 'utc' }).isValid;

/** Real calendar date, YYYY-MM-DD. */
const dateString = z.string().refine(isRealDate, { message: 'Must be a valid date (YYYY-MM-DD)' });

/** Real calendar month start, YYYY-MM-01. */
const monthStartString = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-01$/.test(v) && isRealDate(v), { message: 'Must be the first day of a month (YYYY-MM-01)' });

/** Month, YYYY-MM. */
export const monthSchema = z
  .string()
  .refine((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v), { message: 'Month must be in YYYY-MM format' });

/** Month query value: accepts YYYY-MM or YYYY-MM-01 and normalizes to YYYY-MM. */
export const monthQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}(-01)?$/, 'Month must be in YYYY-MM format')
  .transform((v) => v.slice(0, 7))
  .pipe(monthSchema);

/** ISO-8601 datetime (offset optional). */
const isoDateTime = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && DateTime.fromISO(v, { setZone: true }).isValid, {
    message: 'Must be a valid ISO-8601 datetime',
  });

const localTime = z.string().refine(
  (v) => {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
    return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59 && (m[3] === undefined || Number(m[3]) <= 59);
  },
  { message: 'Must be a valid time (HH:MM)' }
);

const timezoneString = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (v) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone' }
  );

const currencyCodeString = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Must be a 3-letter currency code');

/** Money/quantity value: positive, max 4 decimals, fits DECIMAL(18,4). */
const decimalValue = z
  .number()
  .positive()
  .max(99999999999999)
  .refine((v) => Math.abs(Math.round(v * 10000) / 10000 - v) < 1e-9, { message: 'At most 4 decimal places allowed' });

const MAX_MINUTES = 1440;

const toMinuteOfDay = (t: string): number => {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
};

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
  currencyCode: currencyCodeString,
  currencyDecimalPlaces: z.number().int().min(0).max(4).default(2),
  timezone: timezoneString,
  payrollStartMonth: monthStartString,
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
  currencyCode: currencyCodeString.optional(),
  timezone: timezoneString.optional(),
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

export const createDeductionTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']),
    defaultValue: z.number().min(0).max(99999999999999),
  })
  .superRefine((v, ctx) => {
    if (v.calculationMethod === 'DAILY_PERCENTAGE' && v.defaultValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultValue'], message: 'Percentage cannot exceed 100' });
    }
  });

export const updateDeductionTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']).optional(),
    defaultValue: z.number().min(0).max(99999999999999).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    if (v.calculationMethod === 'DAILY_PERCENTAGE' && v.defaultValue !== undefined && v.defaultValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultValue'], message: 'Percentage cannot exceed 100' });
    }
  });

export const createShiftTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  intervals: z
    .array(
      z
        .object({
          sequenceNumber: z.number().int().positive(),
          startLocalTime: localTime,
          startDayOffset: z.number().int().min(0).max(1).default(0),
          endLocalTime: localTime,
          endDayOffset: z.number().int().min(0).max(1).default(0),
          plannedUnpaidBreakMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
        })
        .superRefine((v, ctx) => {
          const start = v.startDayOffset * MAX_MINUTES + toMinuteOfDay(v.startLocalTime);
          const end = v.endDayOffset * MAX_MINUTES + toMinuteOfDay(v.endLocalTime);
          if (end <= start) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endLocalTime'], message: 'Interval end must be after start' });
          } else if (v.plannedUnpaidBreakMinutes >= end - start) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['plannedUnpaidBreakMinutes'],
              message: 'Unpaid break must be shorter than the interval',
            });
          }
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
  employmentStartDate: dateString,
  employmentEndDate: dateString.optional().nullable(),
  reason: z.string().trim().min(1).default('Initial salary'),
});

export const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  mobile: z.string().trim().max(30).optional(),
  positionId: z.string().optional(),
  employmentEndDate: dateString.optional().nullable(),
  expectedVersion: z.number().int().positive(),
});

export const createSalaryVersionSchema = z.object({
  effectiveFromMonth: monthStartString,
  monthlySalary: z.number().min(0),
  reason: z.string().trim().min(1).max(500),
});

export const createPolicyVersionSchema = z.object({
  effectiveFromMonth: monthStartString,
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
  dateFrom: dateString,
  dateTo: dateString,
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
        plannedStartAt: isoDateTime,
        plannedEndAt: isoDateTime,
        plannedUnpaidBreakMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
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
      checkInAt: isoDateTime,
      checkOutAt: isoDateTime.optional().nullable(),
      unpaidBreakMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
    })
  ),
});

export const createCustomWarningSchema = z.object({
  incidentDate: dateString,
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1),
  countsTowardLimit: z.boolean().default(true),
});

export const voidWarningSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const createSalaryAdjustmentSchema = z
  .object({
    payrollMonth: monthStartString,
    workDate: dateString.optional().nullable(),
    category: z.enum(['BASE_ADJUSTMENT', 'ADDITION', 'DEDUCTION']),
    direction: z.enum(['INCREASE', 'DECREASE']),
    deductionTypeId: z.string().optional().nullable(),
    calculationMethod: z.enum(['FIXED', 'DAILY_PERCENTAGE']),
    adjustmentValue: decimalValue,
    reason: z.string().trim().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.category === 'ADDITION' && v.direction !== 'INCREASE') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['direction'], message: 'An ADDITION must be an INCREASE' });
    }
    if (v.category === 'DEDUCTION' && v.direction !== 'DECREASE') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['direction'], message: 'A DEDUCTION must be a DECREASE' });
    }
    if (v.deductionTypeId && v.category !== 'DEDUCTION') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deductionTypeId'], message: 'A deduction type is only allowed for DEDUCTION' });
    }
    if (v.calculationMethod === 'DAILY_PERCENTAGE' && v.adjustmentValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['adjustmentValue'], message: 'Percentage cannot exceed 100' });
    }
  });

export const voidSalaryAdjustmentSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const createDebtWaiverSchema = z.object({
  employeeId: z.string().optional().nullable(),
  debtSourceId: z.string().min(1),
  // Accepts YYYY-MM or YYYY-MM-01; always normalized to YYYY-MM-01.
  effectiveMonth: z
    .string()
    .regex(/^\d{4}-\d{2}(-01)?$/, 'Must be a month (YYYY-MM or YYYY-MM-01)')
    .transform((v) => `${v.slice(0, 7)}-01`)
    .pipe(monthStartString),
  minutes: z.number().int().positive().max(100000),
  reason: z.string().trim().min(1),
});

export const voidDebtWaiverSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
  expectedVersion: z.number().int().positive(),
});

export const reopenPayrollPeriodSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
