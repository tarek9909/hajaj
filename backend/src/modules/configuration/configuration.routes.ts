import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import {
  createPolicyVersionSchema,
  createPositionSchema,
  updatePositionSchema,
  createDeductionTypeSchema,
  updateDeductionTypeSchema,
  createShiftTemplateSchema,
} from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const configurationRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/configuration?month=YYYY-MM
configurationRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const monthStart = `${month}-01`;

    // 1. Get restaurant info
    const [restRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, currency_code, currency_decimal_places, timezone, status, DATE_FORMAT(payroll_start_month, '%Y-%m-01') AS payroll_start_month, row_version
       FROM restaurants WHERE id = ?`,
      [restaurantId]
    );
    const restaurant = restRows[0];
    if (!restaurant) {
      throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
    }

    // 2. Get applicable policy version (latest version effective on or before monthStart)
    const [polRows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        id,
        restaurant_id,
        DATE_FORMAT(effective_from_month, '%Y-%m-01') AS effective_from_month,
        revision_no,
        salary_working_day_divisor,
        standard_daily_minutes,
        overtime_multiplier,
        late_grace_minutes,
        late_deduction_percentage,
        warning_threshold,
        warning_counting_period,
        custom_warnings_count_by_default,
        debt_settlement_mode,
        carry_debt_forward,
        reason,
        created_at
       FROM restaurant_policy_versions
       WHERE restaurant_id = ? AND effective_from_month <= ?
       ORDER BY effective_from_month DESC, revision_no DESC
       LIMIT 1`,
      [restaurantId, monthStart]
    );

    // Fallback to earliest policy if none <= monthStart
    let policy = polRows[0];
    if (!policy) {
      const [fallbackRows] = await pool.execute<RowDataPacket[]>(
        `SELECT * FROM restaurant_policy_versions WHERE restaurant_id = ? ORDER BY effective_from_month ASC LIMIT 1`,
        [restaurantId]
      );
      policy = fallbackRows[0];
    }

    // 3. Get positions
    const [positions] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, status, row_version FROM positions WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );

    // 4. Get deduction types
    const [deductionTypes] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, calculation_method, default_value, status, row_version FROM deduction_types WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );

    // 5. Get shift templates with intervals
    const [templates] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, status, row_version FROM shift_templates WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );

    const [intervals] = await pool.execute<RowDataPacket[]>(
      `SELECT id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes 
       FROM shift_template_intervals 
       WHERE restaurant_id = ? 
       ORDER BY shift_template_id ASC, sequence_number ASC`,
      [restaurantId]
    );

    const templatesWithIntervals = templates.map((t) => ({
      id: String(t.id),
      name: t.name,
      status: t.status,
      rowVersion: Number(t.row_version),
      intervals: intervals
        .filter((inv) => String(inv.shift_template_id) === String(t.id))
        .map((inv) => ({
          id: String(inv.id),
          sequenceNumber: inv.sequence_number,
          startLocalTime: inv.start_local_time,
          startDayOffset: inv.start_day_offset,
          endLocalTime: inv.end_local_time,
          endDayOffset: inv.end_day_offset,
          plannedUnpaidBreakMinutes: inv.planned_unpaid_break_minutes,
        })),
    }));

    res.json({
      data: {
        restaurant: {
          id: String(restaurant.id),
          name: restaurant.name,
          currencyCode: restaurant.currency_code,
          currencyDecimalPlaces: restaurant.currency_decimal_places,
          timezone: restaurant.timezone,
          status: restaurant.status,
          payrollStartMonth: restaurant.payroll_start_month,
          rowVersion: Number(restaurant.row_version),
        },
        policy: policy
          ? {
              id: String(policy.id),
              effectiveFromMonth: policy.effective_from_month,
              revisionNo: policy.revision_no,
              salaryWorkingDayDivisor: policy.salary_working_day_divisor,
              standardDailyMinutes: policy.standard_daily_minutes,
              overtimeMultiplier: Number(policy.overtime_multiplier),
              lateGraceMinutes: policy.late_grace_minutes,
              lateDeductionPercentage: Number(policy.late_deduction_percentage),
              warningThreshold: policy.warning_threshold,
              customWarningsCountByDefault: Boolean(policy.custom_warnings_count_by_default),
              debtSettlementMode: policy.debt_settlement_mode,
              carryDebtForward: Boolean(policy.carry_debt_forward),
              reason: policy.reason,
            }
          : null,
        positions: positions.map((p) => ({
          id: String(p.id),
          name: p.name,
          status: p.status,
          rowVersion: Number(p.row_version),
        })),
        deductionTypes: deductionTypes.map((d) => ({
          id: String(d.id),
          name: d.name,
          calculationMethod: d.calculation_method,
          defaultValue: Number(d.default_value),
          status: d.status,
          rowVersion: Number(d.row_version),
        })),
        shiftTemplates: templatesWithIntervals,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/restaurants/:restaurantId/configuration/policy-history
configurationRouter.get('/policy-history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        p.id,
        DATE_FORMAT(p.effective_from_month, '%Y-%m-01') AS effective_from_month,
        p.revision_no,
        p.salary_working_day_divisor,
        p.standard_daily_minutes,
        p.overtime_multiplier,
        p.late_grace_minutes,
        p.late_deduction_percentage,
        p.warning_threshold,
        p.custom_warnings_count_by_default,
        p.reason,
        p.created_at,
        a.full_name AS created_by_name
       FROM restaurant_policy_versions p
       JOIN admin_accounts a ON a.id = p.created_by
       WHERE p.restaurant_id = ?
       ORDER BY p.effective_from_month DESC, p.revision_no DESC`,
      [restaurantId]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        effectiveFromMonth: r.effective_from_month,
        revisionNo: r.revision_no,
        salaryWorkingDayDivisor: r.salary_working_day_divisor,
        standardDailyMinutes: r.standard_daily_minutes,
        overtimeMultiplier: Number(r.overtime_multiplier),
        lateGraceMinutes: r.late_grace_minutes,
        lateDeductionPercentage: Number(r.late_deduction_percentage),
        warningThreshold: r.warning_threshold,
        customWarningsCountByDefault: Boolean(r.custom_warnings_count_by_default),
        reason: r.reason,
        createdByName: r.created_by_name,
        createdAt: r.created_at,
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/configuration/policy-versions
configurationRouter.post('/policy-versions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createPolicyVersionSchema.parse(req.body);

    const [latest] = await pool.execute<RowDataPacket[]>(
      `SELECT revision_no FROM restaurant_policy_versions 
       WHERE restaurant_id = ? AND effective_from_month = ? 
       ORDER BY revision_no DESC LIMIT 1`,
      [restaurantId, body.effectiveFromMonth]
    );
    const nextRevision = latest[0] ? Number(latest[0].revision_no) + 1 : 1;

    const [insertRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO restaurant_policy_versions 
        (restaurant_id, effective_from_month, revision_no, salary_working_day_divisor, standard_daily_minutes, overtime_multiplier, late_grace_minutes, late_deduction_percentage, warning_threshold, custom_warnings_count_by_default, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        restaurantId,
        body.effectiveFromMonth,
        nextRevision,
        body.salaryWorkingDayDivisor,
        body.standardDailyMinutes,
        body.overtimeMultiplier,
        body.lateGraceMinutes,
        body.lateDeductionPercentage,
        body.warningThreshold,
        body.customWarningsCountByDefault ? 1 : 0,
        body.reason,
        actorId,
      ]
    );

    // Increment payroll source revision for the affected period
    await pool.execute(
      `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start >= ?`,
      [restaurantId, body.effectiveFromMonth]
    );

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: req.tenantContext!.accountKind,
      action: 'CREATE_POLICY_VERSION',
      entityType: 'RESTAURANT_POLICY',
      entityId: String(insertRes.insertId),
      requestId: req.requestId,
      afterValues: body,
    });

    res.status(201).json({
      data: {
        id: String(insertRes.insertId),
        revisionNo: nextRevision,
        message: 'New policy version created successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POSITIONS
configurationRouter.get('/positions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, status, row_version FROM positions WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );
    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        status: r.status,
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

configurationRouter.post('/positions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createPositionSchema.parse(req.body);

    const [insertRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO positions (restaurant_id, name, status, created_by) VALUES (?, ?, 'ACTIVE', ?)`,
      [restaurantId, body.name, actorId]
    );

    res.status(201).json({
      data: { id: String(insertRes.insertId), name: body.name, status: 'ACTIVE', rowVersion: 1 },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

configurationRouter.patch('/positions/:positionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const positionId = String(req.params.positionId);
    const body = updatePositionSchema.parse(req.body);

    const [updateRes] = await pool.execute<ResultSetHeader>(
      `UPDATE positions 
       SET name = COALESCE(?, name),
           status = COALESCE(?, status),
           row_version = row_version + 1,
           updated_by = ?
       WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
      [body.name || null, body.status || null, actorId, restaurantId, positionId, body.expectedVersion]
    );

    if (updateRes.affectedRows === 0) {
      throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Position was modified by another administrator');
    }

    res.json({
      data: { message: 'Position updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// DEDUCTION TYPES
configurationRouter.get('/deduction-types', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, calculation_method, default_value, status, row_version FROM deduction_types WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );
    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        calculationMethod: r.calculation_method,
        defaultValue: Number(r.default_value),
        status: r.status,
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

configurationRouter.post('/deduction-types', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createDeductionTypeSchema.parse(req.body);

    const [insertRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO deduction_types (restaurant_id, name, calculation_method, default_value, status, created_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
      [restaurantId, body.name, body.calculationMethod, body.defaultValue, actorId]
    );

    res.status(201).json({
      data: { id: String(insertRes.insertId), ...body, status: 'ACTIVE', rowVersion: 1 },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

configurationRouter.patch('/deduction-types/:deductionTypeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const deductionTypeId = String(req.params.deductionTypeId);
    const body = updateDeductionTypeSchema.parse(req.body);

    const [updateRes] = await pool.execute<ResultSetHeader>(
      `UPDATE deduction_types 
       SET name = COALESCE(?, name),
           calculation_method = COALESCE(?, calculation_method),
           default_value = COALESCE(?, default_value),
           status = COALESCE(?, status),
           row_version = row_version + 1,
           updated_by = ?
       WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
      [
        body.name || null,
        body.calculationMethod || null,
        body.defaultValue !== undefined ? body.defaultValue : null,
        body.status || null,
        actorId,
        restaurantId,
        deductionTypeId,
        body.expectedVersion,
      ]
    );

    if (updateRes.affectedRows === 0) {
      throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Deduction type was modified by another administrator');
    }

    res.json({
      data: { message: 'Deduction type updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// SHIFT TEMPLATES
configurationRouter.get('/shift-templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [templates] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, status, row_version FROM shift_templates WHERE restaurant_id = ? ORDER BY name ASC`,
      [restaurantId]
    );

    const [intervals] = await pool.execute<RowDataPacket[]>(
      `SELECT id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes 
       FROM shift_template_intervals 
       WHERE restaurant_id = ? 
       ORDER BY shift_template_id ASC, sequence_number ASC`,
      [restaurantId]
    );

    const data = templates.map((t) => ({
      id: String(t.id),
      name: t.name,
      status: t.status,
      rowVersion: Number(t.row_version),
      intervals: intervals
        .filter((inv) => String(inv.shift_template_id) === String(t.id))
        .map((inv) => ({
          id: String(inv.id),
          sequenceNumber: inv.sequence_number,
          startLocalTime: inv.start_local_time,
          startDayOffset: inv.start_day_offset,
          endLocalTime: inv.end_local_time,
          endDayOffset: inv.end_day_offset,
          plannedUnpaidBreakMinutes: inv.planned_unpaid_break_minutes,
        })),
    }));

    res.json({ data, meta: { requestId: req.requestId } });
  } catch (err) {
    next(err);
  }
});

configurationRouter.post('/shift-templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createShiftTemplateSchema.parse(req.body);

    const result = await withTransaction(async (conn) => {
      const [tRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO shift_templates (restaurant_id, name, status, created_by) VALUES (?, ?, 'ACTIVE', ?)`,
        [restaurantId, body.name, actorId]
      );
      const templateId = tRes.insertId;

      for (const inv of body.intervals) {
        // Ensure format is HH:MM:00
        const start = inv.startLocalTime.length === 5 ? `${inv.startLocalTime}:00` : inv.startLocalTime;
        const end = inv.endLocalTime.length === 5 ? `${inv.endLocalTime}:00` : inv.endLocalTime;

        await conn.execute(
          `INSERT INTO shift_template_intervals 
            (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            restaurantId,
            templateId,
            inv.sequenceNumber,
            start,
            inv.startDayOffset,
            end,
            inv.endDayOffset,
            inv.plannedUnpaidBreakMinutes,
          ]
        );
      }
      return templateId;
    });

    res.status(201).json({
      data: { id: String(result), message: 'Shift template created successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
