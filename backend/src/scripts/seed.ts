import path from 'path';
import { pathToFileURL } from 'url';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool, withTransaction } from '../infrastructure/database/pool.js';
import { hashPassword } from '../infrastructure/auth/passwords.js';
import { bootstrapSuperadmin } from './bootstrapSuperadmin.js';
import { PayrollService } from '../modules/payroll/payrollService.js';

export async function seedDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the demo seed when NODE_ENV=production.');
  }

  console.log('--- STARTING DETERMINISTIC SEEDING ---');

  // 1. Ensure Superadmin
  await bootstrapSuperadmin({
    email: 'superadmin@workforce.local',
    fullName: 'Platform Superadmin',
    password: 'SuperAdminPassword123!',
  });

  const [superRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM admin_accounts WHERE email_normalized = 'superadmin@workforce.local'`
  );
  const superadminId = Number(superRows[0]!.id);

  // 2. Seed Restaurant 1: The Grand Bistro
  console.log('Seeding Restaurant: The Grand Bistro...');
  const [bistroExisting] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM restaurants WHERE name = 'The Grand Bistro'`
  );

  let bistroId: number;
  if (!bistroExisting[0]) {
    const [bRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO restaurants 
        (name, contact_name, contact_mobile, contact_email, currency_code, currency_decimal_places, timezone, status, payroll_start_month)
       VALUES ('The Grand Bistro', 'Julian Vance', '+1 (555) 234-5678', 'contact@grandbistro.com', 'USD', 2, 'UTC', 'ACTIVE', '2026-08-01')`
    );
    bistroId = bRes.insertId;
  } else {
    bistroId = Number(bistroExisting[0].id);
  }

  // Administrators for Bistro
  const bistroAdminPass = await hashPassword('BistroAdmin123!');
  const sarahAdminPass = await hashPassword('SarahOps123!');

  await pool.execute(
    `INSERT INTO admin_accounts 
      (restaurant_id, account_kind, full_name, email_normalized, mobile, password_hash, password_setup_required, status, created_by)
     VALUES 
      (?, 'RESTAURANT_ADMIN', 'Julian Vance (General Manager)', 'admin.bistro@workforce.local', '+1 (555) 234-5678', ?, 0, 'ACTIVE', ?),
      (?, 'RESTAURANT_ADMIN', 'Sarah Jenkins (Ops Lead)', 'sarah.ops@workforce.local', '+1 (555) 234-5679', ?, 0, 'ACTIVE', ?)
     ON DUPLICATE KEY UPDATE status = 'ACTIVE'`,
    [bistroId, bistroAdminPass, superadminId, bistroId, sarahAdminPass, superadminId]
  );

  const [bistroAdmins] = await pool.execute<RowDataPacket[]>(
    `SELECT id, email_normalized FROM admin_accounts WHERE restaurant_id = ?`,
    [bistroId]
  );
  const julianAdminId = Number(
    bistroAdmins.find((a) => a.email_normalized === 'admin.bistro@workforce.local')?.id || superadminId
  );

  // Policy Version for Bistro
  const [bistroPolRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM restaurant_policy_versions WHERE restaurant_id = ? AND effective_from_month = '2026-08-01'`,
    [bistroId]
  );
  let bistroPolicyId: number;
  if (!bistroPolRows[0]) {
    const [polRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO restaurant_policy_versions 
        (restaurant_id, effective_from_month, revision_no, salary_working_day_divisor, standard_daily_minutes, overtime_multiplier, late_grace_minutes, late_deduction_percentage, warning_threshold, custom_warnings_count_by_default, reason, created_by)
       VALUES (?, '2026-08-01', 1, 26, 480, 1.5000, 10, 10.0000, 3, 1, 'Initial operational policy: 26 divisor, 10m grace, 10% late penalty', ?)`,
      [bistroId, julianAdminId]
    );
    bistroPolicyId = polRes.insertId;
  } else {
    bistroPolicyId = Number(bistroPolRows[0].id);
  }

  // Positions for Bistro
  const bistroPositions = [
    'Head Chef',
    'Sous Chef',
    'Line Cook',
    'Floor Captain',
    'Waiter',
    'Cashier',
    'Dishwasher',
  ];

  const positionIdMap = new Map<string, number>();
  for (const posTitle of bistroPositions) {
    await pool.execute(
      `INSERT INTO positions (restaurant_id, name, status, created_by)
       VALUES (?, ?, 'ACTIVE', ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'ACTIVE'`,
      [bistroId, posTitle, julianAdminId]
    );
    const [pRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM positions WHERE restaurant_id = ? AND name = ?`,
      [bistroId, posTitle]
    );
    positionIdMap.set(posTitle, Number(pRows[0]!.id));
  }

  // Deduction Types for Bistro
  const bistroDeductions = [
    { name: 'Uniform Deposit', method: 'FIXED', val: 8.0 },
    { name: 'Register Shortfall', method: 'FIXED', val: 15.0 },
    { name: 'Equipment Breakage', method: 'FIXED', val: 20.0 },
  ];
  const deductionIdMap = new Map<string, number>();
  for (const dt of bistroDeductions) {
    await pool.execute(
      `INSERT INTO deduction_types (restaurant_id, name, calculation_method, default_value, status, created_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'ACTIVE'`,
      [bistroId, dt.name, dt.method, dt.val, julianAdminId]
    );
    const [dRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM deduction_types WHERE restaurant_id = ? AND name = ?`,
      [bistroId, dt.name]
    );
    deductionIdMap.set(dt.name, Number(dRows[0]!.id));
  }

  // Shift Templates for Bistro
  const [tmplRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, name FROM shift_templates WHERE restaurant_id = ?`,
    [bistroId]
  );
  let morningTemplateId: number;
  let eveningTemplateId: number;
  let splitTemplateId: number;

  if (tmplRows.length === 0) {
    // 1. Morning Shift (08:00 - 16:30, 30m break, 480 required)
    const [mRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO shift_templates (restaurant_id, name, status, created_by)
       VALUES (?, 'Morning Shift', 'ACTIVE', ?)`,
      [bistroId, julianAdminId]
    );
    morningTemplateId = mRes.insertId;
    await pool.execute(
      `INSERT INTO shift_template_intervals (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
       VALUES (?, ?, 1, '08:00:00', 0, '16:30:00', 0, 30)`,
      [bistroId, morningTemplateId]
    );

    // 2. Evening Shift (16:00 - 00:30, 30m break, 480 required)
    const [eRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO shift_templates (restaurant_id, name, status, created_by)
       VALUES (?, 'Evening Shift', 'ACTIVE', ?)`,
      [bistroId, julianAdminId]
    );
    eveningTemplateId = eRes.insertId;
    await pool.execute(
      `INSERT INTO shift_template_intervals (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
       VALUES (?, ?, 1, '16:00:00', 0, '00:30:00', 1, 30)`,
      [bistroId, eveningTemplateId]
    );

    // 3. Split Shift (10:00-14:00 and 18:00-22:00, 480 required)
    const [sRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO shift_templates (restaurant_id, name, status, created_by)
       VALUES (?, 'Split Lunch/Dinner', 'ACTIVE', ?)`,
      [bistroId, julianAdminId]
    );
    splitTemplateId = sRes.insertId;
    await pool.execute(
      `INSERT INTO shift_template_intervals (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
       VALUES 
        (?, ?, 1, '10:00:00', 0, '14:00:00', 0, 0),
        (?, ?, 2, '18:00:00', 0, '22:00:00', 0, 0)`,
      [bistroId, splitTemplateId, bistroId, splitTemplateId]
    );
  } else {
    morningTemplateId = Number(tmplRows.find((t) => t.name === 'Morning Shift')?.id || tmplRows[0]!.id);
    eveningTemplateId = Number(tmplRows.find((t) => t.name === 'Evening Shift')?.id || tmplRows[0]!.id);
    splitTemplateId = Number(tmplRows.find((t) => t.name === 'Split Lunch/Dinner')?.id || tmplRows[0]!.id);
  }

  // Employees for Bistro
  const bistroEmployees = [
    {
      num: 'EMP-101',
      fullName: 'Marcus Vance',
      mobile: '+1 (555) 101-0001',
      position: 'Line Cook',
      startDate: '2026-08-01',
      status: 'ACTIVE',
      baseSalary: '1040.00',
    },
    {
      num: 'EMP-102',
      fullName: 'Elena Gomez',
      mobile: '+1 (555) 102-0002',
      position: 'Sous Chef',
      startDate: '2026-08-01',
      status: 'ACTIVE',
      baseSalary: '1820.00',
    },
    {
      num: 'EMP-103',
      fullName: 'David Kim',
      mobile: '+1 (555) 103-0003',
      position: 'Waiter',
      startDate: '2026-08-01',
      status: 'ACTIVE',
      baseSalary: '780.00',
    },
    {
      num: 'EMP-104',
      fullName: 'Chloe Bennett',
      mobile: '+1 (555) 104-0004',
      position: 'Cashier',
      startDate: '2026-08-01',
      status: 'ACTIVE',
      baseSalary: '650.00',
    },
    {
      num: 'EMP-105',
      fullName: "Liam O'Connor",
      mobile: '+1 (555) 105-0005',
      position: 'Dishwasher',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      status: 'INACTIVE',
      baseSalary: '520.00',
    },
  ];

  const employeeIdMap = new Map<string, number>();

  for (const emp of bistroEmployees) {
    const posId = positionIdMap.get(emp.position)!;
    await pool.execute(
      `INSERT INTO employees 
        (restaurant_id, employee_number, full_name, mobile, position_id, employment_start_date, employment_end_date, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
        full_name = VALUES(full_name),
        mobile = VALUES(mobile),
        position_id = VALUES(position_id),
        status = VALUES(status)`,
      [
        bistroId,
        emp.num,
        emp.fullName,
        emp.mobile,
        posId,
        emp.startDate,
        emp.endDate || null,
        emp.status,
        julianAdminId,
      ]
    );

    const [eRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM employees WHERE restaurant_id = ? AND employee_number = ?`,
      [bistroId, emp.num]
    );
    const empId = Number(eRows[0]!.id);
    employeeIdMap.set(emp.fullName, empId);

    // Salary version
    const [existingSal] = await pool.execute<RowDataPacket[]>(
      `SELECT id FROM employee_salary_versions WHERE restaurant_id = ? AND employee_id = ? AND effective_from_month = '2026-08-01'`,
      [bistroId, empId]
    );
    if (!existingSal[0]) {
      await pool.execute(
        `INSERT INTO employee_salary_versions 
          (restaurant_id, employee_id, effective_from_month, revision_no, monthly_salary, reason, created_by)
         VALUES (?, ?, '2026-08-01', 1, ?, 'Initial contract salary', ?)`,
        [bistroId, empId, emp.baseSalary, julianAdminId]
      );
    }
  }

  const marcusId = employeeIdMap.get('Marcus Vance')!;
  const elenaId = employeeIdMap.get('Elena Gomez')!;
  const davidId = employeeIdMap.get('David Kim')!;
  const chloeId = employeeIdMap.get('Chloe Bennett')!;

  // 3. Historical Finalized Month: August 2026 (2026-08)
  console.log('Seeding August 2026 Historical Payroll...');
  await pool.execute(
    `INSERT INTO payroll_periods (restaurant_id, month_start, status, source_revision)
     VALUES (?, '2026-08-01', 'DRAFT', 1)
     ON DUPLICATE KEY UPDATE status = status`,
    [bistroId]
  );

  // Setup August schedule and attendance for Marcus Vance (creates 120m opening debt carried into Sept)
  for (let d = 1; d <= 26; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    const workDate = `2026-08-${dayStr}`;

    const [sdRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO schedule_days 
        (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by)
       VALUES (?, ?, ?, '2026-08-01', 'WORK', ?, ?, 480, 'UTC', ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, marcusId, workDate, morningTemplateId, bistroPolicyId, julianAdminId]
    );
    const schedDayId = sdRes.insertId;

    await pool.execute(
      `INSERT INTO schedule_intervals 
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES (?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
       ON DUPLICATE KEY UPDATE sequence_number = sequence_number`,
      [bistroId, marcusId, schedDayId]
    );

    const isShortfallDay = d === 25;
    const [adRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_days 
        (restaurant_id, employee_id, schedule_day_id, work_date, status, additional_work_approved, created_by)
       VALUES (?, ?, ?, ?, 'COMPLETED', 0, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, marcusId, schedDayId, workDate, julianAdminId]
    );
    const attDayId = adRes.insertId;

    if (isShortfallDay) {
      // Worked 360 mins (shortfall 120 mins)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 14:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 14:30:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
      // Hour Debt Source
      const [existingHds] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
        [bistroId, attDayId]
      );
      if (!existingHds[0]) {
        await pool.execute(
          `INSERT INTO hour_debt_sources 
            (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
           VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
          [bistroId, marcusId, attDayId, workDate]
        );
      }
    } else {
      // Full 480 mins worked
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 16:30:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
    }
  }

  // Calculate and Finalize August 2026
  const [augPeriod] = await pool.execute<RowDataPacket[]>(
    `SELECT id, status FROM payroll_periods WHERE restaurant_id = ? AND month_start = '2026-08-01'`,
    [bistroId]
  );
  if (!augPeriod[0] || augPeriod[0].status !== 'FINALIZED') {
    console.log('Calculating and finalizing August 2026...');
    const augRunId = await PayrollService.executeCalculationRun(String(bistroId), '2026-08', String(julianAdminId));

    await withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE payroll_periods 
         SET status = 'FINALIZED',
             active_finalized_run_id = ?,
             current_calculation_run_id = ?,
             finalized_by = ?,
             finalized_at = '2026-08-31 23:59:59',
             row_version = row_version + 1
         WHERE restaurant_id = ? AND month_start = '2026-08-01'`,
        [augRunId, augRunId, julianAdminId, bistroId]
      );
      await conn.execute(
        `INSERT INTO payroll_period_events 
          (restaurant_id, payroll_period_id, calculation_run_id, event_type, actor_id, reason)
         VALUES (?, ?, ?, 'FINALIZED', ?, 'Monthly payroll finalization')`,
        [bistroId, augPeriod[0]!.id, augRunId, julianAdminId]
      );
    });
  } else {
    console.log('August 2026 is already finalized. Skipping calculation.');
  }

  // 4. Open Active Month: September 2026 (2026-09)
  console.log('Seeding September 2026 Open Payroll & Benchmark Fixture...');
  await pool.execute(
    `INSERT INTO payroll_periods (restaurant_id, month_start, status, source_revision)
     VALUES (?, '2026-09-01', 'DRAFT', 1)
     ON DUPLICATE KEY UPDATE status = status`,
    [bistroId]
  );

  // ==========================================
  // BENCHMARK FIXTURE: Marcus Vance (2026-09)
  // Base Salary: $1,040.00
  // Opening Debt: 120 mins
  // Day 1 (2026-09-01): 35m late -> 25m penalty > 10m grace -> Warning 1 + 10% daily late deduction ($4.00), worked 270m -> 210m shortfall.
  // Day 2 (2026-09-02): 25m late -> 15m penalty > 10m grace -> Warning 2 + 10% daily late deduction ($4.00), worked 480m.
  // Day 3 (2026-09-03): 20m late -> 10m penalty > 10m grace -> Warning 3 (THRESHOLD 3 MET!) + 10% daily late deduction ($4.00), worked 480m.
  // Day 4 (2026-09-04): Worked 780m (300 additional mins, approved).
  //   DEBT BEFORE OVERTIME: Recovered = min(330, 300) = 300 mins. Remaining Debt = 30 mins.
  // Day 5 (2026-09-05): Worked 960m (480 additional mins, approved).
  //   DEBT BEFORE OVERTIME: Recovered = min(30, 480) = 30 mins. Remaining Debt = 0.
  //   Overtime minutes = 480 - 30 = 450 minutes (7.5 hours)!
  //   Overtime Pay = 7.5 * ($1040 / 208) * 1.50 = 7.5 * $5.00 * 1.50 = $56.25!
  // Days 6-26: Standard completed 480m days on time.
  // Salary Adjustments: Uniform Deposit deduction = $8.00.
  // Net Salary = 1040 + 56.25 - 12.00 - 8.00 = $1,076.25!
  // ==========================================

  for (let d = 1; d <= 26; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    const workDate = `2026-09-${dayStr}`;

    const [sdRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO schedule_days 
        (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by)
       VALUES (?, ?, ?, '2026-09-01', 'WORK', ?, ?, 480, 'UTC', ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, marcusId, workDate, morningTemplateId, bistroPolicyId, julianAdminId]
    );
    const schedDayId = sdRes.insertId;

    await pool.execute(
      `INSERT INTO schedule_intervals 
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES (?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
       ON DUPLICATE KEY UPDATE sequence_number = sequence_number`,
      [bistroId, marcusId, schedDayId]
    );

    const isAdditionalApproved = d === 4 || d === 5;
    const [adRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_days 
        (restaurant_id, employee_id, schedule_day_id, work_date, status, additional_work_approved, created_by)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, marcusId, schedDayId, workDate, isAdditionalApproved ? 1 : 0, julianAdminId]
    );
    const attDayId = adRes.insertId;

    if (d === 1) {
      // Arrived 08:35 (35m late), worked 270m (08:35 to 13:35 with 30m break = 270m)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:35:00', '${workDate} 13:35:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 13:35:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
      // Warning 1
      await pool.execute(
        `INSERT INTO warnings 
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, created_by)
         VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival', 'Arrived 35 minutes late (grace period: 10 mins)', 35, 1, 1, ?)
         ON DUPLICATE KEY UPDATE late_minutes = 35`,
        [bistroId, marcusId, attDayId, workDate, julianAdminId]
      );
      // Hour Debt Source for 210m shortfall
      const [existingHds1] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
        [bistroId, attDayId]
      );
      if (!existingHds1[0]) {
        await pool.execute(
          `INSERT INTO hour_debt_sources 
            (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
           VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
          [bistroId, marcusId, attDayId, workDate]
        );
      }
    } else if (d === 2) {
      // Arrived 08:25 (25m late), worked 480m (08:25 to 16:55 with 30m break)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:25:00', '${workDate} 16:55:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 16:55:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
      // Warning 2
      await pool.execute(
        `INSERT INTO warnings 
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, created_by)
         VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival', 'Arrived 25 minutes late (grace period: 10 mins)', 25, 1, 1, ?)
         ON DUPLICATE KEY UPDATE late_minutes = 25`,
        [bistroId, marcusId, attDayId, workDate, julianAdminId]
      );
    } else if (d === 3) {
      // Arrived 08:20 (20m late), worked 480m (08:20 to 16:50 with 30m break)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:20:00', '${workDate} 16:50:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 16:50:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
      // Warning 3 (3rd warning triggers threshold)
      await pool.execute(
        `INSERT INTO warnings 
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, created_by)
         VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival (Threshold Met)', 'Arrived 20 minutes late (grace period: 10 mins)', 20, 1, 1, ?)
         ON DUPLICATE KEY UPDATE late_minutes = 20`,
        [bistroId, marcusId, attDayId, workDate, julianAdminId]
      );
    } else if (d === 4) {
      // Worked 780m (08:00 to 21:30 with 30m break = 780m)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 21:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 21:30:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
    } else if (d === 5) {
      // Worked 960m (08:00 to next day 00:30 with 30m break = 960m)
      const nextDayStr = (d + 1) < 10 ? `0${d + 1}` : `${d + 1}`;
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '2026-09-${nextDayStr} 00:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '2026-09-${nextDayStr} 00:30:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
    } else {
      // On-time 480m
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 16:30:00'`,
        [bistroId, marcusId, schedDayId, attDayId]
      );
    }
  }

  // Uniform Deposit adjustment for Marcus Vance ($8.00)
  const uniformDeductionId = deductionIdMap.get('Uniform Deposit')!;
  const [existingUniAdj] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM salary_adjustments WHERE restaurant_id = ? AND employee_id = ? AND payroll_month = '2026-09-01' AND status = 'ACTIVE'`,
    [bistroId, marcusId]
  );
  if (!existingUniAdj[0]) {
    await pool.execute(
      `INSERT INTO salary_adjustments 
        (restaurant_id, employee_id, payroll_month, work_date, category, direction, deduction_type_id, calculation_method, adjustment_value, reason, status, created_by)
       VALUES (?, ?, '2026-09-01', '2026-09-01', 'DEDUCTION', 'DECREASE', ?, 'FIXED', 8.00, 'Uniform Deposit (New apron & chef coat)', 'ACTIVE', ?)`,
      [bistroId, marcusId, uniformDeductionId, julianAdminId]
    );
  }

  // Seed David Kim in September 2026:
  // 4 warnings (3 late + 1 custom warning) -> Red Warning Indicator 🔴 4/3 Limit Exceeded!
  // Shortfall of 60 mins -> Active hour debt
  console.log('Seeding David Kim (Warning Limit Exceeded fixture)...');
  for (let d = 1; d <= 26; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    const workDate = `2026-09-${dayStr}`;

    const [sdRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO schedule_days 
        (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by)
       VALUES (?, ?, ?, '2026-09-01', 'WORK', ?, ?, 480, 'UTC', ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, davidId, workDate, eveningTemplateId, bistroPolicyId, julianAdminId]
    );
    const schedDayId = sdRes.insertId;

    const nextDayStr = (d + 1) < 10 ? `0${d + 1}` : `${d + 1}`;
    await pool.execute(
      `INSERT INTO schedule_intervals 
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES (?, ?, ?, 1, '${workDate} 16:00:00', '2026-09-${nextDayStr} 00:30:00', 30)
       ON DUPLICATE KEY UPDATE sequence_number = sequence_number`,
      [bistroId, davidId, schedDayId]
    );

    const [adRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_days 
        (restaurant_id, employee_id, schedule_day_id, work_date, status, additional_work_approved, created_by)
       VALUES (?, ?, ?, ?, 'COMPLETED', 0, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, davidId, schedDayId, workDate, julianAdminId]
    );
    const attDayId = adRes.insertId;

    if (d === 1 || d === 2 || d === 3) {
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 16:25:00', '2026-09-${nextDayStr} 00:55:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '2026-09-${nextDayStr} 00:55:00'`,
        [bistroId, davidId, schedDayId, attDayId]
      );
      await pool.execute(
        `INSERT INTO warnings 
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, created_by)
         VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival', 'Late arrival by 25 mins', 25, 1, 1, ?)
         ON DUPLICATE KEY UPDATE late_minutes = 25`,
        [bistroId, davidId, attDayId, workDate, julianAdminId]
      );
    } else if (d === 10) {
      // 60m shortfall
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 16:00:00', '${workDate} 23:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 23:30:00'`,
        [bistroId, davidId, schedDayId, attDayId]
      );
      const [existingHdsD] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
        [bistroId, attDayId]
      );
      if (!existingHdsD[0]) {
        await pool.execute(
          `INSERT INTO hour_debt_sources 
            (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
           VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
          [bistroId, davidId, attDayId, workDate]
        );
      }
    } else {
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 16:00:00', '2026-09-${nextDayStr} 00:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '2026-09-${nextDayStr} 00:30:00'`,
        [bistroId, davidId, schedDayId, attDayId]
      );
    }
  }

  // Custom warning for David Kim (Cell phone use on floor)
  const [existingCustWarn] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM warnings WHERE restaurant_id = ? AND employee_id = ? AND origin = 'CUSTOM' AND incident_date = '2026-09-05'`,
    [bistroId, davidId]
  );
  if (!existingCustWarn[0]) {
    await pool.execute(
      `INSERT INTO warnings 
        (restaurant_id, employee_id, origin, incident_date, title, reason, counts_toward_limit, created_by)
       VALUES (?, ?, 'CUSTOM', '2026-09-05', 'Cell phone use on floor', 'Observed using phone at service station during 8 PM rush', 1, ?)`,
      [bistroId, davidId, julianAdminId]
    );
  }

  // Seed Chloe Bennett in September 2026 (Waiver fixture):
  console.log('Seeding Chloe Bennett (Approved Debt Waiver fixture)...');
  for (let d = 1; d <= 26; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    const workDate = `2026-09-${dayStr}`;

    const [sdRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO schedule_days 
        (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by)
       VALUES (?, ?, ?, '2026-09-01', 'WORK', ?, ?, 480, 'UTC', ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, chloeId, workDate, morningTemplateId, bistroPolicyId, julianAdminId]
    );
    const schedDayId = sdRes.insertId;

    await pool.execute(
      `INSERT INTO schedule_intervals 
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES (?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
       ON DUPLICATE KEY UPDATE sequence_number = sequence_number`,
      [bistroId, chloeId, schedDayId]
    );

    const [adRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_days 
        (restaurant_id, employee_id, schedule_day_id, work_date, status, additional_work_approved, created_by)
       VALUES (?, ?, ?, ?, 'COMPLETED', 0, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, chloeId, schedDayId, workDate, julianAdminId]
    );
    const attDayId = adRes.insertId;

    if (d === 8) {
      // 90m shortfall
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 15:00:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 15:00:00'`,
        [bistroId, chloeId, schedDayId, attDayId]
      );
      let debtSourceId: number;
      const [existingHdsC] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
        [bistroId, attDayId]
      );
      if (!existingHdsC[0]) {
        const [hdsRes] = await pool.execute<ResultSetHeader>(
          `INSERT INTO hour_debt_sources 
            (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
           VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
          [bistroId, chloeId, attDayId, workDate]
        );
        debtSourceId = hdsRes.insertId;
      } else {
        debtSourceId = Number(existingHdsC[0].id);
      }

      // Add Waiver if not exists
      const [existingWaiver] = await pool.execute<RowDataPacket[]>(
        `SELECT id FROM debt_waivers WHERE restaurant_id = ? AND debt_source_id = ?`,
        [bistroId, debtSourceId]
      );
      if (!existingWaiver[0]) {
        await pool.execute(
          `INSERT INTO debt_waivers 
            (restaurant_id, employee_id, debt_source_id, effective_month, minutes, reason, created_by)
           VALUES (?, ?, ?, '2026-09-01', 90, 'Medical appointment with verified doctor note', ?)`,
          [bistroId, chloeId, debtSourceId, julianAdminId]
        );
      }
    } else {
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, 1, '${workDate} 08:00:00', '${workDate} 16:30:00', 30)
         ON DUPLICATE KEY UPDATE check_out_at = '${workDate} 16:30:00'`,
        [bistroId, chloeId, schedDayId, attDayId]
      );
    }
  }

  // Seed Elena Gomez in September 2026 (Clean high-performer with overtime)
  for (let d = 1; d <= 26; d++) {
    const dayStr = d < 10 ? `0${d}` : `${d}`;
    const workDate = `2026-09-${dayStr}`;

    const [sdRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO schedule_days 
        (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by)
       VALUES (?, ?, ?, '2026-09-01', 'WORK', ?, ?, 480, 'UTC', ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, elenaId, workDate, splitTemplateId, bistroPolicyId, julianAdminId]
    );
    const schedDayId = sdRes.insertId;

    await pool.execute(
      `INSERT INTO schedule_intervals 
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES 
        (?, ?, ?, 1, '${workDate} 10:00:00', '${workDate} 14:00:00', 0),
        (?, ?, ?, 2, '${workDate} 18:00:00', '${workDate} 22:00:00', 0)
       ON DUPLICATE KEY UPDATE sequence_number = sequence_number`,
      [bistroId, elenaId, schedDayId, bistroId, elenaId, schedDayId]
    );

    const isExtra = d === 12;
    const [adRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_days 
        (restaurant_id, employee_id, schedule_day_id, work_date, status, additional_work_approved, created_by)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [bistroId, elenaId, schedDayId, workDate, isExtra ? 1 : 0, julianAdminId]
    );
    const attDayId = adRes.insertId;

    if (isExtra) {
      // 120 extra minutes (2 hours OT)
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES 
          (?, ?, ?, ?, 1, '${workDate} 10:00:00', '${workDate} 14:00:00', 0),
          (?, ?, ?, ?, 2, '${workDate} 18:00:00', '2026-09-${d < 9 ? '0' + (d + 1) : d + 1} 00:00:00', 0)
         ON DUPLICATE KEY UPDATE check_out_at = VALUES(check_out_at)`,
        [bistroId, elenaId, schedDayId, attDayId, bistroId, elenaId, schedDayId, attDayId]
      );
    } else {
      await pool.execute(
        `INSERT INTO attendance_intervals 
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES 
          (?, ?, ?, ?, 1, '${workDate} 10:00:00', '${workDate} 14:00:00', 0),
          (?, ?, ?, ?, 2, '${workDate} 18:00:00', '${workDate} 22:00:00', 0)
         ON DUPLICATE KEY UPDATE check_out_at = VALUES(check_out_at)`,
        [bistroId, elenaId, schedDayId, attDayId, bistroId, elenaId, schedDayId, attDayId]
      );
    }
  }

  // Calculate September 2026 so provisional results are calculated!
  console.log('Calculating September 2026 for The Grand Bistro...');
  await PayrollService.executeCalculationRun(String(bistroId), '2026-09', String(julianAdminId));

  // 5. Seed Restaurant 2: Spice Garden (SAR currency, Asia/Riyadh timezone)
  console.log('Seeding Restaurant: Spice Garden...');
  const [spiceExisting] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM restaurants WHERE name = 'Spice Garden'`
  );

  let spiceId: number;
  if (!spiceExisting[0]) {
    const [sRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO restaurants 
        (name, contact_name, contact_mobile, contact_email, currency_code, currency_decimal_places, timezone, status, payroll_start_month)
       VALUES ('Spice Garden', 'Tariq Al-Mansoor', '+966 50 123 4567', 'admin@spicegarden.sa', 'SAR', 2, 'Asia/Riyadh', 'ACTIVE', '2026-09-01')`
    );
    spiceId = sRes.insertId;
  } else {
    spiceId = Number(spiceExisting[0].id);
  }

  const spiceAdminPass = await hashPassword('SpiceAdmin123!');
  await pool.execute(
    `INSERT INTO admin_accounts 
      (restaurant_id, account_kind, full_name, email_normalized, mobile, password_hash, password_setup_required, status, created_by)
     VALUES (?, 'RESTAURANT_ADMIN', 'Tariq Al-Mansoor', 'admin.spice@workforce.local', '+966 50 123 4567', ?, 0, 'ACTIVE', ?)
     ON DUPLICATE KEY UPDATE status = 'ACTIVE'`,
    [spiceId, spiceAdminPass, superadminId]
  );

  const [spiceAdmins] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM admin_accounts WHERE restaurant_id = ? AND email_normalized = 'admin.spice@workforce.local'`,
    [spiceId]
  );
  const tariqAdminId = Number(spiceAdmins[0]?.id || superadminId);

  const [spicePolRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM restaurant_policy_versions WHERE restaurant_id = ? AND effective_from_month = '2026-09-01'`,
    [spiceId]
  );
  let spicePolicyId: number;
  if (!spicePolRows[0]) {
    const [pRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO restaurant_policy_versions 
        (restaurant_id, effective_from_month, revision_no, salary_working_day_divisor, standard_daily_minutes, overtime_multiplier, late_grace_minutes, late_deduction_percentage, warning_threshold, custom_warnings_count_by_default, reason, created_by)
       VALUES (?, '2026-09-01', 1, 30, 480, 1.2500, 15, 5.0000, 2, 1, 'Standard Saudi Labor Law Policy: 30 divisor, 15m grace, 5% late penalty', ?)`,
      [spiceId, tariqAdminId]
    );
    spicePolicyId = pRes.insertId;
  } else {
    spicePolicyId = Number(spicePolRows[0].id);
  }

  // Spice Garden Positions
  await pool.execute(
    `INSERT INTO positions (restaurant_id, name, status, created_by)
     VALUES (?, 'Executive Chef', 'ACTIVE', ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [spiceId, tariqAdminId]
  );
  const [sgPosRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM positions WHERE restaurant_id = ? AND name = 'Executive Chef'`,
    [spiceId]
  );
  const spiceChefPosId = Number(sgPosRows[0]!.id);

  // Spice Garden Shift Template
  const [sgTmplRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM shift_templates WHERE restaurant_id = ? AND name = 'Main Shift'`,
    [spiceId]
  );
  let spiceMainTmplId: number;
  if (!sgTmplRows[0]) {
    const [sgTmpl] = await pool.execute<ResultSetHeader>(
      `INSERT INTO shift_templates (restaurant_id, name, status, created_by)
       VALUES (?, 'Main Shift', 'ACTIVE', ?)`,
      [spiceId, tariqAdminId]
    );
    spiceMainTmplId = sgTmpl.insertId;
    await pool.execute(
      `INSERT INTO shift_template_intervals (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
       VALUES (?, ?, 1, '09:00:00', 0, '17:30:00', 0, 30)`,
      [spiceId, spiceMainTmplId]
    );
  } else {
    spiceMainTmplId = Number(sgTmplRows[0].id);
  }

  // Spice Garden Employee
  await pool.execute(
    `INSERT INTO employees 
      (restaurant_id, employee_number, full_name, mobile, position_id, employment_start_date, status, created_by)
     VALUES (?, 'SG-001', 'Zaid Al-Harbi', '+966 55 987 6543', ?, '2026-09-01', 'ACTIVE', ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
    [spiceId, spiceChefPosId, tariqAdminId]
  );
  const [sgEmpRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM employees WHERE restaurant_id = ? AND employee_number = 'SG-001'`,
    [spiceId]
  );
  const zaidId = Number(sgEmpRows[0]!.id);

  const [existingSgSal] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM employee_salary_versions WHERE restaurant_id = ? AND employee_id = ? AND effective_from_month = '2026-09-01'`,
    [spiceId, zaidId]
  );
  if (!existingSgSal[0]) {
    await pool.execute(
      `INSERT INTO employee_salary_versions 
        (restaurant_id, employee_id, effective_from_month, revision_no, monthly_salary, reason, created_by)
       VALUES (?, ?, '2026-09-01', 1, 4500.00, 'Executive contract', ?)`,
      [spiceId, zaidId, tariqAdminId]
    );
  }

  await pool.execute(
    `INSERT INTO payroll_periods (restaurant_id, month_start, status, source_revision)
     VALUES (?, '2026-09-01', 'DRAFT', 1)
     ON DUPLICATE KEY UPDATE status = status`,
    [spiceId]
  );

  console.log('Calculating September 2026 for Spice Garden...');
  await PayrollService.executeCalculationRun(String(spiceId), '2026-09', String(tariqAdminId));

  console.log('--- DETERMINISTIC SEEDING COMPLETED SUCCESSFULLY ---');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  seedDatabase()
    .then(() => {
      console.log('Seed process finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal error during database seeding:', err);
      process.exit(1);
    });
}
