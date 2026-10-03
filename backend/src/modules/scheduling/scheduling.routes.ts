import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { bulkScheduleSchema, batchScheduleSchema, updateScheduleDaySchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';
import { assertRangeNotFinalized, bumpSourceRevision, normalizeMonthStart } from '../configuration/periodGuards.js';

export const schedulingRouter = Router({ mergeParams: true });

type Db = PoolConnection | Pool;

const MAX_RANGE_DAYS = 62;
const MAX_EMPLOYEES = 200;
const MAX_SLOTS = 5000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SQL_DT = 'yyyy-MM-dd HH:mm:ss.SSS';

interface PlannedInterval {
  sequenceNumber: number;
  start: DateTime;
  end: DateTime;
  breakMinutes: number;
}

interface TemplateIntervalRow {
  sequence_number: number;
  start_local_time: string;
  start_day_offset: number;
  end_local_time: string;
  end_day_offset: number;
  planned_unpaid_break_minutes: number;
}

function assertIsoDate(value: string, field: string): DateTime {
  const dt = ISO_DATE_RE.test(value) ? DateTime.fromISO(value, { zone: 'utc' }) : DateTime.invalid('bad format');
  if (!dt.isValid) throw new AppError(422, 'INVALID_DATE', `${field} must be a valid YYYY-MM-DD date`);
  return dt;
}

function assertValidTimezone(tz: unknown): string {
  const zone = typeof tz === 'string' ? tz : '';
  if (!zone || !DateTime.now().setZone(zone).isValid) {
    throw new AppError(422, 'INVALID_TIMEZONE', 'The restaurant timezone is not a valid IANA timezone');
  }
  return zone;
}

async function getTimezone(db: Db, restaurantId: string): Promise<string> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT timezone FROM restaurants WHERE id = ?`, [restaurantId]);
  if (!rows[0]) throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
  return assertValidTimezone(rows[0].timezone);
}

/** Policy in force for a payroll month: latest effective_from_month <= month, highest revision. */
async function getPolicyVersionId(db: Db, restaurantId: string, monthStart: string): Promise<string> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT id FROM restaurant_policy_versions
     WHERE restaurant_id = ? AND effective_from_month <= ?
     ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
    [restaurantId, monthStart]
  );
  if (!rows[0]) {
    throw new AppError(422, 'NO_POLICY_CONFIGURED', `No effective policy found for ${monthStart.slice(0, 7)}`);
  }
  return String(rows[0].id);
}

/** Validates planned intervals and returns them sorted plus the paid (required) minutes. */
function validatePlannedIntervals(intervals: PlannedInterval[]): { sorted: PlannedInterval[]; requiredMinutes: number } {
  if (intervals.length === 0) {
    throw new AppError(422, 'INVALID_INTERVAL', 'A WORK day needs at least one interval');
  }
  const seen = new Set<number>();
  let requiredMinutes = 0;
  for (const iv of intervals) {
    if (seen.has(iv.sequenceNumber)) {
      throw new AppError(422, 'INVALID_INTERVAL', `Duplicate interval sequenceNumber ${iv.sequenceNumber}`);
    }
    seen.add(iv.sequenceNumber);
    const dur = Math.round(iv.end.diff(iv.start, 'minutes').minutes);
    if (dur <= 0) {
      throw new AppError(422, 'INVALID_INTERVAL', `Interval ${iv.sequenceNumber}: end must be after start`);
    }
    if (iv.breakMinutes >= dur) {
      throw new AppError(422, 'INVALID_INTERVAL', `Interval ${iv.sequenceNumber}: unpaid break must be shorter than the interval`);
    }
    requiredMinutes += dur - iv.breakMinutes;
  }
  const sorted = [...intervals].sort((a, b) => a.start.toMillis() - b.start.toMillis());
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start.toMillis() < sorted[i - 1]!.end.toMillis()) {
      throw new AppError(422, 'INVALID_INTERVAL', 'Intervals must not overlap');
    }
  }
  if (requiredMinutes <= 0 || requiredMinutes > 1440) {
    throw new AppError(422, 'INVALID_INTERVAL', 'Required minutes for a WORK day must be between 1 and 1440');
  }
  return { sorted, requiredMinutes };
}

function parseClientInterval(
  inv: { sequenceNumber: number; plannedStartAt: string; plannedEndAt: string; plannedUnpaidBreakMinutes: number },
  zone: string
): PlannedInterval {
  const parse = (v: string, field: string): DateTime => {
    const dt = DateTime.fromISO(v, { zone });
    if (!dt.isValid) throw new AppError(422, 'INVALID_INTERVAL', `${field} is not a valid ISO datetime`);
    if (dt.second !== 0 || dt.millisecond !== 0) {
      throw new AppError(422, 'INVALID_INTERVAL', `${field} must have zero seconds`);
    }
    return dt;
  };
  return {
    sequenceNumber: inv.sequenceNumber,
    start: parse(inv.plannedStartAt, `Interval ${inv.sequenceNumber} plannedStartAt`),
    end: parse(inv.plannedEndAt, `Interval ${inv.sequenceNumber} plannedEndAt`),
    breakMinutes: inv.plannedUnpaidBreakMinutes,
  };
}

function buildTemplateIntervals(dateStr: string, zone: string, rows: TemplateIntervalRow[]): PlannedInterval[] {
  return rows.map((r) => {
    const base = DateTime.fromISO(dateStr, { zone });
    const [sh, sm] = String(r.start_local_time).split(':').map(Number);
    const [eh, em] = String(r.end_local_time).split(':').map(Number);
    return {
      sequenceNumber: Number(r.sequence_number),
      start: base.plus({ days: Number(r.start_day_offset) }).set({ hour: sh, minute: sm, second: 0, millisecond: 0 }),
      end: base.plus({ days: Number(r.end_day_offset) }).set({ hour: eh, minute: em, second: 0, millisecond: 0 }),
      breakMinutes: Number(r.planned_unpaid_break_minutes),
    };
  });
}

async function insertIntervals(
  conn: PoolConnection,
  restaurantId: string,
  employeeId: string,
  scheduleDayId: string,
  intervals: PlannedInterval[]
): Promise<void> {
  for (const iv of intervals) {
    await conn.execute(
      `INSERT INTO schedule_intervals
        (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        restaurantId,
        employeeId,
        scheduleDayId,
        iv.sequenceNumber,
        iv.start.toUTC().toFormat(SQL_DT),
        iv.end.toUTC().toFormat(SQL_DT),
        iv.breakMinutes,
      ]
    );
  }
}

async function loadTemplate(
  db: Db,
  restaurantId: string,
  templateId: string,
  requireActive: boolean
): Promise<{ name: string; intervals: TemplateIntervalRow[] }> {
  if (!/^\d+$/.test(templateId)) throw new AppError(422, 'TEMPLATE_NOT_FOUND', 'Shift template not found');
  const [tRows] = await db.execute<RowDataPacket[]>(
    `SELECT name, status FROM shift_templates WHERE restaurant_id = ? AND id = ?`,
    [restaurantId, templateId]
  );
  if (!tRows[0]) throw new AppError(422, 'TEMPLATE_NOT_FOUND', 'Shift template not found');
  if (requireActive && tRows[0].status !== 'ACTIVE') {
    throw new AppError(422, 'TEMPLATE_INACTIVE', 'Shift template is inactive');
  }
  const [invRows] = await db.execute<RowDataPacket[]>(
    `SELECT sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes
     FROM shift_template_intervals
     WHERE restaurant_id = ? AND shift_template_id = ?
     ORDER BY sequence_number ASC`,
    [restaurantId, templateId]
  );
  return { name: tRows[0].name, intervals: invRows as TemplateIntervalRow[] };
}

interface BulkPlan {
  timezone: string;
  templateName: string | null;
  templateIntervals: TemplateIntervalRow[];
  slots: Array<{ employeeId: string; date: string; month: string }>;
  policyByMonth: Map<string, string>;
  conflicts: Array<{ id: string; employeeId: string; workDate: string; hasAttendance: boolean }>;
  warnings: string[];
  plannedPaidMinutesPerDay: number;
}

/** Validates a bulk request and expands it into concrete (employee, date) slots. Never writes. */
async function buildBulkPlan(
  db: Db,
  restaurantId: string,
  body: ReturnType<typeof bulkScheduleSchema.parse>,
  lock: boolean
): Promise<BulkPlan> {
  const warnings: string[] = [];

  const startDt = assertIsoDate(body.dateFrom, 'dateFrom');
  const endDt = assertIsoDate(body.dateTo, 'dateTo');
  if (endDt < startDt) throw new AppError(422, 'INVALID_DATE_RANGE', 'dateTo must be on or after dateFrom');
  const rangeDays = Math.round(endDt.diff(startDt, 'days').days) + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new AppError(422, 'DATE_RANGE_TOO_LARGE', `The date range cannot exceed ${MAX_RANGE_DAYS} days`);
  }
  if (body.weekdays.length === 0) {
    throw new AppError(422, 'INVALID_WEEKDAYS', 'Select at least one weekday');
  }

  const employeeIds = [...new Set(body.employeeIds.map(String))];
  if (employeeIds.some((id) => !/^\d+$/.test(id))) {
    throw new AppError(422, 'INVALID_EMPLOYEE', 'employeeIds must be numeric ids');
  }
  if (employeeIds.length > MAX_EMPLOYEES) {
    throw new AppError(422, 'TOO_MANY_EMPLOYEES', `At most ${MAX_EMPLOYEES} employees can be scheduled at once`);
  }

  const timezone = await getTimezone(db, restaurantId);

  // Employees: must exist in this tenant and be ACTIVE
  const inList = employeeIds.map(() => '?').join(',');
  const [empRows] = await db.execute<RowDataPacket[]>(
    `SELECT id, full_name, status,
            DATE_FORMAT(employment_start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(employment_end_date, '%Y-%m-%d') AS end_date
     FROM employees WHERE restaurant_id = ? AND id IN (${inList})`,
    [restaurantId, ...employeeIds]
  );
  const empMap = new Map(empRows.map((e) => [String(e.id), e]));
  const missing = employeeIds.filter((id) => !empMap.has(id));
  if (missing.length > 0) {
    throw new AppError(422, 'EMPLOYEE_NOT_FOUND', `Unknown employee id(s): ${missing.join(', ')}`);
  }
  const inactive = empRows.filter((e) => e.status !== 'ACTIVE');
  if (inactive.length > 0) {
    throw new AppError(422, 'EMPLOYEE_INACTIVE', `Inactive employee(s): ${inactive.map((e) => e.full_name).join(', ')}`);
  }

  // Template / day type
  let templateName: string | null = null;
  let templateIntervals: TemplateIntervalRow[] = [];
  let plannedPaidMinutesPerDay = 0;
  if (body.dayType === 'WORK') {
    if (!body.shiftTemplateId) {
      throw new AppError(422, 'TEMPLATE_REQUIRED', 'A shift template is required for WORK days');
    }
    const tpl = await loadTemplate(db, restaurantId, body.shiftTemplateId, true);
    templateName = tpl.name;
    templateIntervals = tpl.intervals;
    if (templateIntervals.length === 0) {
      throw new AppError(422, 'TEMPLATE_EMPTY', 'The shift template has no intervals');
    }
    // Validate against a representative date (the first day of the range)
    plannedPaidMinutesPerDay = validatePlannedIntervals(
      buildTemplateIntervals(body.dateFrom, timezone, templateIntervals)
    ).requiredMinutes;
  }

  // Expand slots (Luxon weekday: 1 = Mon ... 7 = Sun)
  const slots: BulkPlan['slots'] = [];
  const skipped = new Set<string>();
  const months = new Set<string>();
  for (let cur = startDt; cur <= endDt; cur = cur.plus({ days: 1 })) {
    if (!body.weekdays.includes(cur.weekday)) continue;
    const date = cur.toISODate()!;
    for (const empId of employeeIds) {
      const e = empMap.get(empId)!;
      if (date < e.start_date || (e.end_date && date > e.end_date)) {
        skipped.add(String(e.full_name));
        continue;
      }
      slots.push({ employeeId: empId, date, month: `${date.slice(0, 7)}-01` });
      months.add(`${date.slice(0, 7)}-01`);
    }
  }
  if (slots.length > MAX_SLOTS) {
    throw new AppError(422, 'TOO_MANY_SLOTS', `This request would create more than ${MAX_SLOTS} schedule days`);
  }
  if (skipped.size > 0) {
    warnings.push(`Dates outside employment period were skipped for: ${[...skipped].join(', ')}`);
  }

  // Every month needs an effective policy
  const policyByMonth = new Map<string, string>();
  for (const m of months) policyByMonth.set(m, await getPolicyVersionId(db, restaurantId, m));

  // Existing entries (and whether attendance already exists on them)
  const [existing] = await db.execute<RowDataPacket[]>(
    `SELECT d.id, d.employee_id, DATE_FORMAT(d.work_date, '%Y-%m-%d') AS work_date,
            (SELECT COUNT(*) FROM attendance_days a WHERE a.restaurant_id = d.restaurant_id AND a.schedule_day_id = d.id) AS attendance_count
     FROM schedule_days d
     WHERE d.restaurant_id = ? AND d.work_date BETWEEN ? AND ? AND d.employee_id IN (${inList})
     ${lock ? 'FOR UPDATE' : ''}`,
    [restaurantId, body.dateFrom, body.dateTo, ...employeeIds]
  );
  const slotKeys = new Set(slots.map((s) => `${s.employeeId}_${s.date}`));
  const conflicts = existing
    .filter((e) => slotKeys.has(`${e.employee_id}_${e.work_date}`))
    .map((e) => ({
      id: String(e.id),
      employeeId: String(e.employee_id),
      workDate: String(e.work_date),
      hasAttendance: Number(e.attendance_count) > 0,
    }));

  return { timezone, templateName, templateIntervals, slots, policyByMonth, conflicts, warnings, plannedPaidMinutesPerDay };
}

// GET /api/v1/restaurants/:restaurantId/schedules?month=YYYY-MM  (or ?from=YYYY-MM-DD&to=YYYY-MM-DD)
schedulingRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    let from: string;
    let to: string;

    if (req.query.month) {
      const monthStart = normalizeMonthStart(String(req.query.month), 'month');
      from = monthStart;
      to = DateTime.fromISO(monthStart, { zone: 'utc' }).endOf('month').toISODate()!;
    } else {
      from = String(req.query.from || '');
      to = String(req.query.to || '');
      if (!from || !to) {
        throw new AppError(
          422,
          'INVALID_QUERY',
          'Provide "month" (YYYY-MM) or both "from" and "to" date parameters (YYYY-MM-DD)'
        );
      }
      assertIsoDate(from, 'from');
      assertIsoDate(to, 'to');
    }

    // 1. Fetch schedule days
    const [days] = await pool.execute<RowDataPacket[]>(
      `SELECT
        d.id,
        d.employee_id,
        e.full_name AS employee_name,
        e.employee_number,
        DATE_FORMAT(d.work_date, '%Y-%m-%d') AS work_date,
        d.day_type,
        d.source_template_id,
        t.name AS template_name,
        d.required_minutes,
        d.exception_reason,
        d.row_version
       FROM schedule_days d
       JOIN employees e ON e.id = d.employee_id
       LEFT JOIN shift_templates t ON t.id = d.source_template_id
       WHERE d.restaurant_id = ? AND d.work_date BETWEEN ? AND ?
       ORDER BY e.full_name ASC, d.work_date ASC`,
      [restaurantId, from, to]
    );

    // 2. Fetch schedule intervals
    const [intervals] = await pool.execute<RowDataPacket[]>(
      `SELECT
        i.id,
        i.schedule_day_id,
        i.sequence_number,
        DATE_FORMAT(i.planned_start_at, '%Y-%m-%dT%H:%i:%s.000Z') AS planned_start_at,
        DATE_FORMAT(i.planned_end_at, '%Y-%m-%dT%H:%i:%s.000Z') AS planned_end_at,
        i.planned_unpaid_break_minutes
       FROM schedule_intervals i
       JOIN schedule_days d ON d.id = i.schedule_day_id
       WHERE i.restaurant_id = ? AND d.work_date BETWEEN ? AND ?
       ORDER BY i.schedule_day_id ASC, i.sequence_number ASC`,
      [restaurantId, from, to]
    );

    const byDay = new Map<string, RowDataPacket[]>();
    for (const inv of intervals) {
      const key = String(inv.schedule_day_id);
      const list = byDay.get(key);
      if (list) list.push(inv);
      else byDay.set(key, [inv]);
    }

    const data = days.map((d) => ({
      id: String(d.id),
      employeeId: String(d.employee_id),
      employeeName: d.employee_name,
      employeeNumber: d.employee_number,
      workDate: d.work_date,
      dayType: d.day_type,
      sourceTemplateId: d.source_template_id ? String(d.source_template_id) : null,
      templateName: d.template_name,
      requiredMinutes: d.required_minutes,
      exceptionReason: d.exception_reason,
      rowVersion: Number(d.row_version),
      intervals: (byDay.get(String(d.id)) || []).map((inv) => ({
        id: String(inv.id),
        sequenceNumber: inv.sequence_number,
        plannedStartAt: inv.planned_start_at,
        plannedEndAt: inv.planned_end_at,
        plannedUnpaidBreakMinutes: inv.planned_unpaid_break_minutes,
      })),
    }));

    res.json({ data, meta: { requestId: req.requestId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/schedules/bulk-preview
schedulingRouter.post('/bulk-preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const body = bulkScheduleSchema.parse(req.body);

    assertIsoDate(body.dateFrom, 'dateFrom');
    assertIsoDate(body.dateTo, 'dateTo');
    await assertRangeNotFinalized(pool, restaurantId, body.dateFrom, body.dateTo);
    const plan = await buildBulkPlan(pool, restaurantId, body, false);

    const warnings = [...plan.warnings];
    const withAttendance = plan.conflicts.filter((c) => c.hasAttendance).length;
    if (plan.conflicts.length > 0) {
      warnings.push(
        body.existingEntryPolicy === 'REJECT_CONFLICTS'
          ? `${plan.conflicts.length} day(s) already have a schedule; committing will be rejected unless you choose to overwrite.`
          : `${plan.conflicts.length} existing schedule day(s) will be overwritten.`
      );
    }
    if (withAttendance > 0 && body.existingEntryPolicy !== 'REJECT_CONFLICTS') {
      warnings.push(
        `${withAttendance} of those day(s) already have attendance recorded and cannot be overwritten; committing will be rejected.`
      );
    }

    res.json({
      data: {
        totalDaysToGenerate: plan.slots.length,
        conflictCount: plan.conflicts.length,
        warnings,
        // Extra detail (not required by the current frontend)
        affectedEmployees: new Set(plan.slots.map((s) => s.employeeId)).size,
        overwrittenCount: plan.conflicts.length,
        dayType: body.dayType,
        shiftTemplateId: body.dayType === 'WORK' ? body.shiftTemplateId || null : null,
        templateName: plan.templateName,
        plannedPaidMinutesPerDay: plan.plannedPaidMinutesPerDay,
        sampleDates: [...new Set(plan.slots.map((s) => s.date))].slice(0, 10),
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/schedules/bulk-commit
schedulingRouter.post('/bulk-commit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = bulkScheduleSchema.parse(req.body);

    const scheduled = await withTransaction(async (conn) => {
      // Fail fast on finalized months, then lock the affected period rows
      assertIsoDate(body.dateFrom, 'dateFrom');
      assertIsoDate(body.dateTo, 'dateTo');
      await assertRangeNotFinalized(conn, restaurantId, body.dateFrom, body.dateTo);

      const plan = await buildBulkPlan(conn, restaurantId, body, true);
      if (plan.slots.length === 0) return 0;

      const months = [...plan.policyByMonth.keys()].sort();
      for (const monthStart of months) {
        await conn.execute(
          `INSERT IGNORE INTO payroll_periods (restaurant_id, month_start, status, source_revision)
           VALUES (?, ?, 'DRAFT', 1)`,
          [restaurantId, monthStart]
        );
        const [periodRows] = await conn.execute<RowDataPacket[]>(
          `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ? FOR UPDATE`,
          [restaurantId, monthStart]
        );
        if (periodRows[0]?.status === 'FINALIZED') {
          throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', `Cannot modify schedule in finalized month ${monthStart.slice(0, 7)}`);
        }
      }

      if (body.existingEntryPolicy === 'REJECT_CONFLICTS' && plan.conflicts.length > 0) {
        throw new AppError(409, 'SCHEDULE_CONFLICT', `${plan.conflicts.length} day(s) already have a schedule`, {
          conflictCount: plan.conflicts.length,
          conflicts: plan.conflicts.slice(0, 50).map((c) => ({ employeeId: c.employeeId, workDate: c.workDate })),
        });
      }
      const blocked = plan.conflicts.filter((c) => c.hasAttendance);
      if (blocked.length > 0) {
        throw new AppError(
          409,
          'SCHEDULE_DAY_HAS_ATTENDANCE',
          `${blocked.length} day(s) already have attendance recorded and cannot be overwritten`,
          { conflicts: blocked.slice(0, 50).map((c) => ({ employeeId: c.employeeId, workDate: c.workDate })) }
        );
      }

      for (const slot of plan.slots) {
        const isWork = body.dayType === 'WORK';
        let intervals: PlannedInterval[] = [];
        let requiredMinutes = 0;
        if (isWork) {
          const v = validatePlannedIntervals(buildTemplateIntervals(slot.date, plan.timezone, plan.templateIntervals));
          intervals = v.sorted;
          requiredMinutes = v.requiredMinutes;
        }

        const [dayRes] = await conn.execute<ResultSetHeader>(
          `INSERT INTO schedule_days
            (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             id = LAST_INSERT_ID(id),
             day_type = VALUES(day_type),
             source_template_id = VALUES(source_template_id),
             policy_version_id = VALUES(policy_version_id),
             required_minutes = VALUES(required_minutes),
             timezone_snapshot = VALUES(timezone_snapshot),
             exception_reason = NULL,
             row_version = row_version + 1,
             updated_by = VALUES(updated_by)`,
          [
            restaurantId,
            slot.employeeId,
            slot.date,
            slot.month,
            body.dayType,
            isWork ? body.shiftTemplateId || null : null,
            plan.policyByMonth.get(slot.month)!,
            requiredMinutes,
            plan.timezone,
            actorId,
            actorId,
          ]
        );
        const scheduleDayId = String(dayRes.insertId);

        // Safe: days with attendance were rejected above, so no FK references these intervals
        await conn.execute(`DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`, [
          restaurantId,
          scheduleDayId,
        ]);
        await insertIntervals(conn, restaurantId, slot.employeeId, scheduleDayId, intervals);
      }

      for (const m of months) {
        await bumpSourceRevision(conn, restaurantId, m, m);
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'BULK_SCHEDULE_COMMIT',
          entityType: 'SCHEDULE',
          requestId: req.requestId,
          afterValues: {
            totalApplied: plan.slots.length,
            overwritten: plan.conflicts.length,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo,
            dayType: body.dayType,
            shiftTemplateId: body.shiftTemplateId || null,
          },
        },
        conn
      );
      return plan.slots.length;
    });

    res.json({
      data: {
        scheduledDaysCount: scheduled,
        count: scheduled,
        message: scheduled === 0 ? 'No dates matched the selected pattern.' : 'Bulk schedule applied successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/schedules/batch
schedulingRouter.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = batchScheduleSchema.parse(req.body);

    const timezone = await getTimezone(pool, restaurantId);

    // Group dates to check period finalization
    const affectedMonths = new Set<string>();
    for (const a of body.assignments) {
      affectedMonths.add(normalizeMonthStart(a.workDate));
    }

    const scheduledCount = await withTransaction(async (conn) => {
      // 1. Lock and verify all affected months
      for (const mStart of affectedMonths) {
        await conn.execute(
          `INSERT IGNORE INTO payroll_periods (restaurant_id, month_start, status, source_revision)
           VALUES (?, ?, 'DRAFT', 1)`,
          [restaurantId, mStart]
        );
        const [periodRows] = await conn.execute<RowDataPacket[]>(
          `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ? FOR UPDATE`,
          [restaurantId, mStart]
        );
        if (periodRows[0]?.status === 'FINALIZED') {
          throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', `Cannot modify schedule in finalized month ${mStart.slice(0, 7)}`);
        }
      }

      // 2. Pre-cache shift templates
      const templateIds = [
        ...new Set(body.assignments.filter((a) => a.dayType === 'WORK' && a.shiftTemplateId).map((a) => String(a.shiftTemplateId))),
      ];
      const templateMap = new Map<string, { name: string; intervals: TemplateIntervalRow[] }>();
      for (const tId of templateIds) {
        templateMap.set(tId, await loadTemplate(conn, restaurantId, tId, false));
      }

      // Pre-cache policy per month
      const policyMap = new Map<string, string>();
      for (const mStart of affectedMonths) {
        policyMap.set(mStart, await getPolicyVersionId(conn, restaurantId, mStart));
      }

      let count = 0;
      for (const item of body.assignments) {
        const mStart = normalizeMonthStart(item.workDate);

        // Check if existing day has attendance
        const [existingRows] = await conn.execute<RowDataPacket[]>(
          `SELECT d.id,
                  (SELECT COUNT(*) FROM attendance_days a WHERE a.restaurant_id = d.restaurant_id AND a.schedule_day_id = d.id) AS attendance_count
           FROM schedule_days d
           WHERE d.restaurant_id = ? AND d.employee_id = ? AND d.work_date = ?`,
          [restaurantId, item.employeeId, item.workDate]
        );
        const existing = existingRows[0];
        if (existing && Number(existing.attendance_count) > 0) {
          throw new AppError(
            409,
            'SCHEDULE_DAY_HAS_ATTENDANCE',
            `Date ${item.workDate} already has attendance recorded and cannot be modified`
          );
        }

        if (item.dayType === 'CLEAR') {
          if (existing) {
            await conn.execute(`DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`, [
              restaurantId,
              existing.id,
            ]);
            await conn.execute(`DELETE FROM schedule_days WHERE restaurant_id = ? AND id = ?`, [
              restaurantId,
              existing.id,
            ]);
            count++;
          }
          continue;
        }

        const isWork = item.dayType === 'WORK';
        const tmpl = isWork && item.shiftTemplateId ? templateMap.get(String(item.shiftTemplateId)) : null;
        let intervals: PlannedInterval[] = [];
        let requiredMinutes = 0;
        if (isWork) {
          if (!tmpl) {
            throw new AppError(422, 'INVALID_INTERVAL', `A WORK day needs a valid shift template (missing for ${item.workDate})`);
          }
          const v = validatePlannedIntervals(buildTemplateIntervals(item.workDate, timezone, tmpl.intervals));
          intervals = v.sorted;
          requiredMinutes = v.requiredMinutes;
        }

        const [dayRes] = await conn.execute<ResultSetHeader>(
          `INSERT INTO schedule_days
            (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             id = LAST_INSERT_ID(id),
             day_type = VALUES(day_type),
             source_template_id = VALUES(source_template_id),
             policy_version_id = VALUES(policy_version_id),
             required_minutes = VALUES(required_minutes),
             timezone_snapshot = VALUES(timezone_snapshot),
             exception_reason = NULL,
             row_version = row_version + 1,
             updated_by = VALUES(updated_by)`,
          [
            restaurantId,
            item.employeeId,
            item.workDate,
            mStart,
            item.dayType,
            isWork ? item.shiftTemplateId || null : null,
            policyMap.get(mStart)!,
            requiredMinutes,
            timezone,
            actorId,
            actorId,
          ]
        );
        const scheduleDayId = String(dayRes.insertId);

        await conn.execute(`DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`, [
          restaurantId,
          scheduleDayId,
        ]);
        if (intervals.length > 0) {
          await insertIntervals(conn, restaurantId, item.employeeId, scheduleDayId, intervals);
        }
        count++;
      }

      // Invalidate all affected months
      for (const mStart of affectedMonths) {
        await bumpSourceRevision(conn, restaurantId, mStart, mStart);
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'BATCH_SCHEDULE_COMMIT',
          entityType: 'SCHEDULE_DAY',
          entityId: `${body.assignments.length} assignments`,
          requestId: req.requestId,
          afterValues: { count, months: [...affectedMonths] },
        },
        conn
      );

      return count;
    });

    res.json({
      data: { scheduledCount, message: `Successfully updated ${scheduledCount} schedule day(s)` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/restaurants/:restaurantId/schedules/days/:scheduleDayId
schedulingRouter.put('/days/:scheduleDayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const scheduleDayId = String(req.params.scheduleDayId);
    const actorId = req.tenantContext!.actorId;
    const body = updateScheduleDaySchema.parse(req.body);

    if (!/^\d+$/.test(scheduleDayId)) throw new AppError(404, 'SCHEDULE_DAY_NOT_FOUND', 'Schedule day not found');

    await withTransaction(async (conn) => {
      // 1. Lock the schedule day (and its payroll period) for the duration of the update
      const [dayRows] = await conn.execute<RowDataPacket[]>(
        `SELECT d.id, d.employee_id, DATE_FORMAT(d.work_date, '%Y-%m-%d') AS work_date,
                DATE_FORMAT(d.payroll_month, '%Y-%m-%d') AS payroll_month,
                d.row_version, d.timezone_snapshot, p.status AS period_status,
                (SELECT COUNT(*) FROM attendance_days a WHERE a.restaurant_id = d.restaurant_id AND a.schedule_day_id = d.id) AS attendance_count
         FROM schedule_days d
         JOIN payroll_periods p ON p.restaurant_id = d.restaurant_id AND p.month_start = d.payroll_month
         WHERE d.restaurant_id = ? AND d.id = ?
         FOR UPDATE`,
        [restaurantId, scheduleDayId]
      );
      const day = dayRows[0];
      if (!day) throw new AppError(404, 'SCHEDULE_DAY_NOT_FOUND', 'Schedule day not found');
      if (day.period_status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot modify schedule in a finalized period');
      }
      if (Number(day.row_version) !== body.expectedVersion) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Schedule day was modified by another administrator');
      }
      if (Number(day.attendance_count) > 0) {
        throw new AppError(
          409,
          'SCHEDULE_DAY_HAS_ATTENDANCE',
          'Attendance has already been recorded for this day; the schedule can no longer be changed'
        );
      }

      const zone = assertValidTimezone(day.timezone_snapshot);

      // 2. Validate the requested state
      let templateId: string | null = null;
      let templateRows: TemplateIntervalRow[] = [];
      if (body.shiftTemplateId) {
        const tpl = await loadTemplate(conn, restaurantId, String(body.shiftTemplateId), false);
        templateId = String(body.shiftTemplateId);
        templateRows = tpl.intervals;
      }

      let intervals: PlannedInterval[] = [];
      let requiredMinutes = 0;
      if (body.dayType === 'WORK') {
        let candidate: PlannedInterval[];
        if (body.intervals && body.intervals.length > 0) {
          candidate = body.intervals.map((i) => parseClientInterval(i, zone));
        } else if (templateRows.length > 0) {
          candidate = buildTemplateIntervals(day.work_date, zone, templateRows);
        } else {
          throw new AppError(422, 'INVALID_INTERVAL', 'A WORK day needs at least one interval or a shift template');
        }
        const v = validatePlannedIntervals(candidate);
        intervals = v.sorted;
        requiredMinutes = v.requiredMinutes;
      } else if (body.intervals && body.intervals.length > 0) {
        throw new AppError(422, 'INVALID_INTERVAL', `${body.dayType} days cannot have intervals`);
      }

      // 3. Optimistic-locked update
      const [updRes] = await conn.execute<ResultSetHeader>(
        `UPDATE schedule_days
         SET day_type = ?,
             source_template_id = ?,
             required_minutes = ?,
             exception_reason = ?,
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [
          body.dayType,
          body.dayType === 'WORK' ? templateId : null,
          requiredMinutes,
          body.exceptionReason || null,
          actorId,
          restaurantId,
          scheduleDayId,
          body.expectedVersion,
        ]
      );
      if (updRes.affectedRows === 0) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Schedule day was modified by another administrator');
      }

      // 4. Replace intervals (safe: no attendance references them)
      await conn.execute(`DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`, [
        restaurantId,
        scheduleDayId,
      ]);
      await insertIntervals(conn, restaurantId, String(day.employee_id), scheduleDayId, intervals);

      // 5. Invalidate the (non-finalized) payroll period
      await bumpSourceRevision(conn, restaurantId, day.payroll_month, day.payroll_month);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_SCHEDULE_DAY',
          entityType: 'SCHEDULE_DAY',
          entityId: scheduleDayId,
          requestId: req.requestId,
          afterValues: { dayType: body.dayType, requiredMinutes, shiftTemplateId: templateId },
        },
        conn
      );
    });

    res.json({
      data: { message: 'Schedule day updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
