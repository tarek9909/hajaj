/**
 * WorkforceOS Typed API Client
 */

let cachedCsrfToken: string | null = null;
let csrfInFlight: Promise<string | null> | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** The auth layer registers this so an expired session sends the user back to sign-in. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function setCsrfToken(token: string | null): void {
  cachedCsrfToken = token;
}

export function fetchCsrfToken(): Promise<string | null> {
  if (csrfInFlight) return csrfInFlight;
  csrfInFlight = (async () => {
    try {
      const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
      if (!res.ok) return null;
      const json = await res.json();
      cachedCsrfToken = json.data?.csrfToken || null;
      return cachedCsrfToken;
    } catch {
      return null;
    } finally {
      csrfInFlight = null;
    }
  })();
  return csrfInFlight;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Normalizes a YYYY-MM or YYYY-MM-DD value to the first day of that month (YYYY-MM-01). */
function toMonthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

/** Trimmed string, or null when blank. */
function blankToNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const PUBLIC_AUTH_PATHS = ['/api/v1/auth/login', '/api/v1/auth/password-setup', '/api/v1/auth/password-reset'];

async function parseBody(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json().catch(() => ({}));
  }
  return res.text();
}

export async function apiRequest<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = MUTATING.includes(method);
  const needsCsrf = isMutation && !PUBLIC_AUTH_PATHS.some((p) => url.startsWith(p));

  const send = async (): Promise<Response> => {
    const headers = new Headers(options.headers || {});
    if (isMutation && options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    if (needsCsrf) {
      if (!cachedCsrfToken) await fetchCsrfToken();
      if (cachedCsrfToken) headers.set('X-CSRF-Token', cachedCsrfToken);
    }
    return fetch(url, { ...options, headers, credentials: 'include' });
  };

  let res = await send();

  // Stale/missing CSRF token (e.g. after a server restart): refresh once and retry.
  if (res.status === 403 && needsCsrf) {
    const probe = await res.clone().json().catch(() => null);
    if (probe?.error?.code === 'CSRF_TOKEN_INVALID' || probe?.error?.code === 'CSRF_TOKEN_MISSING') {
      cachedCsrfToken = null;
      res = await send();
    }
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  const body = await parseBody(res);

  if (!res.ok) {
    if (res.status === 401 && !PUBLIC_AUTH_PATHS.some((p) => url.startsWith(p)) && !url.startsWith('/api/v1/auth/me')) {
      cachedCsrfToken = null;
      unauthorizedHandler?.();
    }
    const err = body?.error || { code: 'UNKNOWN_ERROR', message: res.statusText || 'Request failed' };
    throw new ApiError(res.status, err.code, err.message, err.details);
  }

  return body && typeof body === 'object' && body.data !== undefined ? body.data : body;
}

// ==========================================
// AUTH API
// ==========================================
export interface SessionIdentity {
  adminAccountId: string;
  accountKind: 'SUPERADMIN' | 'RESTAURANT_ADMIN';
  restaurantId: string | null;
  fullName: string;
  email: string;
  restaurantName?: string | null;
  restaurantCurrency?: string | null;
}

export const authApi = {
  login: async (data: { email: string; password?: string }) => {
    const res = await apiRequest<SessionIdentity & { csrfToken: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setCsrfToken(res.csrfToken ?? null);
    return res;
  },

  logout: async () => {
    try {
      return await apiRequest<{ message: string }>('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
    }
  },

  me: () => apiRequest<SessionIdentity>('/api/v1/auth/me'),

  requestPasswordReset: (email: string) =>
    apiRequest<{ message: string }>('/api/v1/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  completePasswordReset: (token: string, newPassword: string) =>
    apiRequest<{ message: string }>('/api/v1/auth/password-reset/complete', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),

  setupPassword: (token: string, newPassword: string) =>
    apiRequest<{ message: string }>('/api/v1/auth/password-setup', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
};

// ==========================================
// RESTAURANT PROFILE (tenant-scoped)
// ==========================================
export interface RestaurantProfile {
  id: string;
  name: string;
  contactName: string | null;
  contactMobile: string | null;
  contactEmail: string | null;
  currencyCode: string;
  currencyDecimalPlaces: number;
  timezone: string;
  status: 'ACTIVE' | 'INACTIVE';
  payrollStartMonth: string;
  rowVersion: number;
}

export const restaurantApi = {
  getProfile: (restaurantId: string) =>
    apiRequest<RestaurantProfile>(`/api/v1/restaurants/${restaurantId}/profile`),
};


// ==========================================
// PLATFORM / RESTAURANTS API
// ==========================================
export const platformApi = {
  listRestaurants: (status?: string) =>
    apiRequest<Array<{
      id: string;
      name: string;
      contactName: string;
      contactMobile: string;
      contactEmail: string;
      currencyCode: string;
      currencyDecimalPlaces: number;
      timezone: string;
      status: 'ACTIVE' | 'INACTIVE';
      payrollStartMonth: string;
      activeAdminCount: number;
      activeEmployeeCount: number;
      rowVersion: number;
    }>>(`/api/v1/platform/restaurants${status ? `?status=${status}` : ''}`),

  getRestaurant: (restaurantId: string) =>
    apiRequest<{
      id: string;
      name: string;
      contactName: string;
      contactMobile: string;
      contactEmail: string;
      currencyCode: string;
      currencyDecimalPlaces: number;
      timezone: string;
      status: 'ACTIVE' | 'INACTIVE';
      payrollStartMonth: string;
      activeAdminCount: number;
      activeEmployeeCount: number;
      rowVersion: number;
    }>(`/api/v1/platform/restaurants/${restaurantId}`),

  onboardRestaurant: (data: any) =>
    apiRequest<{ restaurantId: string; adminId?: string; message: string; setupPath?: string }>('/api/v1/platform/restaurants', {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        // contactEmail must be a valid email or null; blank strings are rejected
        contactName: blankToNull(data.contactName),
        contactMobile: blankToNull(data.contactMobile),
        contactEmail: blankToNull(data.contactEmail),
        payrollStartMonth: toMonthStart(data.payrollStartMonth),
        initialAdmin: data.initialAdmin
          ? {
              ...data.initialAdmin,
              mobile: blankToNull(data.initialAdmin.mobile),
              ...(data.initialAdmin.password ? {} : { password: undefined }),
            }
          : data.initialAdmin,
      }),
    }),

  updateStatus: (restaurantId: string, status: 'ACTIVE' | 'INACTIVE', expectedVersion: number) =>
    apiRequest<{ message: string }>(`/api/v1/platform/restaurants/${restaurantId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedVersion }),
    }),
};

// ==========================================
// EMPLOYEES API
// ==========================================
export const employeesApi = {
  list: (restaurantId: string, status?: string) =>
    apiRequest<Array<{
      id: string;
      employeeNumber: string;
      fullName: string;
      mobile: string;
      positionId: string;
      positionName: string;
      employmentStartDate: string;
      employmentEndDate: string | null;
      status: 'ACTIVE' | 'INACTIVE';
      monthlySalary: number | null;
      rowVersion: number;
    }>>(`/api/v1/restaurants/${restaurantId}/employees${status ? `?status=${status}` : ''}`),

  create: (
    restaurantId: string,
    data: {
      employeeNumber: string;
      fullName: string;
      mobile: string;
      positionId: string;
      employmentStartDate: string;
      initialSalary: string | number;
      employmentEndDate?: string | null;
      reason?: string;
    }
  ) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/employees`, {
      method: 'POST',
      body: JSON.stringify({
        employeeNumber: data.employeeNumber,
        fullName: data.fullName,
        mobile: data.mobile,
        positionId: data.positionId,
        employmentStartDate: data.employmentStartDate,
        employmentEndDate: blankToNull(data.employmentEndDate),
        monthlySalary: Number(data.initialSalary),
        reason: data.reason?.trim() || 'Initial salary',
      }),
    }),

  get: (restaurantId: string, employeeId: string) =>
    apiRequest<any>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}`),

  update: (restaurantId: string, employeeId: string, data: any) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  /** Activate/deactivate: dedicated route (PATCH /employees/:id does not accept status). */
  updateStatus: (restaurantId: string, employeeId: string, status: 'ACTIVE' | 'INACTIVE', expectedVersion: number) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedVersion }),
    }),

  addSalaryRevision: (
    restaurantId: string,
    employeeId: string,
    data: { effectiveFromMonth: string; monthlySalary: number; reason: string }
  ) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}/salaries`, {
      method: 'POST',
      body: JSON.stringify({ ...data, effectiveFromMonth: toMonthStart(data.effectiveFromMonth) }),
    }),
};

// ==========================================
// SCHEDULING API
// ==========================================
export interface BulkScheduleForm {
  employeeIds: string[];
  startDate: string;
  endDate: string;
  shiftTemplateId: string;
  dayType: 'WORK' | 'OFF';
  weekdays: number[];
  overwriteExisting: boolean;
}

function toBulkPayload(f: BulkScheduleForm) {
  return {
    employeeIds: f.employeeIds,
    dateFrom: f.startDate,
    dateTo: f.endDate,
    weekdays: f.weekdays,
    dayType: f.dayType,
    shiftTemplateId: f.dayType === 'WORK' && f.shiftTemplateId ? f.shiftTemplateId : null,
    existingEntryPolicy: f.overwriteExisting ? 'OVERWRITE' : 'REJECT_CONFLICTS',
  };
}

export const schedulingApi = {
  getCalendar: (restaurantId: string, month: string) =>
    apiRequest<Array<{
      id: string;
      employeeId: string;
      workDate: string;
      dayType: 'WORK' | 'OFF' | 'EXCUSED';
      sourceTemplateId: string | null;
      templateName: string | null;
      requiredMinutes: number;
      intervals: Array<{
        sequenceNumber: number;
        plannedStartAt: string;
        plannedEndAt: string;
        plannedUnpaidBreakMinutes: number;
      }>;
    }>>(`/api/v1/restaurants/${restaurantId}/schedules?month=${month}`),

  previewBulk: (restaurantId: string, data: BulkScheduleForm) =>
    apiRequest<{ totalDaysToGenerate: number; conflictCount: number; warnings: string[] }>(
      `/api/v1/restaurants/${restaurantId}/schedules/bulk-preview`,
      { method: 'POST', body: JSON.stringify(toBulkPayload(data)) }
    ),

  commitBulk: (restaurantId: string, data: BulkScheduleForm) =>
    apiRequest<{ scheduledDaysCount: number; message: string }>(
      `/api/v1/restaurants/${restaurantId}/schedules/bulk-commit`,
      { method: 'POST', body: JSON.stringify(toBulkPayload(data)) }
    ),
};

// ==========================================
// ATTENDANCE API
// ==========================================
export const attendanceApi = {
  getDaily: (restaurantId: string, date: string) =>
    apiRequest<Array<{
      attendanceDayId: string;
      employeeId: string;
      employeeNumber: string;
      fullName: string;
      scheduleDayId: string;
      dayType: string;
      requiredMinutes: number;
      status: 'NOT_RECORDED' | 'IN_PROGRESS' | 'COMPLETED' | 'CONFIRMED_ABSENT' | 'EXCUSED' | 'NEEDS_REVIEW';
      additionalWorkApproved: boolean;
      notes: string | null;
      rowVersion: number;
      plannedIntervals: Array<any>;
      actualIntervals: Array<any>;
    }>>(`/api/v1/restaurants/${restaurantId}/attendance/daily?date=${date}`),

  updateDay: (restaurantId: string, attendanceDayId: string, data: any) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/attendance/days/${attendanceDayId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// ==========================================
// WARNINGS API
// ==========================================
export const warningsApi = {
  list: (restaurantId: string, month?: string) =>
    apiRequest<{
      threshold: number;
      warnings: Array<{
        id: string;
        employeeId: string;
        fullName: string;
        employeeNumber: string;
        origin: 'AUTOMATIC_LATE' | 'CUSTOM';
        incidentDate: string;
        title: string;
        reason: string;
        lateMinutes: number | null;
        systemQualifies: boolean;
        countsTowardLimit: boolean;
        adminVoided: boolean;
        voidReason: string | null;
        rowVersion: number;
      }>;
      employeeWarningCounts: Record<string, { total: number; counted: number; limitReached: boolean }>;
    }>(`/api/v1/restaurants/${restaurantId}/warnings${month ? `?month=${month}` : ''}`),

  createCustom: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/warnings/custom`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  voidWarning: (restaurantId: string, warningId: string, data: { voidReason: string; expectedVersion: number }) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/warnings/${warningId}/void`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ==========================================
// HOUR DEBT & WAIVERS API
// ==========================================
export const debtApi = {
  list: (restaurantId: string, month?: string) =>
    apiRequest<{
      sources: Array<{
        id: string;
        employeeId: string;
        fullName: string;
        sourceType: string;
        originWorkDate: string;
        shortfallMinutes: number;
        importedMinutes: number | null;
        waivedMinutes: number;
        hasActiveWaiver: boolean;
        waiverId: string | null;
      }>;
      waivers: Array<{
        id: string;
        employeeId: string;
        fullName: string;
        debtSourceId: string;
        effectiveMonth: string;
        minutes: number;
        reason: string;
        status: string;
        rowVersion: number;
      }>;
    }>(`/api/v1/restaurants/${restaurantId}/debt${month ? `?month=${month}` : ''}`),

  createWaiver: (
    restaurantId: string,
    data: { employeeId?: string; debtSourceId: string; effectiveMonth: string; minutes: number; reason: string }
  ) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/debt/waivers`, {
      method: 'POST',
      body: JSON.stringify({
        employeeId: blankToNull(data.employeeId),
        debtSourceId: data.debtSourceId,
        effectiveMonth: toMonthStart(data.effectiveMonth),
        minutes: Number(data.minutes),
        reason: data.reason,
      }),
    }),

  voidWaiver: (restaurantId: string, waiverId: string, data: { voidReason: string; expectedVersion: number }) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/debt/waivers/${waiverId}/void`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ==========================================
// SALARY ADJUSTMENTS API
// ==========================================
export const adjustmentsApi = {
  list: (restaurantId: string, month: string) =>
    apiRequest<Array<{
      id: string;
      employeeId: string;
      fullName: string;
      payrollMonth: string;
      workDate: string | null;
      category: 'BASE_ADJUSTMENT' | 'ADDITION' | 'DEDUCTION';
      direction: 'INCREASE' | 'DECREASE';
      deductionTypeName: string | null;
      calculationMethod: 'FIXED' | 'DAILY_PERCENTAGE';
      adjustmentValue: number;
      reason: string;
      status: 'ACTIVE' | 'VOID';
      voidReason: string | null;
      rowVersion: number;
    }>>(`/api/v1/restaurants/${restaurantId}/adjustments?month=${month}`),

  create: (restaurantId: string, employeeId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/adjustments/employees/${employeeId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  void: (restaurantId: string, adjustmentId: string, data: { voidReason: string; expectedVersion: number }) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/adjustments/${adjustmentId}/void`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ==========================================
// PAYROLL & REPORTING API
// ==========================================
export const payrollApi = {
  getPeriodOverview: (restaurantId: string, month: string) =>
    apiRequest<{
      period: {
        id: string;
        monthStart: string;
        status: 'DRAFT' | 'READY_FOR_REVIEW' | 'FINALIZED' | 'REOPENED';
        sourceRevision: number;
        currentCalculationRunId: string | null;
        isStale: boolean;
        finalizedAt: string | null;
        finalizedByName: string | null;
      };
      summary: {
        totalEmployees: number;
        totalContractualSalary: number;
        totalBaseDue: number;
        totalOvertimePay: number;
        totalAdditions: number;
        totalLateDeductions: number;
        totalOtherDeductions: number;
        totalNetPayable: number;
        totalRecoveredDebtMinutes: number;
        totalRemainingDebtMinutes: number;
        warningLimitCount: number;
      };
      employees: Array<any>;
    }>(`/api/v1/restaurants/${restaurantId}/payroll/periods/${month}`),

  listPeriods: (restaurantId: string) =>
    apiRequest<Array<{ month: string; status: string; currentCalculationRunId: string | null }>>(
      `/api/v1/restaurants/${restaurantId}/payroll/periods`
    ),

  getBlockers: (restaurantId: string, month: string) =>
    apiRequest<{
      totalBlockersCount: number;
      affectedEmployees: Array<{ employeeId: string; fullName: string; blockers: string[] }>;
    }>(`/api/v1/restaurants/${restaurantId}/payroll/periods/${month}/blockers`),

  recalculate: (restaurantId: string, month: string) =>
    apiRequest<{ calculationRunId: string; message: string }>(
      `/api/v1/restaurants/${restaurantId}/payroll/periods/${month}/calculate`,
      { method: 'POST' }
    ),

  finalize: (restaurantId: string, month: string) =>
    apiRequest<{ message: string }>(
      `/api/v1/restaurants/${restaurantId}/payroll/periods/${month}/finalize`,
      { method: 'POST' }
    ),

  reopen: (restaurantId: string, month: string, reason: string) =>
    apiRequest<{ message: string }>(
      `/api/v1/restaurants/${restaurantId}/payroll/periods/${month}/reopen`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),

  getExportUrl: (restaurantId: string, month: string) =>
    `/api/v1/restaurants/${restaurantId}/reports/monthly?month=${month}&format=xlsx`,
};

// ==========================================
// CONFIGURATION API
// ==========================================
export const configApi = {
  getPolicies: (restaurantId: string) =>
    apiRequest<Array<any>>(`/api/v1/restaurants/${restaurantId}/configuration/policies`),

  createPolicyVersion: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/configuration/policies`, {
      method: 'POST',
      body: JSON.stringify({ ...data, effectiveFromMonth: toMonthStart(data.effectiveFromMonth) }),
    }),

  getPositions: (restaurantId: string) =>
    apiRequest<Array<{ id: string; name: string; status: string; rowVersion: number }>>(
      `/api/v1/restaurants/${restaurantId}/configuration/positions`
    ),

  createPosition: (restaurantId: string, name: string) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/configuration/positions`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getDeductionTypes: (restaurantId: string) =>
    apiRequest<Array<any>>(`/api/v1/restaurants/${restaurantId}/configuration/deduction-types`),

  createDeductionType: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/configuration/deduction-types`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getShiftTemplates: (restaurantId: string) =>
    apiRequest<Array<any>>(`/api/v1/restaurants/${restaurantId}/configuration/shift-templates`),

  createShiftTemplate: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/configuration/shift-templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getAdministrators: (restaurantId: string) =>
    apiRequest<Array<{
      id: string;
      fullName: string;
      email: string;
      mobile: string;
      status: 'ACTIVE' | 'INACTIVE';
      lastLoginAt: string | null;
      rowVersion: number;
    }>>(`/api/v1/restaurants/${restaurantId}/administrators`),

  createAdministrator: (
    restaurantId: string,
    data: { fullName: string; email: string; mobile?: string | null; password?: string }
  ) =>
    apiRequest<{ id: string; message: string; setupPath?: string }>(`/api/v1/restaurants/${restaurantId}/administrators`, {
      method: 'POST',
      body: JSON.stringify({
        fullName: data.fullName,
        email: data.email,
        mobile: blankToNull(data.mobile),
        ...(data.password ? { password: data.password } : {}),
      }),
    }),

  updateAdminStatus: (restaurantId: string, adminId: string, status: 'ACTIVE' | 'INACTIVE', expectedVersion: number) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/administrators/${adminId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedVersion }),
    }),
};
