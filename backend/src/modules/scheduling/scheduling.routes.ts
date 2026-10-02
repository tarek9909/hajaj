import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { bulkScheduleSchema, updateScheduleDaySchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const schedulingRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/schedules?from=YYYY-MM-DD&to=YYYY-MM-DD
schedulingRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const from = req.query.from as string;
    const to = req.query.to as string;

    if (!from || !to) {
      throw new AppError(422, 'INVALID_QUERY', 'Both "from" and "to" date parameters (YYYY-MM-DD) are required');
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
      intervals: intervals
        .filter((inv) => String(inv.schedule_day_id) === String(d.id))
        .map((inv) => ({
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

    const startDt = DateTime.fromISO(body.dateFrom);
    const endDt = DateTime.fromISO(body.dateTo);

    if (endDt < startDt) {
      throw new AppError(422, 'INVALID_DATE_RANGE', 'dateTo must be on or after dateFrom');
    }

    // Check finalized periods
    const [finalized] = await pool.execute<RowDataPacket[]>(
      `SELECT DATE_FORMAT(month_start, '%Y-%m') AS finalized_month 
       FROM payroll_periods 
       WHERE restaurant_id = ? AND status = 'FINALIZED' 
         AND month_start <= ? AND DATE_ADD(month_start, INTERVAL 1 MONTH) > ?`,
      [restaurantId, body.dateTo, body.dateFrom]
    );
    if (finalized.length > 0) {
      throw new AppError(
        409,
        'PAYROLL_PERIOD_FINALIZED',
        `Cannot schedule dates in finalized month(s): ${finalized.map((f) => f.finalized_month).join(', ')}`
      );
    }

    // Fetch template if provided
    let templateName: string | null = null;
    let templateIntervals: any[] = [];
    let templatePaidMinutes = 0;

    if (body.shiftTemplateId) {
      const [tRows] = await pool.execute<RowDataPacket[]>(
        `SELECT name FROM shift_templates WHERE restaurant_id = ? AND id = ?`,
        [restaurantId, body.shiftTemplateId]
      );
      if (!tRows[0]) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Shift template not found');
      templateName = tRows[0].name;

      const [invRows] = await pool.execute<RowDataPacket[]>(
        `SELECT sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes 
         FROM shift_template_intervals 
         WHERE restaurant_id = ? AND shift_template_id = ? 
         ORDER BY sequence_number ASC`,
        [restaurantId, body.shiftTemplateId]
      );
      templateIntervals = invRows;

      for (const inv of invRows) {
        const [sh, sm] = inv.start_local_time.split(':').map(Number);
        const [eh, em] = inv.end_local_time.split(':').map(Number);
        const startTotal = (inv.start_day_offset * 24 + sh) * 60 + sm;
        const endTotal = (inv.end_day_offset * 24 + eh) * 60 + em;
        templatePaidMinutes += endTotal - startTotal - inv.planned_unpaid_break_minutes;
      }
    }

    // Expand dates matching weekdays
    const expandedDates: string[] = [];
    let cur = startDt;
    while (cur <= endDt) {
      // Luxon weekday: 1 = Mon ... 7 = Sun
      if (body.weekdays.includes(cur.weekday)) {
        expandedDates.push(cur.toISODate()!);
      }
      cur = cur.plus({ days: 1 });
    }

    // Check existing entries
    const [existingEntries] = await pool.execute<RowDataPacket[]>(
      `SELECT employee_id, DATE_FORMAT(work_date, '%Y-%m-%d') AS work_date 
       FROM schedule_days 
       WHERE restaurant_id = ? AND work_date BETWEEN ? AND ? 
         AND employee_id IN (${body.employeeIds.map(() => '?').join(',')})`,
      [restaurantId, body.dateFrom, body.dateTo, ...body.employeeIds]
    );

    const existingSet = new Set(existingEntries.map((e) => `${e.employee_id}_${e.work_date}`));
    const overwriteCount = body.employeeIds.reduce((acc, empId) => {
      return acc + expandedDates.filter((d) => existingSet.has(`${empId}_${d}`)).length;
    }, 0);

    const totalSlots = body.employeeIds.length * expandedDates.length;

    res.json({
      data: {
        totalSlots,
        affectedEmployees: body.employeeIds.length,
        affectedDatesCount: expandedDates.length,
        overwrittenCount: overwriteCount,
        dayType: body.dayType,
        shiftTemplateId: body.shiftTemplateId || null,
        templateName,
        plannedPaidMinutesPerDay: body.dayType === 'WORK' ? templatePaidMinutes : 0,
        sampleDates: expandedDates.slice(0, 10),
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

    const startDt = DateTime.fromISO(body.dateFrom);
    const endDt = DateTime.fromISO(body.dateTo);

    // Expand dates
    const expandedDates: string[] = [];
    let cur = startDt;
    while (cur <= endDt) {
      if (body.weekdays.includes(cur.weekday)) {
        expandedDates.push(cur.toISODate()!);
      }
      cur = cur.plus({ days: 1 });
    }

    if (expandedDates.length === 0) {
      res.json({ data: { count: 0, message: 'No dates matched the selected weekday pattern.' } });
      return;
    }

    await withTransaction(async (conn) => {
      // 1. Fetch restaurant timezone
      const [restRows] = await conn.execute<RowDataPacket[]>(
        `SELECT timezone FROM restaurants WHERE id = ?`,
        [restaurantId]
      );
      const timezone = restRows[0]?.timezone || 'UTC';

      // 2. Fetch template intervals if work day
      let templateIntervals: any[] = [];
      let requiredMinutes = 0;
      if (body.dayType === 'WORK' && body.shiftTemplateId) {
        const [invRows] = await conn.execute<RowDataPacket[]>(
          `SELECT sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes 
           FROM shift_template_intervals 
           WHERE restaurant_id = ? AND shift_template_id = ? 
           ORDER BY sequence_number ASC`,
          [restaurantId, body.shiftTemplateId]
        );
        templateIntervals = invRows;

        for (const inv of invRows) {
          const [sh, sm] = inv.start_local_time.split(':').map(Number);
          const [eh, em] = inv.end_local_time.split(':').map(Number);
          const startTotal = (inv.start_day_offset * 24 + sh) * 60 + sm;
          const endTotal = (inv.end_day_offset * 24 + eh) * 60 + em;
          requiredMinutes += endTotal - startTotal - inv.planned_unpaid_break_minutes;
        }
      }

      // Fetch active policy
      const [polRows] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM restaurant_policy_versions 
         WHERE restaurant_id = ? AND effective_from_month <= ? 
         ORDER BY effective_from_month DESC LIMIT 1`,
        [restaurantId, body.dateFrom]
      );
      const policyVersionId = polRows[0]?.id;
      if (!policyVersionId) {
        throw new AppError(400, 'NO_POLICY_CONFIGURED', 'No effective policy found for this period');
      }

      // 3. For each employee and date, ensure payroll_period exists, insert/update schedule_days
      const monthsAffected = new Set<string>();

      for (const empId of body.employeeIds) {
        for (const dateStr of expandedDates) {
          const monthStart = `${dateStr.slice(0, 7)}-01`;
          monthsAffected.add(monthStart);

          // Ensure payroll period exists
          await conn.execute(
            `INSERT IGNORE INTO payroll_periods (restaurant_id, month_start, status, source_revision)
             VALUES (?, ?, 'DRAFT', 1)`,
            [restaurantId, monthStart]
          );

          // Check if finalized
          const [periodRows] = await conn.execute<RowDataPacket[]>(
            `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
            [restaurantId, monthStart]
          );
          if (periodRows[0]?.status === 'FINALIZED') {
            throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', `Cannot modify schedule in finalized month ${monthStart}`);
          }

          // Insert or update schedule_day
          const [dayRes] = await conn.execute<ResultSetHeader>(
            `INSERT INTO schedule_days 
              (restaurant_id, employee_id, work_date, payroll_month, day_type, source_template_id, policy_version_id, required_minutes, timezone_snapshot, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               day_type = VALUES(day_type),
               source_template_id = VALUES(source_template_id),
               required_minutes = VALUES(required_minutes),
               row_version = row_version + 1,
               updated_by = VALUES(updated_by)`,
            [
              restaurantId,
              empId,
              dateStr,
              monthStart,
              body.dayType,
              body.shiftTemplateId || null,
              policyVersionId,
              body.dayType === 'WORK' ? requiredMinutes : 0,
              timezone,
              actorId,
              actorId,
            ]
          );

          // Get schedule_day_id
          let scheduleDayId: number;
          if (dayRes.insertId) {
            scheduleDayId = dayRes.insertId;
          } else {
            const [existing] = await conn.execute<RowDataPacket[]>(
              `SELECT id FROM schedule_days WHERE restaurant_id = ? AND employee_id = ? AND work_date = ?`,
              [restaurantId, empId, dateStr]
            );
            scheduleDayId = Number(existing[0]!.id);
          }

          // Delete old intervals if updating
          await conn.execute(
            `DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`,
            [restaurantId, scheduleDayId]
          );

          // Insert new intervals
          if (body.dayType === 'WORK' && templateIntervals.length > 0) {
            for (const inv of templateIntervals) {
              const baseDt = DateTime.fromISO(dateStr, { zone: timezone });
              const [sh, sm] = inv.start_local_time.split(':').map(Number);
              const [eh, em] = inv.end_local_time.split(':').map(Number);

              const startDt = baseDt.plus({ days: inv.start_day_offset }).set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
              const endDt = baseDt.plus({ days: inv.end_day_offset }).set({ hour: eh, minute: em, second: 0, millisecond: 0 });

              await conn.execute(
                `INSERT INTO schedule_intervals 
                  (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  restaurantId,
                  empId,
                  scheduleDayId,
                  inv.sequence_number,
                  startDt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss.SSS'),
                  endDt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss.SSS'),
                  inv.planned_unpaid_break_minutes,
                ]
              );
            }
          }
        }
      }

      // Increment source_revision on affected payroll periods
      for (const m of monthsAffected) {
        await conn.execute(
          `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
          [restaurantId, m]
        );
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'BULK_SCHEDULE_COMMIT',
          entityType: 'SCHEDULE',
          requestId: req.requestId,
          afterValues: { totalApplied: body.employeeIds.length * expandedDates.length },
        },
        conn
      );
    });

    res.json({
      data: {
        message: 'Bulk schedule applied successfully',
        count: body.employeeIds.length * expandedDates.length,
      },
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

    await withTransaction(async (conn) => {
      // 1. Check schedule day and period
      const [dayRows] = await conn.execute<RowDataPacket[]>(
        `SELECT d.id, d.employee_id, d.work_date, d.payroll_month, d.row_version, p.status AS period_status 
         FROM schedule_days d
         JOIN payroll_periods p ON p.restaurant_id = d.restaurant_id AND p.month_start = d.payroll_month
         WHERE d.restaurant_id = ? AND d.id = ?`,
        [restaurantId, scheduleDayId]
      );
      const day = dayRows[0];
      if (!day) throw new AppError(404, 'SCHEDULE_DAY_NOT_FOUND', 'Schedule day not found');
      if (day.period_status === 'FINALIZED') {
        throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', 'Cannot modify schedule in a finalized period');
      }
      if (Number(day.row_version) !== body.expectedVersion) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Schedule day was modified by another administrator');
      }

      // Calculate required minutes
      let requiredMinutes = 0;
      if (body.dayType === 'WORK' && body.intervals && body.intervals.length > 0) {
        for (const inv of body.intervals) {
          const start = DateTime.fromISO(inv.plannedStartAt);
          const end = DateTime.fromISO(inv.plannedEndAt);
          const dur = Math.floor(end.diff(start, 'minutes').minutes);
          requiredMinutes += Math.max(0, dur - (inv.plannedUnpaidBreakMinutes || 0));
        }
      }

      // Update schedule day
      await conn.execute(
        `UPDATE schedule_days 
         SET day_type = ?,
             source_template_id = ?,
             required_minutes = ?,
             exception_reason = ?,
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ?`,
        [
          body.dayType,
          body.shiftTemplateId || null,
          requiredMinutes,
          body.exceptionReason || null,
          actorId,
          restaurantId,
          scheduleDayId,
        ]
      );

      // Replace intervals
      await conn.execute(`DELETE FROM schedule_intervals WHERE restaurant_id = ? AND schedule_day_id = ?`, [
        restaurantId,
        scheduleDayId,
      ]);

      if (body.dayType === 'WORK' && body.intervals) {
        for (const inv of body.intervals) {
          await conn.execute(
            `INSERT INTO schedule_intervals 
              (restaurant_id, employee_id, schedule_day_id, sequence_number, planned_start_at, planned_end_at, planned_unpaid_break_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              restaurantId,
              day.employee_id,
              scheduleDayId,
              inv.sequenceNumber,
              DateTime.fromISO(inv.plannedStartAt).toUTC().toFormat('yyyy-MM-dd HH:mm:ss.SSS'),
              DateTime.fromISO(inv.plannedEndAt).toUTC().toFormat('yyyy-MM-dd HH:mm:ss.SSS'),
              inv.plannedUnpaidBreakMinutes,
            ]
          );
        }
      }

      // Increment source_revision
      await conn.execute(
        `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
        [restaurantId, day.payroll_month]
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
