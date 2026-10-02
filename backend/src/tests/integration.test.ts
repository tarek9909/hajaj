import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../app.js';
import { pool } from '../infrastructure/database/pool.js';

describe('End-to-End System & Multi-Tenant Integration Tests', () => {
  let server: Server;
  let baseUrl: string;

  let superadminCookie: string;
  let superadminCsrf: string;

  let bistroAdminCookie: string;
  let bistroAdminCsrf: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Authenticate Superadmin
    const saLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'superadmin@workforce.local',
        password: 'SuperAdminPassword123!',
      }),
    });
    expect(saLoginRes.status).toBe(200);
    const saSetCookie = saLoginRes.headers.get('set-cookie') || '';
    superadminCookie = saSetCookie.split(';')[0] || '';
    const saData = await saLoginRes.json() as any;
    superadminCsrf = saData.data.csrfToken;

    // 2. Authenticate Bistro Admin (Restaurant 1)
    const baLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin.bistro@workforce.local',
        password: 'BistroAdmin123!',
      }),
    });
    expect(baLoginRes.status).toBe(200);
    const baSetCookie = baLoginRes.headers.get('set-cookie') || '';
    bistroAdminCookie = baSetCookie.split(';')[0] || '';
    const baData = await baLoginRes.json() as any;
    bistroAdminCsrf = baData.data.csrfToken;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('verifies Superadmin has access to platform overview and all restaurants', async () => {
    const res = await fetch(`${baseUrl}/api/v1/platform/restaurants`, {
      headers: {
        Cookie: superadminCookie,
        'x-csrf-token': superadminCsrf,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const names = body.data.map((r: any) => r.name);
    expect(names).toContain('The Grand Bistro');
    expect(names).toContain('Spice Garden');
  });

  it('enforces multi-tenant isolation: Restaurant Admin cannot access another tenant', async () => {
    // Bistro Admin (Restaurant 1) attempts to access Restaurant 2 (Spice Garden)
    const res = await fetch(`${baseUrl}/api/v1/restaurants/2/employees`, {
      headers: {
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('enforces finalized month freeze: rejects adjustments on finalized period August 2026', async () => {
    // Attempt to add a salary adjustment to Marcus Vance (EMP-101) in finalized month 2026-08
    const [empRows] = await pool.execute<any[]>(
      `SELECT id FROM employees WHERE restaurant_id = 1 AND employee_number = 'EMP-101'`
    );
    expect(empRows.length).toBeGreaterThan(0);
    const empId = empRows[0].id;

    const res = await fetch(`${baseUrl}/api/v1/restaurants/1/adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
      body: JSON.stringify({
        employeeId: empId,
        effectiveMonth: '2026-08-01',
        adjustmentType: 'ADDITION',
        amount: 50.0,
        reason: 'Attempted retroactive bonus after finalization',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('PAYROLL_PERIOD_FINALIZED');
  });

  it('protects the last active administrator: prevents deactivating the sole active admin', async () => {
    // Check Spice Garden (Restaurant 2), which has 1 active admin (admin.spice@workforce.local)
    const [adminRows] = await pool.execute<any[]>(
      `SELECT id, row_version FROM admin_accounts WHERE restaurant_id = 2 AND status = 'ACTIVE'`
    );
    expect(adminRows.length).toBe(1);
    const admin = adminRows[0];

    // Login as Superadmin to attempt deactivating the only active admin on Restaurant 2
    const res = await fetch(`${baseUrl}/api/v1/restaurants/2/administrators/${admin.id}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: superadminCookie,
        'x-csrf-token': superadminCsrf,
      },
      body: JSON.stringify({
        status: 'INACTIVE',
        version: admin.row_version,
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('LAST_ADMINISTRATOR_PROTECTION');
  });

  it('verifies idempotent request replay with Idempotency-Key', async () => {
    const idemKey = `test-idem-${Date.now()}`;

    // Add a custom warning to Marcus Vance in Restaurant 1 for September 2026
    const [empRows] = await pool.execute<any[]>(
      `SELECT id FROM employees WHERE restaurant_id = 1 AND employee_number = 'EMP-101'`
    );
    expect(empRows.length).toBeGreaterThan(0);
    const empId = empRows[0].id;

    const payload = {
      employeeId: empId,
      incidentDate: '2026-09-12',
      title: 'Idempotency Test Notice',
      reason: 'First attempt with idempotency key',
      countsTowardLimit: false,
    };

    // First request
    const res1 = await fetch(`${baseUrl}/api/v1/restaurants/1/warnings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
      body: JSON.stringify(payload),
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json() as any;
    const warningId = body1.data.id;

    // Second request with same Idempotency-Key
    const res2 = await fetch(`${baseUrl}/api/v1/restaurants/1/warnings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(201);
    expect(res2.headers.get('x-idempotent-replay')).toBe('true');
    const body2 = await res2.json() as any;
    expect(body2.data.id).toBe(warningId);

    // Verify in database that only ONE warning row was created
    const [dbRows] = await pool.execute<any[]>(
      `SELECT COUNT(*) AS cnt FROM warnings WHERE id = ?`,
      [warningId]
    );
    expect(dbRows[0].cnt).toBe(1);
  });

  it('verifies authoritative benchmark financial calculation for Marcus Vance in September 2026', async () => {
    const res = await fetch(`${baseUrl}/api/v1/restaurants/1/payroll/periods/2026-09`, {
      headers: {
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const { employees } = body.data;

    const marcus = employees.find((e: any) => e.employeeNumber === 'EMP-101');
    expect(marcus).toBeDefined();

    // Verify benchmark financial figures:
    // Base salary: 1040.00
    // Overtime pay: 56.25 (450 payable overtime minutes after clearing 330 debt)
    // Late penalty: -12.00 (3 days penalty at 10% daily rate)
    // Uniform deduction: -8.00
    // Net salary: 1040 + 56.25 - 12.00 - 8.00 = 1076.25
    expect(Number(marcus.baseSalary)).toBe(1040.00);
    expect(Number(marcus.overtimePay)).toBe(56.25);
    expect(Number(marcus.lateDeductions)).toBe(12.00);
    expect(Number(marcus.otherDeductions)).toBe(8.00);
    expect(Number(marcus.netSalary)).toBe(1076.25);

    // Verify David Kim has warning limit flag
    const david = employees.find((e: any) => e.employeeNumber === 'EMP-103');
    expect(david).toBeDefined();
    expect(david.activeWarningsCount).toBeGreaterThanOrEqual(4);
    expect(david.warningLimitReached).toBe(true);
  });

  it('generates downloadable Excel spreadsheet with correct headers and binary stream', async () => {
    const res = await fetch(`${baseUrl}/api/v1/restaurants/1/reports/monthly?month=2026-09&format=xlsx`, {
      headers: {
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toContain('Payroll_Summary_2026-09.xlsx');
    const buffer = await res.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it('enforces append-only salary versions: MySQL trigger blocks UPDATE on historical records', async () => {
    const [rows] = await pool.execute<any[]>(
      `SELECT id FROM employee_salary_versions WHERE restaurant_id = 1 LIMIT 1`
    );
    expect(rows.length).toBeGreaterThan(0);
    const verId = rows[0].id;

    let triggerFired = false;
    try {
      await pool.execute(
        `UPDATE employee_salary_versions SET monthly_salary = 9999.00 WHERE id = ?`,
        [verId]
      );
    } catch (err: any) {
      triggerFired = true;
      expect(err.message).toContain('append-only');
    }
    expect(triggerFired).toBe(true);
  });

  it('verifies medical waiver relief: clears shortfall without becoming unrecovered hour debt', async () => {
    const res = await fetch(`${baseUrl}/api/v1/restaurants/1/debt?month=2026-09`, {
      headers: {
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const { debtSources, waivers } = body.data;

    // Chloe Bennett (EMP-104) has approved waiver for 90 minutes
    const chloeWaiver = waivers.find((w: any) => w.fullName.includes('Chloe Bennett'));
    expect(chloeWaiver).toBeDefined();
    expect(chloeWaiver.minutes).toBe(90);
    expect(chloeWaiver.status).toBe('ACTIVE');

    // Corresponding debt source has waivedMinutes = 90
    const chloeDebt = debtSources.find((d: any) => d.id === chloeWaiver.debtSourceId);
    expect(chloeDebt).toBeDefined();
    expect(chloeDebt.waivedMinutes).toBe(90);
    expect(chloeDebt.hasActiveWaiver).toBe(true);
  });

  it('validates finalize and reopen business rules on payroll periods', async () => {
    // 1. Attempting to reopen open month (2026-09) fails because it is not finalized
    const resOpen = await fetch(`${baseUrl}/api/v1/restaurants/1/payroll/periods/2026-09/reopen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
      body: JSON.stringify({ reason: 'Premature reopen test' }),
    });
    expect(resOpen.status).toBe(400);
    const bodyOpen = await resOpen.json() as any;
    expect(bodyOpen.error.code).toBe('NOT_FINALIZED');

    // 2. Attempting to reopen finalized month (2026-08) without a reason fails schema validation
    const resNoReason = await fetch(`${baseUrl}/api/v1/restaurants/1/payroll/periods/2026-08/reopen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
      body: JSON.stringify({ reason: '' }),
    });
    expect(resNoReason.status).toBe(422);

    // 3. Blockers endpoint correctly identifies affected employees
    const resBlockers = await fetch(`${baseUrl}/api/v1/restaurants/1/payroll/periods/2026-09/blockers`, {
      headers: {
        Cookie: bistroAdminCookie,
        'x-csrf-token': bistroAdminCsrf,
      },
    });
    expect(resBlockers.status).toBe(200);
    const bodyBlockers = await resBlockers.json() as any;
    expect(bodyBlockers.data).toBeDefined();
    expect(typeof bodyBlockers.data.totalBlockersCount).toBe('number');
  });
});


