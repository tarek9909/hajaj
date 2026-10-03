import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import crypto from 'crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { Decimal } from 'decimal.js';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';
import { bumpSourceRevision } from '../configuration/periodGuards.js';

export const attendanceRouter = Router({ mergeParams: true });

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// An ISO datetime that carries an explicit offset (Z or +hh:mm)
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const SQL_DT = 'yyyy-MM-dd HH:mm:ss.000';

/**
 * Body for PUT /attendance/days/:attendanceDayId and PUT /attendance/days/by-schedule/:scheduleDayId.
 * expectedVersion is the attendance row version the client last saw (0 when the day has no attendance row yet).
 */
const saveAttendanceSchema = z.object({
  status: z.enum(['NOT_RECORDED', 'IN_PROGRESS', 'COMPLETED', 'CONFIRMED_ABSENT', 'EXCUSED', 'NEEDS_REVIEW']),
  additionalWorkApproved: z.boolean().default(true),
  notes: z.string().max(5000).optional().nullable(),
  expectedVersion: z.number().int().min(0).optional(),
  intervals: z
    .array(
      z.object({
        scheduleIntervalId: z.string().optional().nullable(),
        sequenceNumber: z.number().int().positive(),
        checkInAt: z.string(),
        checkOutAt: z.string().optional().nullable(),
        unpaidBreakMinutes: z.number().int().min(0).default(0),
      })
    )
    .max(10)
    .default([]),
});

const STATUSES_WITH_INTERVALS = ['IN_PROGRESS', 'COMPLETED', 'NEEDS_REVIEW'];

function mapPlanned(i: RowDataPacket) {
  return {
    id: String(i.id),
    sequenceNumber: i.sequence_number,
    plannedStartAt: i.planned_start_at,
    plannedEndAt: i.planned_end_at,
    plannedUnpaidBreakMinutes: i.planned_unpaid_break_minutes,
  };
}

// GET /api/v1/restaurants/:restaurantId/attendance/daily?date=YYYY-MM-DD  (alias: GET /attendance?date=...)
// Read-only: returns one row per scheduled day. attendanceDayId is null until attendance is first saved.
const getDaily = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const date = req.query.date ? String(req.query.date) : DateTime.utc().toISODate()!;
    if (!ISO_DATE_RE.test(date) || !DateTime.fromISO(date).isValid) {
      throw new AppError(422, 'INVALID_QUERY', 'date must be a valid YYYY-MM-DD date');
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
        a.id AS attendance_day_id,
        e.id AS employee_id,
        e.full_name,
        e.employee_number,
        p.name AS position_name,
        d.id AS schedule_day_id,
        COALESCE(d.day_type, 'WORK') AS day_type,
        COALESCE(d.required_minutes, 480) AS required_minutes,
        t.name AS template_name,
        COALESCE(DATE_FORMAT(d.work_date, '%Y-%m-%d'), ?) AS work_date,
        COALESCE(a.status, 'NOT_RECORDED') AS status,
        COALESCE(a.additional_work_approved, 1) AS additional_work_approved,
        a.notes,
        COALESCE(a.row_version, 0) AS row_version,
        w.id AS automatic_warning_id,
        w.system_qualifies AS warning_system_qualifies,
        w.admin_voided AS warning_admin_voided,
        lp.qualifies AS penalty_qualifies,
        lp.calculated_amount AS penalty_amount
       FROM employees e
       JOIN positions p ON p.restaurant_id = e.restaurant_id AND p.id = e.position_id
       LEFT JOIN schedule_days d ON d.restaurant_id = e.restaurant_id AND d.employee_id = e.id AND d.work_date = ?
       LEFT JOIN attendance_days a ON a.restaurant_id = e.restaurant_id AND (a.schedule_day_id = d.id OR (a.employee_id = e.id AND a.work_date = ?))
       LEFT JOIN shift_templates t ON t.restaurant_id = e.restaurant_id AND t.id = d.source_template_id
       LEFT JOIN warnings w ON w.restaurant_id = e.restaurant_id AND w.automatic_attendance_day_id = a.id
       LEFT JOIN late_penalties lp ON lp.restaurant_id = e.restaurant_id AND lp.attendance_day_id = a.id
       WHERE e.restaurant_id = ? AND (e.status = 'ACTIVE' OR d.id IS NOT NULL)
       ORDER BY e.full_name ASC`,
      [date, date, date, restaurantId]
    );

    const [plannedIntervals] = await pool.execute<RowDataPacket[]>(
      `SELECT i.id, i.schedule_day_id, i.sequence_number,
              DATE_FORMAT(i.planned_start_at, '%Y-%m-%dT%H:%i:%s.000Z') AS planned_start_at,
              DATE_FORMAT(i.planned_end_at, '%Y-%m-%dT%H:%i:%s.000Z') AS planned_end_at,
              i.planned_unpaid_break_minutes
       FROM schedule_intervals i
       JOIN schedule_days d ON d.id = i.schedule_day_id
       WHERE i.restaurant_id = ? AND d.work_date = ?
       ORDER BY i.schedule_day_id ASC, i.sequence_number ASC`,
      [restaurantId, date]
    );

    const [actualIntervals] = await pool.execute<RowDataPacket[]>(
      `SELECT ai.id, ai.attendance_day_id, ai.schedule_interval_id, ai.sequence_number,
              DATE_FORMAT(ai.check_in_at, '%Y-%m-%dT%H:%i:%s.000Z') AS check_in_at,
              DATE_FORMAT(ai.check_out_at, '%Y-%m-%dT%H:%i:%s.000Z') AS check_out_at,
              ai.unpaid_break_minutes
       FROM attendance_intervals ai
       JOIN attendance_days a ON a.id = ai.attendance_day_id
       WHERE ai.restaurant_id = ? AND a.work_date = ?
       ORDER BY ai.attendance_day_id ASC, ai.sequence_number ASC`,
      [restaurantId, date]
    );

    const data = rows.map((r) => {
      const pl = r.schedule_day_id
        ? plannedIntervals.filter((i) => String(i.schedule_day_id) === String(r.schedule_day_id))
        : [];
      const act = r.attendance_day_id
        ? actualIntervals.filter((i) => String(i.attendance_day_id) === String(r.attendance_day_id))
        : [];

      let workedMinutes = 0;
      let hasArrival = false;
      let maxLate = 0;

      const actualOut = act.map((aInt) => {
        const plan =
          pl.find((p) => aInt.schedule_interval_id && String(p.id) === String(aInt.schedule_interval_id)) ||
          pl.find((p) => p.sequence_number === aInt.sequence_number);
        let late = 0;
        let worked = 0;
        const inDt = DateTime.fromISO(aInt.check_in_at, { setZone: true });
        if (aInt.check_in_at) {
          hasArrival = true;
          if (plan?.planned_start_at) {
            const diff = Math.floor(inDt.diff(DateTime.fromISO(plan.planned_start_at, { setZone: true }), 'minutes').minutes);
            late = Math.max(0, diff);
            if (late > maxLate) maxLate = late;
          }
        }
        if (aInt.check_in_at && aInt.check_out_at) {
          const dur = Math.floor(DateTime.fromISO(aInt.check_out_at).diff(inDt, 'minutes').minutes);
          worked = Math.max(0, dur - (aInt.unpaid_break_minutes || 0));
          workedMinutes += worked;
        }
        return {
          id: String(aInt.id),
          scheduleIntervalId: aInt.schedule_interval_id ? String(aInt.schedule_interval_id) : null,
          sequenceNumber: aInt.sequence_number,
          checkInAt: aInt.check_in_at,
          checkOutAt: aInt.check_out_at,
          unpaidBreakMinutes: aInt.unpaid_break_minutes,
          lateMinutes: late,
          workedMinutes: worked,
        };
      });

      const isComplete = r.status === 'COMPLETED';
      const requiredMinutes = Number(r.required_minutes);
      const attendanceDayId = r.attendance_day_id ? String(r.attendance_day_id) : null;

      return {
        attendanceDayId,
        employeeId: String(r.employee_id),
        employeeNumber: r.employee_number,
        fullName: r.full_name,
        employeeName: r.full_name,
        positionName: r.position_name,
        scheduleDayId: r.schedule_day_id ? String(r.schedule_day_id) : null,
        dayType: r.day_type,
        templateName: r.template_name || (r.schedule_day_id ? 'Custom Shift' : 'Standard Shift'),
        requiredMinutes,
        workDate: r.work_date,
        status: r.status,
        attendanceStatus: r.status,
        additionalWorkApproved: Boolean(r.additional_work_approved),
        notes: r.notes,
        workedMinutes: isComplete ? workedMinutes : null,
        shortfallMinutes: isComplete ? Math.max(0, requiredMinutes - workedMinutes) : null,
        additionalMinutes: isComplete ? Math.max(0, workedMinutes - requiredMinutes) : null,
        lateMinutes: hasArrival ? maxLate : 0,
        qualifiesLatePenalty: Boolean(r.penalty_qualifies),
        latePenaltyAmount: Number(r.penalty_amount || 0),
        hasAutomaticWarning: Boolean(r.automatic_warning_id && r.warning_system_qualifies && !r.warning_admin_voided),
        rowVersion: Number(r.row_version),
        plannedIntervals: pl.map(mapPlanned),
        actualIntervals: actualOut,
      };
    });

    res.json({ data, meta: { requestId: req.requestId } });
  } catch (err) {
    next(err);
  }
};
attendanceRouter.get('/daily', getDaily);
attendanceRouter.get('/', getDaily);

interface ParsedActual {
  scheduleIntervalId: string | null;
  sequenceNumber: number;
  checkIn: DateTime;
  checkOut: DateTime | null;
  unpaidBreakMinutes: number;
}

function parseAndValidateIntervals(
  intervals: z.infer<typeof saveAttendanceSchema>['intervals'],
  status: string,
  plannedIds: Set<string>
): ParsedActual[] {
  const parse = (v: string, field: string): DateTime => {
    if (!ISO_WITH_OFFSET_RE.test(v)) {
      throw new AppError(422, 'INVALID_INTERVAL', `${field} must be an ISO datetime with an explicit UTC offset (e.g. 2026-09-01T08:00:00Z)`);
    }
    const dt = DateTime.fromISO(v, { setZone: true });
    if (!dt.isValid) throw new AppError(422, 'INVALID_INTERVAL', `${field} is not a valid datetime`);
    if (dt.second !== 0 || dt.millisecond !== 0) {
      throw new AppError(422, 'INVALID_INTERVAL', `${field} must have zero seconds`);
    }
    return dt;
  };

  const out: ParsedActual[] = [];
  const seen = new Set<number>();
  for (const inv of intervals) {
    if (seen.has(inv.sequenceNumber)) {
      throw new AppError(422, 'INVALID_INTERVAL', `Duplicate interval sequenceNumber ${inv.sequenceNumber}`);
    }
    seen.add(inv.sequenceNumber);

    const checkIn = parse(inv.checkInAt, `Interval ${inv.sequenceNumber} checkInAt`);
    const checkOut = inv.checkOutAt ? parse(inv.checkOutAt, `Interval ${inv.sequenceNumber} checkOutAt`) : null;
    if (checkOut) {
      const dur = Math.round(checkOut.diff(checkIn, 'minutes').minutes);
      if (dur <= 0) {
        throw new AppError(422, 'INVALID_INTERVAL', `Interval ${inv.sequenceNumber}: check-out must be after check-in`);
      }
      if (inv.unpaidBreakMinutes >= dur) {
        throw new AppError(422, 'INVALID_INTERVAL', `Interval ${inv.sequenceNumber}: unpaid break must be shorter than the interval`);
      }
    } else if (status === 'COMPLETED') {
      throw new AppError(422, 'INVALID_INTERVAL', 'A completed day needs a check-out time on every interval');
    }
    if (inv.scheduleIntervalId && !plannedIds.has(String(inv.scheduleIntervalId))) {
      throw new AppError(422, 'INVALID_INTERVAL', `Interval ${inv.sequenceNumber}: scheduleIntervalId does not belong to this schedule day`);
    }
    out.push({
      scheduleIntervalId: inv.scheduleIntervalId ? String(inv.scheduleIntervalId) : null,
      sequenceNumber: inv.sequenceNumber,
      checkIn,
      checkOut,
      unpaidBreakMinutes: inv.unpaidBreakMinutes,
    });
  }

  const sorted = [...out].sort((a, b) => a.checkIn.toMillis() - b.checkIn.toMillis());
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.checkOut;
    if (!prevEnd || sorted[i]!.checkIn.toMillis() < prevEnd.toMillis()) {
      throw new AppError(422, 'INVALID_INTERVAL', 'Attendance intervals must not overlap');
    }
  }
  if ((status === 'COMPLETED' || status === 'IN_PROGRESS') && out.length === 0) {
    throw new AppError(422, 'INVALID_INTERVAL', `${status} requires at least one interval`);
  }
  return out;
}

async function saveAttendance(
  req: Request,
  target: { attendanceDayId: string } | { scheduleDayId: string } | { employeeId: string; workDate: string }
): Promise<{ attendanceDayId: string; rowVersion: number }> {
  const restaurantId = req.tenantContext!.restaurantId;
  const actorId = req.tenantContext!.actorId;
  const body = saveAttendanceSchema.parse(req.body);

  return withTransaction(async (conn: PoolConnection) => {
    let scheduleDayId: string;
    if ('scheduleDayId' in target) {
      scheduleDayId = target.scheduleDayId;
    } else if ('attendanceDayId' in target) {
      const [ref] = await conn.execute<RowDataPacket[]>(
        `SELECT schedule_day_id FROM attendance_days WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, target.attendanceDayId]
      );
      if (!ref[0]) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance day record not found');
      scheduleDayId = String(ref[0].schedule_day_id);
    } else {
      // Find or create schedule_day for target.employeeId and target.workDate
      const [existing] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM schedule_days WHERE restaurant_id = ? AND employee_id = ? AND work_date = ?`,
        [restaurantId, target.employeeId, target.workDate]
      );
      if (existing[0]) {
        scheduleDayId = String(existing[0].id);
      } else {
        const [empRows] = await conn.execute<RowDataPacket[]>(
          `SELECT id, position_id FROM employees WHERE restaurant_id = ? AND id = ?`,
          [restaurantId, target.employeeId]
        );
        if (!empRows[0]) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

        const payrollMonth = `${target.workDate.slice(0, 7)}-01`;
        await conn.execute(
          `INSERT INTO payroll_periods (restaurant_id, month_start, status, source_revision)
           VALUES (?, ?, 'DRAFT', 1)
           ON DUPLICATE KEY UPDATE id = id`,
          [restaurantId, payrollMonth]
        );

        const [periodRows] = await conn.execute<RowDataPacket[]>(
          `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
          [restaurantId, payrollMonth]
        );
        if (periodRows[0]?.status === 'FINALIZED') {
          throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot modify attendance in a finalized month. Please reopen the period first.');
        }

        const [polRows] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM restaurant_policy_versions
           WHERE restaurant_id = ? AND effective_from_month <= ?
           ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
          [restaurantId, payrollMonth]
        );
        const policyId = polRows[0]?.id;
        if (!policyId) throw new AppError(422, 'NO_POLICY_CONFIGURED', 'No effective policy found for this month');

        const [restRows] = await conn.execute<RowDataPacket[]>(
          `SELECT timezone FROM restaurants WHERE id = ?`,
          [restaurantId]
        );
        const tz = restRows[0]?.timezone || 'UTC';

        const [insDay] = await conn.execute<ResultSetHeader>(
          `INSERT INTO schedule_days
            (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by, updated_by)
           VALUES (?, ?, ?, ?, 'WORK', NULL, ?, 480, ?, ?, ?)`,
          [restaurantId, target.employeeId, target.workDate, payrollMonth, policyId, tz, actorId, actorId]
        );
        scheduleDayId = String(insDay.insertId);
      }
    }
    if (!/^\d+$/.test(scheduleDayId)) throw new AppError(404, 'SCHEDULE_DAY_NOT_FOUND', 'Schedule day not found');

    // 1. Lock the schedule day (and period) and resolve / lazily create the attendance day
    const baseSelect = `SELECT d.id AS schedule_day_id, d.employee_id, d.day_type,
              DATE_FORMAT(d.work_date, '%Y-%m-%d') AS work_date,
              DATE_FORMAT(d.payroll_month, '%Y-%m-%d') AS payroll_month,
              d.required_minutes, COALESCE(p.status, 'DRAFT') AS period_status
       FROM schedule_days d
       LEFT JOIN payroll_periods p ON p.restaurant_id = d.restaurant_id AND p.month_start = d.payroll_month`;

    const [dayRows] = await conn.execute<RowDataPacket[]>(
      `${baseSelect} WHERE d.restaurant_id = ? AND d.id = ? FOR UPDATE`,
      [restaurantId, scheduleDayId]
    );
    const day = dayRows[0];
    if (!day) throw new AppError(404, 'SCHEDULE_DAY_NOT_FOUND', 'Schedule day not found');
    if (day.period_status === 'FINALIZED') {
      throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot modify attendance in a finalized month. Please reopen the period first.');
    }

    const [attRows] = await conn.execute<RowDataPacket[]>(
      `SELECT id, status, row_version FROM attendance_days WHERE restaurant_id = ? AND schedule_day_id = ? FOR UPDATE`,
      [restaurantId, scheduleDayId]
    );
    let attendanceDayId: string;
    let currentVersion: number;
    let previousStatus: string | null = null;

    if (attRows[0]) {
      attendanceDayId = String(attRows[0].id);
      currentVersion = Number(attRows[0].row_version);
      previousStatus = attRows[0].status;
      if ('attendanceDayId' in target && target.attendanceDayId !== attendanceDayId) {
        throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance day record not found');
      }
      if (body.expectedVersion === undefined) {
        throw new AppError(422, 'VALIDATION_ERROR', 'expectedVersion is required when updating an existing attendance record');
      }
      if (body.expectedVersion !== currentVersion) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Attendance record was modified by another administrator');
      }
    } else {
      if ('attendanceDayId' in target) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance day record not found');
      if (body.expectedVersion !== undefined && body.expectedVersion !== 0) {
        throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Attendance record was modified by another administrator');
      }
      const [ins] = await conn.execute<ResultSetHeader>(
        `INSERT INTO attendance_days
          (restaurant_id, employee_id, schedule_day_id, work_date, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, 'NOT_RECORDED', ?, ?)`,
        [restaurantId, day.employee_id, scheduleDayId, day.work_date, actorId, actorId]
      );
      attendanceDayId = String(ins.insertId);
      currentVersion = 1;
    }

    // 2. Planned intervals of this schedule day (validation + lateness)
    const [plannedIntervals] = await conn.execute<RowDataPacket[]>(
      `SELECT id, sequence_number, planned_start_at
       FROM schedule_intervals
       WHERE restaurant_id = ? AND schedule_day_id = ?
       ORDER BY sequence_number ASC`,
      [restaurantId, scheduleDayId]
    );
    const plannedIds = new Set(plannedIntervals.map((p) => String(p.id)));

    // 3. Validate intervals. Absent/excused/not-recorded days carry no clock data.
    const keepIntervals = STATUSES_WITH_INTERVALS.includes(body.status);
    const parsed = keepIntervals ? parseAndValidateIntervals(body.intervals, body.status, plannedIds) : [];

    // 4. Update the attendance day with an optimistic lock
    const [updRes] = await conn.execute<ResultSetHeader>(
      `UPDATE attendance_days
       SET status = ?,
           additional_work_approved = ?,
           notes = ?,
           row_version = row_version + 1,
           updated_by = ?
       WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
      [
        body.status,
        body.additionalWorkApproved ? 1 : 0,
        body.notes || null,
        actorId,
        restaurantId,
        attendanceDayId,
        currentVersion,
      ]
    );
    if (updRes.affectedRows === 0) {
      throw new AppError(409, 'ROW_VERSION_CONFLICT', 'Attendance record was modified by another administrator');
    }
    const newVersion = currentVersion + 1;

    // 5. Replace attendance intervals
    await conn.execute(`DELETE FROM attendance_intervals WHERE restaurant_id = ? AND attendance_day_id = ?`, [
      restaurantId,
      attendanceDayId,
    ]);

    let maxLateMinutes = 0;
    let totalWorkedMinutes = 0;
    for (const inv of parsed) {
      await conn.execute(
        `INSERT INTO attendance_intervals
          (restaurant_id, employee_id, schedule_day_id, attendance_day_id, schedule_interval_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          restaurantId,
          day.employee_id,
          scheduleDayId,
          attendanceDayId,
          inv.scheduleIntervalId,
          inv.sequenceNumber,
          inv.checkIn.toUTC().toFormat(SQL_DT),
          inv.checkOut ? inv.checkOut.toUTC().toFormat(SQL_DT) : null,
          inv.unpaidBreakMinutes,
        ]
      );

      // Lateness against the matching planned interval (by id, else by sequence number)
      const plan =
        plannedIntervals.find((p) => inv.scheduleIntervalId && String(p.id) === inv.scheduleIntervalId) ||
        plannedIntervals.find((p) => p.sequence_number === inv.sequenceNumber);
      if (plan?.planned_start_at) {
        const planDt = DateTime.fromJSDate(plan.planned_start_at as Date);
        const diff = Math.floor(inv.checkIn.diff(planDt, 'minutes').minutes);
        if (diff > maxLateMinutes) maxLateMinutes = diff;
      }
      if (inv.checkOut) {
        const dur = Math.floor(inv.checkOut.diff(inv.checkIn, 'minutes').minutes);
        totalWorkedMinutes += Math.max(0, dur - inv.unpaidBreakMinutes);
      }
    }

    // 6. Lateness policy, penalty and warning (policy/salary in force for the payroll month)
    const [policyRows] = await conn.execute<RowDataPacket[]>(
      `SELECT id, late_grace_minutes, late_deduction_percentage, salary_working_day_divisor
       FROM restaurant_policy_versions
       WHERE restaurant_id = ? AND effective_from_month <= ?
       ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
      [restaurantId, day.payroll_month]
    );
    const policy = policyRows[0];
    if (!policy) throw new AppError(422, 'NO_POLICY_CONFIGURED', 'No effective policy found for this month');
    const grace = Number(policy.late_grace_minutes);
    const lateDeductPct = new Decimal(policy.late_deduction_percentage);
    const divisor = Number(policy.salary_working_day_divisor);

    const qualifiesLate = maxLateMinutes > grace;

    const [salRows] = await conn.execute<RowDataPacket[]>(
      `SELECT id, monthly_salary FROM employee_salary_versions
       WHERE restaurant_id = ? AND employee_id = ? AND effective_from_month <= ?
       ORDER BY effective_from_month DESC, revision_no DESC LIMIT 1`,
      [restaurantId, day.employee_id, day.payroll_month]
    );
    const salaryVersion = salRows[0];

    if (salaryVersion) {
      const [restRows] = await conn.execute<RowDataPacket[]>(
        `SELECT currency_decimal_places FROM restaurants WHERE id = ?`,
        [restaurantId]
      );
      const currencyDp = Number(restRows[0]?.currency_decimal_places ?? 2);

      const dailySalary = new Decimal(salaryVersion.monthly_salary).dividedBy(divisor);
      const lateDeductionAmount = qualifiesLate
        ? dailySalary.times(lateDeductPct).dividedBy(100).toDecimalPlaces(currencyDp, Decimal.ROUND_HALF_UP)
        : new Decimal(0);

      await conn.execute(
        `INSERT INTO late_penalties
          (restaurant_id, employee_id, attendance_day_id, policy_version_id, salary_version_id, qualifies, late_minutes, daily_salary_basis, deduction_percentage, calculated_amount, source_attendance_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           policy_version_id = VALUES(policy_version_id),
           salary_version_id = VALUES(salary_version_id),
           qualifies = VALUES(qualifies),
           late_minutes = VALUES(late_minutes),
           daily_salary_basis = VALUES(daily_salary_basis),
           deduction_percentage = VALUES(deduction_percentage),
           calculated_amount = VALUES(calculated_amount),
           source_attendance_version = VALUES(source_attendance_version)`,
        [
          restaurantId,
          day.employee_id,
          attendanceDayId,
          policy.id,
          salaryVersion.id,
          qualifiesLate ? 1 : 0,
          maxLateMinutes,
          dailySalary.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8),
          lateDeductPct.toFixed(4),
          lateDeductionAmount.toFixed(4),
          newVersion,
        ]
      );
    }

    if (qualifiesLate) {
      await conn.execute(
        `INSERT INTO warnings
          (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, admin_voided)
         VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival', ?, ?, 1, 1, 0)
         ON DUPLICATE KEY UPDATE
           late_minutes = VALUES(late_minutes),
           reason = VALUES(reason),
           system_qualifies = 1`,
        [
          restaurantId,
          day.employee_id,
          attendanceDayId,
          day.work_date,
          `Arrived ${maxLateMinutes} minutes late (grace period: ${grace} mins)`,
          maxLateMinutes,
        ]
      );
    } else {
      // Preserve history: just stop the system from counting it
      await conn.execute(
        `UPDATE warnings
         SET system_qualifies = 0
         WHERE restaurant_id = ? AND automatic_attendance_day_id = ?`,
        [restaurantId, attendanceDayId]
      );
    }

    // 7. Hour debt source (append-only table: insert if missing, never update/delete;
    //    the payroll engine ignores sources whose day no longer has a shortfall)
    if (body.status === 'COMPLETED') {
      const shortfall = Math.max(0, Number(day.required_minutes) - totalWorkedMinutes);
      if (shortfall > 0) {
        const [existingSrc] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM hour_debt_sources WHERE restaurant_id = ? AND attendance_day_id = ?`,
          [restaurantId, attendanceDayId]
        );
        if (existingSrc.length === 0) {
          await conn.execute(
            `INSERT INTO hour_debt_sources
              (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
             VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)`,
            [restaurantId, day.employee_id, attendanceDayId, day.work_date]
          );
        }
      }
    }

    // 8. Invalidate the (non-finalized) period and queue a recalculation
    await bumpSourceRevision(conn, restaurantId, day.payroll_month, day.payroll_month);

    const monthKey = String(day.payroll_month).slice(0, 7);
    const deduplicationHash = crypto
      .createHash('sha256')
      .update(`PAYROLL_RECALCULATE|${restaurantId}|${monthKey}`)
      .digest();
    // Assignments run left to right: once status is kept as RUNNING, the later IFs keep the running job untouched.
    await conn.execute(
      `INSERT INTO jobs
        (restaurant_id, job_type, deduplication_hash, payload, status, requested_by)
       VALUES (?, 'PAYROLL_RECALCULATE', ?, ?, 'QUEUED', ?)
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'RUNNING', status, 'QUEUED'),
         attempt_count = IF(status = 'RUNNING', attempt_count, 0),
         available_at = IF(status = 'RUNNING', available_at, CURRENT_TIMESTAMP(3)),
         error_text = IF(status = 'RUNNING', error_text, NULL),
         finished_at = IF(status = 'RUNNING', finished_at, NULL)`,
      [restaurantId, deduplicationHash, JSON.stringify({ month: monthKey, trigger: 'attendance_update' }), actorId]
    );

    await recordAuditEvent(
      {
        restaurantId,
        actorId,
        actorKind: req.tenantContext!.accountKind,
        action: 'UPDATE_ATTENDANCE',
        entityType: 'ATTENDANCE_DAY',
        entityId: attendanceDayId,
        requestId: req.requestId,
        beforeValues: previousStatus ? { status: previousStatus } : null,
        afterValues: { status: body.status, workedMinutes: totalWorkedMinutes, maxLateMinutes, scheduleDayId },
      },
      conn
    );

    return { attendanceDayId, rowVersion: newVersion };
  });
}

// PUT /api/v1/restaurants/:restaurantId/attendance/days/by-schedule/:scheduleDayId
// Creates the attendance row lazily on first save (or updates it if it already exists).
attendanceRouter.put('/days/by-schedule/:scheduleDayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await saveAttendance(req, { scheduleDayId: String(req.params.scheduleDayId) });
    res.json({
      data: { message: 'Attendance saved and evaluated successfully', ...result },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/restaurants/:restaurantId/attendance/days/:attendanceDayId
attendanceRouter.put('/days/:attendanceDayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const attendanceDayId = String(req.params.attendanceDayId);
    if (!/^\d+$/.test(attendanceDayId)) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance day record not found');
    const result = await saveAttendance(req, { attendanceDayId });
    res.json({
      data: { message: 'Attendance saved and evaluated successfully', ...result },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/restaurants/:restaurantId/attendance/days/by-employee/:employeeId
// Allows recording/editing attendance directly for an employee on any given work date
attendanceRouter.put('/days/by-employee/:employeeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employeeId = String(req.params.employeeId);
    const workDate = String(req.query.workDate || req.body.workDate);
    if (!ISO_DATE_RE.test(workDate) || !DateTime.fromISO(workDate).isValid) {
      throw new AppError(422, 'INVALID_DATE', 'workDate must be a valid YYYY-MM-DD date');
    }
    const result = await saveAttendance(req, { employeeId, workDate });
    res.json({
      data: { message: 'Attendance saved and evaluated successfully', ...result },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

