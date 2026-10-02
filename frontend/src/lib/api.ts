/**
 * WorkforceOS Typed API Client
 */

let cachedCsrfToken: string | null = null;

export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
    if (!res.ok) return null;
    const json = await res.json();
    cachedCsrfToken = json.data?.csrfToken || null;
    return cachedCsrfToken;
  } catch {
    return null;
  }
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

export async function apiRequest<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    if (!cachedCsrfToken) {
      await fetchCsrfToken();
    }
    if (cachedCsrfToken) {
      headers.set('X-CSRF-Token', cachedCsrfToken);
    }
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  let body: any;
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    body = await res.json();
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    // If CSRF token expired or invalid, retry once
    if (res.status === 403 && body?.error?.code === 'CSRF_INVALID') {
      cachedCsrfToken = null;
      await fetchCsrfToken();
      if (cachedCsrfToken) {
        headers.set('X-CSRF-Token', cachedCsrfToken);
        const retryRes = await fetch(url, { ...options, headers, credentials: 'include' });
        if (retryRes.ok) {
          const retryBody = await retryRes.json();
          return retryBody.data ?? retryBody;
        }
      }
    }

    const err = body?.error || { code: 'UNKNOWN_ERROR', message: res.statusText };
    throw new ApiError(res.status, err.code, err.message, err.details);
  }

  return body.data !== undefined ? body.data : body;
}

// ==========================================
// AUTH API
// ==========================================
export const authApi = {
  login: (data: { email: string; password?: string }) =>
    apiRequest<{ accountId: string; accountKind: string; restaurantId: string | null; fullName: string; email: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    apiRequest<{ message: string }>('/api/v1/auth/logout', { method: 'POST' }),

  me: () =>
    apiRequest<{
      adminAccountId: string;
      accountKind: 'SUPERADMIN' | 'RESTAURANT_ADMIN';
      restaurantId: string | null;
      fullName: string;
      email: string;
    }>('/api/v1/auth/me'),

  requestPasswordReset: (email: string) =>
    apiRequest<{ message: string }>('/api/v1/auth/password/reset-request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
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
    apiRequest<{ restaurantId: string; message: string }>('/api/v1/platform/restaurants', {
      method: 'POST',
      body: JSON.stringify(data),
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

  create: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/employees`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (restaurantId: string, employeeId: string) =>
    apiRequest<any>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}`),

  update: (restaurantId: string, employeeId: string, data: any) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  addSalaryRevision: (restaurantId: string, employeeId: string, data: any) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/employees/${employeeId}/salaries`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ==========================================
// SCHEDULING API
// ==========================================
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

  previewBulk: (restaurantId: string, data: any) =>
    apiRequest<{ totalDaysToGenerate: number; conflictCount: number; warnings: string[] }>(
      `/api/v1/restaurants/${restaurantId}/schedules/bulk-preview`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  commitBulk: (restaurantId: string, data: any) =>
    apiRequest<{ scheduledDaysCount: number; message: string }>(
      `/api/v1/restaurants/${restaurantId}/schedules/bulk-commit`,
      { method: 'POST', body: JSON.stringify(data) }
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

  createWaiver: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/debt/waivers`, {
      method: 'POST',
      body: JSON.stringify(data),
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
      body: JSON.stringify(data),
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

  createAdministrator: (restaurantId: string, data: any) =>
    apiRequest<{ id: string; message: string }>(`/api/v1/restaurants/${restaurantId}/administrators`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAdminStatus: (restaurantId: string, adminId: string, status: 'ACTIVE' | 'INACTIVE', expectedVersion: number) =>
    apiRequest<{ message: string }>(`/api/v1/restaurants/${restaurantId}/administrators/${adminId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expectedVersion }),
    }),
};
