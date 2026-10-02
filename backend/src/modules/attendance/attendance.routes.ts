import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { Decimal } from 'decimal.js';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { updateAttendanceDaySchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const attendanceRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/attendance?date=YYYY-MM-DD
attendanceRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const date = (req.query.date as string) || DateTime.utc().toISODate()!;

    // 1. Ensure attendance_days records exist for all scheduled employees on this date
    const [scheduledDays] = await pool.execute<RowDataPacket[]>(
      `SELECT d.id, d.employee_id, d.work_date 
       FROM schedule_days d
       LEFT JOIN attendance_days a ON a.restaurant_id = d.restaurant_id AND a.schedule_day_id = d.id
       WHERE d.restaurant_id = ? AND d.work_date = ? AND a.id IS NULL`,
      [restaurantId, date]
    );

    if (scheduledDays.length > 0) {
      const actorId = req.tenantContext!.actorId;
      for (const sd of scheduledDays) {
        await pool.execute(
          `INSERT IGNORE INTO attendance_days 
            (restaurant_id, employee_id, schedule_day_id, work_date, status, created_by, updated_by)
           VALUES (?, ?, ?, ?, 'NOT_RECORDED', ?, ?)`,
          [restaurantId, sd.employee_id, sd.id, date, actorId, actorId]
        );
      }
    }

    // 2. Fetch attendance rows joined with employee, schedule, intervals, warning, penalty
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        a.id AS attendance_day_id,
        a.employee_id,
        e.full_name AS employee_name,
        e.employee_number,
        p.name AS position_name,
        a.schedule_day_id,
        d.day_type,
        d.required_minutes,
        t.name AS template_name,
        a.work_date,
        a.status AS attendance_status,
        a.additional_work_approved,
        a.notes,
        a.row_version,
        w.id AS automatic_warning_id,
        w.late_minutes AS warning_late_minutes,
        w.system_qualifies AS warning_system_qualifies,
        w.admin_voided AS warning_admin_voided,
        lp.qualifies AS penalty_qualifies,
        lp.calculated_amount AS penalty_amount
       FROM attendance_days a
       JOIN employees e ON e.id = a.employee_id
       JOIN positions p ON p.id = e.position_id
       JOIN schedule_days d ON d.id = a.schedule_day_id
       LEFT JOIN shift_templates t ON t.id = d.source_template_id
       LEFT JOIN warnings w ON w.restaurant_id = a.restaurant_id AND w.automatic_attendance_day_id = a.id
       LEFT JOIN late_penalties lp ON lp.restaurant_id = a.restaurant_id AND lp.attendance_day_id = a.id
       WHERE a.restaurant_id = ? AND a.work_date = ?
       ORDER BY e.full_name ASC`,
      [restaurantId, date]
    );

    // Fetch planned intervals
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

    // Fetch actual attendance intervals
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
      const pl = plannedIntervals.filter((i) => String(i.schedule_day_id) === String(r.schedule_day_id));
      const act = actualIntervals.filter((i) => String(i.attendance_day_id) === String(r.attendance_day_id));

      // Calculate on-the-fly worked minutes
      let workedMinutes = 0;
      let isComplete = r.attendance_status === 'COMPLETED';
      let hasArrival = false;
      let maxLate = 0;

      for (let idx = 0; idx < act.length; idx++) {
        const aInt = act[idx]!;
        if (aInt.check_in_at) {
          hasArrival = true;
          const pInt = pl[idx];
          if (pInt && pInt.planned_start_at) {
            const inDt = DateTime.fromISO(aInt.check_in_at, { setZone: true });
            const pDt = DateTime.fromISO(pInt.planned_start_at, { setZone: true });
            const diff = Math.floor(inDt.diff(pDt, 'minutes').minutes);
            if (diff > maxLate) maxLate = diff;
          }
        }
        if (aInt.check_in_at && aInt.check_out_at) {
          const inDt = DateTime.fromISO(aInt.check_in_at);
          const outDt = DateTime.fromISO(aInt.check_out_at);
          const dur = Math.floor(outDt.diff(inDt, 'minutes').minutes);
          workedMinutes += Math.max(0, dur - (aInt.unpaid_break_minutes || 0));
        }
      }

      const shortfallMinutes = isComplete ? Math.max(0, r.required_minutes - workedMinutes) : null;
      const additionalMinutes = isComplete ? Math.max(0, workedMinutes - r.required_minutes) : null;

      return {
        attendanceDayId: String(r.attendance_day_id),
        employeeId: String(r.employee_id),
        employeeName: r.employee_name,
        employeeNumber: r.employee_number,
        positionName: r.position_name,
        scheduleDayId: String(r.schedule_day_id),
        dayType: r.day_type,
        templateName: r.template_name,
        requiredMinutes: r.required_minutes,
        workDate: r.work_date,
        attendanceStatus: r.attendance_status,
        additionalWorkApproved: Boolean(r.additional_work_approved),
        notes: r.notes,
        workedMinutes: isComplete ? workedMinutes : null,
        shortfallMinutes,
        additionalMinutes,
        lateMinutes: hasArrival ? maxLate : 0,
        qualifiesLatePenalty: Boolean(r.penalty_qualifies),
        latePenaltyAmount: Number(r.penalty_amount || 0),
        hasAutomaticWarning: Boolean(r.automatic_warning_id && r.warning_system_qualifies && !r.warning_admin_voided),
        rowVersion: Number(r.row_version),
        plannedIntervals: pl.map((i) => ({
          id: String(i.id),
          sequenceNumber: i.sequence_number,
          plannedStartAt: i.planned_start_at,
          plannedEndAt: i.planned_end_at,
          plannedUnpaidBreakMinutes: i.planned_unpaid_break_minutes,
        })),
        actualIntervals: act.map((i) => ({
          id: String(i.id),
          scheduleIntervalId: i.schedule_interval_id ? String(i.schedule_interval_id) : null,
          sequenceNumber: i.sequence_number,
          checkInAt: i.check_in_at,
          checkOutAt: i.check_out_at,
          unpaidBreakMinutes: i.unpaid_break_minutes,
        })),
      };
    });

    res.json({ data, meta: { requestId: req.requestId } });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/restaurants/:restaurantId/attendance/days/:attendanceDayId
attendanceRouter.put('/days/:attendanceDayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const attendanceDayId = String(req.params.attendanceDayId);
    const actorId = req.tenantContext!.actorId;
    const body = updateAttendanceDaySchema.parse(req.body);

    await withTransaction(async (conn) => {
      // 1. Fetch attendance day, schedule day, and check finalized period
      const [attRows] = await conn.execute<RowDataPacket[]>(
        `SELECT a.id, a.employee_id, a.schedule_day_id, DATE_FORMAT(a.work_date, '%Y-%m-%d') AS work_date,
                a.row_version, d.payroll_month, d.required_minutes, d.policy_version_id, p.status AS period_status
         FROM attendance_days a
         JOIN schedule_days d ON d.id = a.schedule_day_id
         JOIN payroll_periods p ON p.restaurant_id = a.restaurant_id AND p.month_start = d.payroll_month
         WHERE a.restaurant_id = ? AND a.id = ?`,
        [restaurantId, attendanceDayId]
      );

      const att = attRows[0];
      if (!att) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance day record not found');
      if (att.period_status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot modify attendance in a finalized month');
      }
      if (Number(att.row_version) !== body.expectedVersion) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Attendance record was modified by another administrator');
      }

      // 2. Fetch planned intervals
      const [plannedIntervals] = await conn.execute<RowDataPacket[]>(
        `SELECT id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes 
         FROM schedule_intervals 
         WHERE restaurant_id = ? AND schedule_day_id = ? 
         ORDER BY sequence_number ASC`,
        [restaurantId, att.schedule_day_id]
      );

      // 3. Update attendance_days record
      await conn.execute(
        `UPDATE attendance_days 
         SET status = ?, 
             additional_work_approved = ?, 
             notes = ?, 
             row_version = row_version + 1, 
             updated_by = ?
         WHERE restaurant_id = ? AND id = ?`,
        [
          body.status,
          body.additionalWorkApproved ? 1 : 0,
          body.notes || null,
          actorId,
          restaurantId,
          attendanceDayId,
        ]
      );

      // 4. Replace attendance_intervals
      await conn.execute(
        `DELETE FROM attendance_intervals WHERE restaurant_id = ? AND attendance_day_id = ?`,
        [restaurantId, attendanceDayId]
      );

      let maxLateMinutes = 0;
      let totalWorkedMinutes = 0;

      for (const inv of body.intervals) {
        const inUtc = DateTime.fromISO(inv.checkInAt).toUTC().toFormat('yyyy-MM-dd HH:mm:ss.000');
        const outUtc = inv.checkOutAt
          ? DateTime.fromISO(inv.checkOutAt).toUTC().toFormat('yyyy-MM-dd HH:mm:ss.000')
          : null;

        await conn.execute(
          `INSERT INTO attendance_intervals 
            (restaurant_id, employee_id, schedule_day_id, attendance_day_id, schedule_interval_id, sequence_number, check_in_at, check_out_at, unpaid_break_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            restaurantId,
            att.employee_id,
            att.schedule_day_id,
            attendanceDayId,
            inv.scheduleIntervalId || null,
            inv.sequenceNumber,
            inUtc,
            outUtc,
            inv.unpaidBreakMinutes,
          ]
        );

        // Evaluate lateness against corresponding planned interval
        const plan = plannedIntervals.find((p) => String(p.id) === String(inv.scheduleIntervalId)) || plannedIntervals[inv.sequenceNumber - 1];
        if (plan && plan.planned_start_at) {
          const checkInDt = DateTime.fromISO(inv.checkInAt, { setZone: true });
          const planDt = DateTime.fromISO(DateTime.fromJSDate(plan.planned_start_at).toISO()!, { setZone: true });
          const diff = Math.floor(checkInDt.diff(planDt, 'minutes').minutes);
          if (diff > maxLateMinutes) maxLateMinutes = diff;
        }

        if (inv.checkInAt && inv.checkOutAt) {
          const inDt = DateTime.fromISO(inv.checkInAt);
          const outDt = DateTime.fromISO(inv.checkOutAt);
          const dur = Math.floor(outDt.diff(inDt, 'minutes').minutes);
          totalWorkedMinutes += Math.max(0, dur - inv.unpaidBreakMinutes);
        }
      }

      // 5. Evaluate Lateness Policy & Warning
      const [policyRows] = await conn.execute<RowDataPacket[]>(
        `SELECT late_grace_minutes, late_deduction_percentage, salary_working_day_divisor 
         FROM restaurant_policy_versions WHERE id = ?`,
        [att.policy_version_id]
      );
      const policy = policyRows[0];
      const grace = policy ? Number(policy.late_grace_minutes) : 10;
      const lateDeductPct = policy ? Number(policy.late_deduction_percentage) : 10;
      const divisor = policy ? Number(policy.salary_working_day_divisor) : 26;

      const qualifiesLate = maxLateMinutes > grace;

      // Get latest salary version for rate calculation
      const [salRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id, monthly_salary FROM employee_salary_versions 
         WHERE restaurant_id = ? AND employee_id = ? AND effective_from_month <= ? 
         ORDER BY effective_from_month DESC LIMIT 1`,
        [restaurantId, att.employee_id, att.payroll_month]
      );
      const salaryVersion = salRows[0];
      const monthlySalary = salaryVersion ? Number(salaryVersion.monthly_salary) : 0;
      const dailySalary = monthlySalary / divisor;
      const lateDeductionAmount = qualifiesLate ? new Decimal(dailySalary).times(lateDeductPct).dividedBy(100).toNumber() : 0;

      // Insert or update late_penalties
      if (salaryVersion) {
        await conn.execute(
          `INSERT INTO late_penalties 
            (restaurant_id, employee_id, attendance_day_id, policy_version_id, salary_version_id, qualifies, late_minutes, daily_salary_basis, deduction_percentage, calculated_amount, source_attendance_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             qualifies = VALUES(qualifies),
             late_minutes = VALUES(late_minutes),
             daily_salary_basis = VALUES(daily_salary_basis),
             deduction_percentage = VALUES(deduction_percentage),
             calculated_amount = VALUES(calculated_amount),
             source_attendance_version = VALUES(source_attendance_version)`,
          [
            restaurantId,
            att.employee_id,
            attendanceDayId,
            att.policy_version_id,
            salaryVersion.id,
            qualifiesLate ? 1 : 0,
            maxLateMinutes,
            dailySalary,
            lateDeductPct,
            lateDeductionAmount,
            Number(att.row_version) + 1,
          ]
        );
      }

      // Insert or update automatic warning
      if (qualifiesLate) {
        await conn.execute(
          `INSERT INTO warnings 
            (restaurant_id, employee_id, origin, automatic_attendance_day_id, incident_date, title, reason, late_minutes, system_qualifies, counts_toward_limit, admin_voided)
           VALUES (?, ?, 'AUTOMATIC_LATE', ?, ?, 'Late Arrival', ?, ?, 1, 1, 0)
           ON DUPLICATE KEY UPDATE 
             late_minutes = VALUES(late_minutes),
             system_qualifies = 1`,
          [
            restaurantId,
            att.employee_id,
            attendanceDayId,
            att.work_date,
            `Arrived ${maxLateMinutes} minutes late (grace period: ${grace} mins)`,
            maxLateMinutes,
          ]
        );
      } else {
        // If not qualifying, set system_qualifies = 0 (preserving any history)
        await conn.execute(
          `UPDATE warnings 
           SET system_qualifies = 0 
           WHERE restaurant_id = ? AND automatic_attendance_day_id = ?`,
          [restaurantId, attendanceDayId]
        );
      }

      // 6. Handle Hour Debt Source on completed workday with shortfall
      if (body.status === 'COMPLETED') {
        const shortfall = Math.max(0, att.required_minutes - totalWorkedMinutes);
        if (shortfall > 0) {
          await conn.execute(
            `INSERT INTO hour_debt_sources 
              (restaurant_id, employee_id, source_type, attendance_day_id, origin_work_date)
             VALUES (?, ?, 'ATTENDANCE_SHORTFALL', ?, ?)
             ON DUPLICATE KEY UPDATE origin_work_date = VALUES(origin_work_date)`,
            [restaurantId, att.employee_id, attendanceDayId, att.work_date]
          );
        } else {
          // If shortfall is 0 now (e.g. employee worked enough hours or corrected), remove debt source if not waived
          await conn.execute(
            `DELETE FROM hour_debt_sources 
             WHERE restaurant_id = ? AND attendance_day_id = ? 
               AND id NOT IN (SELECT debt_source_id FROM debt_waivers WHERE restaurant_id = ?)`,
            [restaurantId, attendanceDayId, restaurantId]
          );
        }
      }

      // 7. Increment payroll source revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, att.payroll_month]
      );

      // 8. Queue recalculation job
      const deduplicationHash = Buffer.from(
        `recalc_${restaurantId}_${att.payroll_month}_${Date.now()}`.padEnd(32, '0').slice(0, 32)
      );
      await conn.execute(
        `INSERT INTO jobs 
          (restaurant_id, job_type, deduplication_hash, payload, status)
         VALUES (?, 'PAYROLL_RECALCULATE', ?, ?, 'QUEUED')
         ON DUPLICATE KEY UPDATE status = 'QUEUED'`,
        [
          restaurantId,
          deduplicationHash,
          JSON.stringify({ month: att.payroll_month, trigger: 'attendance_update' }),
        ]
      );

      // Audit
      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_ATTENDANCE',
          entityType: 'ATTENDANCE_DAY',
          entityId: attendanceDayId,
          requestId: req.requestId,
          afterValues: { status: body.status, workedMinutes: totalWorkedMinutes, maxLateMinutes },
        },
        conn
      );
    });

    res.json({
      data: { message: 'Attendance saved and evaluated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
