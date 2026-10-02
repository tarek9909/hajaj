import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { z } from 'zod';
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
import { assertMonthNotFinalized, bumpSourceRevision, normalizeMonthStart } from './periodGuards.js';

export const configurationRouter = Router({ mergeParams: true });
export const positionsRouter = Router({ mergeParams: true });
export const deductionTypesRouter = Router({ mergeParams: true });
export const shiftTemplatesRouter = Router({ mergeParams: true });

const POLICY_COLUMNS = `
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
        created_at`;

// Accept YYYY-MM as well as YYYY-MM-01 for the effective month.
const policyBodySchema = createPolicyVersionSchema.extend({
  effectiveFromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/, 'effectiveFromMonth must be YYYY-MM or YYYY-MM-01'),
});

const patchShiftTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  intervals: createShiftTemplateSchema.shape.intervals.optional(),
  expectedVersion: z.number().int().positive(),
});

const idParam = (v: unknown): string => {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  return s;
};

const toHms = (t: string): string => (t.length === 5 ? `${t}:00` : t);

/** Validates template intervals (HH:MM < 24:00, seconds zero, end > start, break < duration, no overlap). */
function validateTemplateIntervals(intervals: z.infer<typeof createShiftTemplateSchema>['intervals']): void {
  const seen = new Set<number>();
  const spans: Array<[number, number]> = [];
  const parse = (t: string): number => {
    const [h, m, s] = t.split(':').map(Number);
    if (h === undefined || m === undefined || h > 23 || m > 59 || (s ?? 0) !== 0) {
      throw new AppError(422, 'INVALID_INTERVAL', `Invalid time "${t}": use HH:MM (00:00 to 23:59)`);
    }
    return h * 60 + m;
  };
  for (const inv of intervals) {
    if (seen.has(inv.sequenceNumber)) {
      throw new AppError(422, 'INVALID_INTERVAL', `Duplicate sequenceNumber ${inv.sequenceNumber}`);
    }
    seen.add(inv.sequenceNumber);
    const start = inv.startDayOffset * 1440 + parse(inv.startLocalTime);
    const end = inv.endDayOffset * 1440 + parse(inv.endLocalTime);
    if (end <= start) {
      throw new AppError(422, 'INVALID_INTERVAL', `Interval ${inv.sequenceNumber}: end must be after start`);
    }
    if (inv.plannedUnpaidBreakMinutes >= end - start) {
      throw new AppError(422, 'INVALID_INTERVAL', `Interval ${inv.sequenceNumber}: unpaid break must be shorter than the interval`);
    }
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) {
      throw new AppError(422, 'INVALID_INTERVAL', 'Shift template intervals must not overlap');
    }
  }
}

/** Run after an UPDATE ... AND row_version = ? matched nothing: distinguish 404 from a version conflict. */
async function throwNotFoundOrConflict(table: string, restaurantId: string, id: string, label: string): Promise<never> {
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id FROM ${table} WHERE restaurant_id = ? AND id = ?`, [
    restaurantId,
    id,
  ]);
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', `${label} not found`);
  throw new AppError(412, 'ROW_VERSION_CONFLICT', `${label} was modified by another administrator`);
}

// GET /api/v1/restaurants/:restaurantId/configuration?month=YYYY-MM
configurationRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const monthStart = req.query.month
      ? normalizeMonthStart(String(req.query.month), 'month')
      : `${new Date().toISOString().slice(0, 7)}-01`;

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
      `SELECT ${POLICY_COLUMNS}
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
        `SELECT ${POLICY_COLUMNS} FROM restaurant_policy_versions WHERE restaurant_id = ? ORDER BY effective_from_month ASC, revision_no ASC LIMIT 1`,
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


// GET /configuration/policies (alias: /policy-history) - list all policy versions
const listPolicyVersions = async (req: Request, res: Response, next: NextFunction) => {
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
};
configurationRouter.get('/policies', listPolicyVersions);
configurationRouter.get('/policy-history', listPolicyVersions);

// POST /configuration/policies (alias: /policy-versions) - create a new policy version
const createPolicyVersion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = policyBodySchema.parse(req.body);
    const effectiveFromMonth = normalizeMonthStart(body.effectiveFromMonth, 'effectiveFromMonth');

    const result = await withTransaction(async (conn) => {
      // Lock the parent row so concurrent revisions for the same month are serialized
      const [parent] = await conn.execute<RowDataPacket[]>(`SELECT id FROM restaurants WHERE id = ? FOR UPDATE`, [
        restaurantId,
      ]);
      if (parent.length === 0) throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');

      await assertMonthNotFinalized(conn, restaurantId, effectiveFromMonth);

      const [latest] = await conn.execute<RowDataPacket[]>(
        `SELECT revision_no FROM restaurant_policy_versions
         WHERE restaurant_id = ? AND effective_from_month = ?
         ORDER BY revision_no DESC LIMIT 1`,
        [restaurantId, effectiveFromMonth]
      );
      const nextRevision = latest[0] ? Number(latest[0].revision_no) + 1 : 1;

      const [insertRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO restaurant_policy_versions
          (restaurant_id, effective_from_month, revision_no, salary_working_day_divisor, standard_daily_minutes, overtime_multiplier, late_grace_minutes, late_deduction_percentage, warning_threshold, custom_warnings_count_by_default, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          restaurantId,
          effectiveFromMonth,
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

      // Only non-finalized periods from the effective month onward are affected
      await bumpSourceRevision(conn, restaurantId, effectiveFromMonth);

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_POLICY_VERSION',
          entityType: 'RESTAURANT_POLICY',
          entityId: String(insertRes.insertId),
          requestId: req.requestId,
          afterValues: { ...body, effectiveFromMonth },
        },
        conn
      );

      return { id: insertRes.insertId, revisionNo: nextRevision };
    });

    res.status(201).json({
      data: {
        id: String(result.id),
        revisionNo: result.revisionNo,
        message: 'New policy version created successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};
configurationRouter.post('/policies', createPolicyVersion);
configurationRouter.post('/policy-versions', createPolicyVersion);

// ==========================================
// POSITIONS  (/configuration/positions and /positions)
// ==========================================
positionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
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

positionsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createPositionSchema.parse(req.body);

    const [insertRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO positions (restaurant_id, name, status, created_by) VALUES (?, ?, 'ACTIVE', ?)`,
      [restaurantId, body.name, actorId]
    );

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: req.tenantContext!.accountKind,
      action: 'CREATE_POSITION',
      entityType: 'POSITION',
      entityId: String(insertRes.insertId),
      requestId: req.requestId,
      afterValues: { name: body.name },
    });

    res.status(201).json({
      data: {
        id: String(insertRes.insertId),
        message: 'Position created successfully',
        name: body.name,
        status: 'ACTIVE',
        rowVersion: 1,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

positionsRouter.patch('/:positionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const positionId = idParam(req.params.positionId);
    const body = updatePositionSchema.parse(req.body);

    const [updateRes] = await pool.execute<ResultSetHeader>(
      `UPDATE positions
       SET name = COALESCE(?, name),
           status = COALESCE(?, status),
           row_version = row_version + 1,
           updated_by = ?
       WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
      [body.name ?? null, body.status ?? null, actorId, restaurantId, positionId, body.expectedVersion]
    );

    if (updateRes.affectedRows === 0) {
      await throwNotFoundOrConflict('positions', restaurantId, positionId, 'Position');
    }

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: req.tenantContext!.accountKind,
      action: 'UPDATE_POSITION',
      entityType: 'POSITION',
      entityId: positionId,
      requestId: req.requestId,
      afterValues: { name: body.name, status: body.status },
    });

    res.json({
      data: { message: 'Position updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// DEDUCTION TYPES  (/configuration/deduction-types and /deduction-types)
// ==========================================
deductionTypesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
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

deductionTypesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createDeductionTypeSchema.parse(req.body);
    if (body.calculationMethod === 'DAILY_PERCENTAGE' && body.defaultValue > 100) {
      throw new AppError(422, 'INVALID_VALUE', 'A percentage deduction cannot exceed 100');
    }

    const [insertRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO deduction_types (restaurant_id, name, calculation_method, default_value, status, created_by)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
      [restaurantId, body.name, body.calculationMethod, body.defaultValue, actorId]
    );

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: req.tenantContext!.accountKind,
      action: 'CREATE_DEDUCTION_TYPE',
      entityType: 'DEDUCTION_TYPE',
      entityId: String(insertRes.insertId),
      requestId: req.requestId,
      afterValues: body,
    });

    res.status(201).json({
      data: {
        id: String(insertRes.insertId),
        message: 'Deduction type created successfully',
        ...body,
        status: 'ACTIVE',
        rowVersion: 1,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

deductionTypesRouter.patch('/:deductionTypeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const deductionTypeId = idParam(req.params.deductionTypeId);
    const body = updateDeductionTypeSchema.parse(req.body);

    const [current] = await pool.execute<RowDataPacket[]>(
      `SELECT calculation_method, default_value FROM deduction_types WHERE restaurant_id = ? AND id = ?`,
      [restaurantId, deductionTypeId]
    );
    if (!current[0]) throw new AppError(404, 'NOT_FOUND', 'Deduction type not found');
    const method = body.calculationMethod ?? current[0].calculation_method;
    const value = body.defaultValue ?? Number(current[0].default_value);
    if (method === 'DAILY_PERCENTAGE' && value > 100) {
      throw new AppError(422, 'INVALID_VALUE', 'A percentage deduction cannot exceed 100');
    }

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
        body.name ?? null,
        body.calculationMethod ?? null,
        body.defaultValue ?? null,
        body.status ?? null,
        actorId,
        restaurantId,
        deductionTypeId,
        body.expectedVersion,
      ]
    );

    if (updateRes.affectedRows === 0) {
      await throwNotFoundOrConflict('deduction_types', restaurantId, deductionTypeId, 'Deduction type');
    }

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: req.tenantContext!.accountKind,
      action: 'UPDATE_DEDUCTION_TYPE',
      entityType: 'DEDUCTION_TYPE',
      entityId: deductionTypeId,
      requestId: req.requestId,
      afterValues: body,
    });

    res.json({
      data: { message: 'Deduction type updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// SHIFT TEMPLATES  (/configuration/shift-templates and /shift-templates)
// ==========================================
shiftTemplatesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
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

shiftTemplatesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createShiftTemplateSchema.parse(req.body);
    validateTemplateIntervals(body.intervals);

    const result = await withTransaction(async (conn) => {
      const [tRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO shift_templates (restaurant_id, name, status, created_by) VALUES (?, ?, 'ACTIVE', ?)`,
        [restaurantId, body.name, actorId]
      );
      const templateId = tRes.insertId;

      for (const inv of body.intervals) {
        await conn.execute(
          `INSERT INTO shift_template_intervals
            (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            restaurantId,
            templateId,
            inv.sequenceNumber,
            toHms(inv.startLocalTime),
            inv.startDayOffset,
            toHms(inv.endLocalTime),
            inv.endDayOffset,
            inv.plannedUnpaidBreakMinutes,
          ]
        );
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'CREATE_SHIFT_TEMPLATE',
          entityType: 'SHIFT_TEMPLATE',
          entityId: String(templateId),
          requestId: req.requestId,
          afterValues: body,
        },
        conn
      );
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

// PATCH /shift-templates/:templateId - rename, activate/deactivate, optionally replace intervals.
// Existing schedules keep their own copied intervals, so editing a template never rewrites history.
shiftTemplatesRouter.patch('/:templateId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const templateId = idParam(req.params.templateId);
    const body = patchShiftTemplateSchema.parse(req.body);
    if (body.intervals) validateTemplateIntervals(body.intervals);

    await withTransaction(async (conn) => {
      const [updateRes] = await conn.execute<ResultSetHeader>(
        `UPDATE shift_templates
         SET name = COALESCE(?, name),
             status = COALESCE(?, status),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [body.name ?? null, body.status ?? null, actorId, restaurantId, templateId, body.expectedVersion]
      );

      if (updateRes.affectedRows === 0) {
        const [rows] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM shift_templates WHERE restaurant_id = ? AND id = ?`,
          [restaurantId, templateId]
        );
        if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Shift template not found');
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Shift template was modified by another administrator');
      }

      if (body.intervals) {
        await conn.execute(`DELETE FROM shift_template_intervals WHERE restaurant_id = ? AND shift_template_id = ?`, [
          restaurantId,
          templateId,
        ]);
        for (const inv of body.intervals) {
          await conn.execute(
            `INSERT INTO shift_template_intervals
              (restaurant_id, shift_template_id, sequence_number, start_local_time, start_day_offset, end_local_time, end_day_offset, planned_unpaid_break_minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              restaurantId,
              templateId,
              inv.sequenceNumber,
              toHms(inv.startLocalTime),
              inv.startDayOffset,
              toHms(inv.endLocalTime),
              inv.endDayOffset,
              inv.plannedUnpaidBreakMinutes,
            ]
          );
        }
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_SHIFT_TEMPLATE',
          entityType: 'SHIFT_TEMPLATE',
          entityId: templateId,
          requestId: req.requestId,
          afterValues: { name: body.name, status: body.status, intervals: body.intervals },
        },
        conn
      );
    });

    res.json({
      data: { message: 'Shift template updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// Standalone routers are also reachable under /configuration/*
configurationRouter.use('/positions', positionsRouter);
configurationRouter.use('/deduction-types', deductionTypesRouter);
configurationRouter.use('/shift-templates', shiftTemplatesRouter);
