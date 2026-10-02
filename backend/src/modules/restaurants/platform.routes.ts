import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { hashPassword } from '../../infrastructure/auth/passwords.js';
import { createRestaurantSchema, updateRestaurantSchema, createAdministratorSchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';

export const platformRouter = Router();

// GET /api/v1/platform/restaurants
platformRouter.get('/restaurants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    let sql = `
      SELECT 
        r.id,
        r.name,
        r.contact_name,
        r.contact_mobile,
        r.contact_email,
        r.currency_code,
        r.currency_decimal_places,
        r.timezone,
        r.status,
        DATE_FORMAT(r.payroll_start_month, '%Y-%m-01') AS payroll_start_month,
        r.created_at,
        r.row_version,
        (SELECT COUNT(*) FROM admin_accounts a WHERE a.restaurant_id = r.id AND a.status = 'ACTIVE') AS active_admin_count,
        (SELECT COUNT(*) FROM employees e WHERE e.restaurant_id = r.id AND e.status = 'ACTIVE') AS active_employee_count
      FROM restaurants r
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status && ['ACTIVE', 'INACTIVE'].includes(status)) {
      sql += ` AND r.status = ?`;
      params.push(status);
    }

    if (search) {
      sql += ` AND r.name LIKE ?`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY r.name ASC`;

    const [rows] = await pool.execute<RowDataPacket[]>(sql, params);

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        contactName: r.contact_name,
        contactMobile: r.contact_mobile,
        contactEmail: r.contact_email,
        currencyCode: r.currency_code,
        currencyDecimalPlaces: r.currency_decimal_places,
        timezone: r.timezone,
        status: r.status,
        payrollStartMonth: r.payroll_start_month,
        activeAdminCount: Number(r.active_admin_count),
        activeEmployeeCount: Number(r.active_employee_count),
        createdAt: r.created_at,
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/platform/restaurants
platformRouter.post('/restaurants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createRestaurantSchema.parse(req.body);
    const actorId = req.sessionUser!.adminAccountId;

    const result = await withTransaction(async (conn) => {
      // 1. Insert Restaurant
      const [restRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO restaurants 
          (name, contact_name, contact_mobile, contact_email, currency_code, currency_decimal_places, timezone, status, payroll_start_month)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          body.name,
          body.contactName || null,
          body.contactMobile || null,
          body.contactEmail || null,
          body.currencyCode,
          body.currencyDecimalPlaces,
          body.timezone,
          body.payrollStartMonth,
        ]
      );
      const restaurantId = restRes.insertId;

      // 2. Insert Initial Restaurant Admin
      const initialAdminPassword = body.initialAdmin.password || 'RestaurantAdmin123!';
      const passwordHash = await hashPassword(initialAdminPassword);
      const emailNorm = body.initialAdmin.email.toLowerCase().trim();

      const [adminRes] = await conn.execute<ResultSetHeader>(
        `INSERT INTO admin_accounts 
          (restaurant_id, account_kind, full_name, email_normalized, mobile, password_hash, password_setup_required, status, created_by)
         VALUES (?, 'RESTAURANT_ADMIN', ?, ?, ?, ?, 0, 'ACTIVE', ?)`,
        [
          restaurantId,
          body.initialAdmin.fullName,
          emailNorm,
          body.initialAdmin.mobile || null,
          passwordHash,
          actorId,
        ]
      );
      const adminId = adminRes.insertId;

      // 3. Insert Initial Policy Version
      const pol = body.initialPolicy;
      await conn.execute(
        `INSERT INTO restaurant_policy_versions 
          (restaurant_id, effective_from_month, revision_no, salary_working_day_divisor, standard_daily_minutes, overtime_multiplier, late_grace_minutes, late_deduction_percentage, warning_threshold, custom_warnings_count_by_default, reason, created_by)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          restaurantId,
          body.payrollStartMonth,
          pol.salaryWorkingDayDivisor,
          pol.standardDailyMinutes,
          pol.overtimeMultiplier,
          pol.lateGraceMinutes,
          pol.lateDeductionPercentage,
          pol.warningThreshold,
          pol.customWarningsCountByDefault ? 1 : 0,
          pol.reason,
          actorId,
        ]
      );

      // 4. Insert Default Standard Positions
      const defaultPositions = ['Chef', 'Sous Chef', 'Waiter', 'Cashier', 'Cleaner', 'Supervisor'];
      for (const posName of defaultPositions) {
        await conn.execute(
          `INSERT INTO positions (restaurant_id, name, status, created_by) VALUES (?, ?, 'ACTIVE', ?)`,
          [restaurantId, posName, actorId]
        );
      }

      // 5. Insert Initial Payroll Period (Draft)
      await conn.execute(
        `INSERT INTO payroll_periods (restaurant_id, month_start, status, source_revision)
         VALUES (?, ?, 'DRAFT', 1)`,
        [restaurantId, body.payrollStartMonth]
      );

      // 6. Audit event
      await recordAuditEvent(
        {
          restaurantId: String(restaurantId),
          actorId,
          actorKind: 'SUPERADMIN',
          action: 'CREATE_RESTAURANT',
          entityType: 'RESTAURANT',
          entityId: String(restaurantId),
          requestId: req.requestId,
          afterValues: { name: body.name, adminEmail: emailNorm },
        },
        conn
      );

      return { restaurantId, adminId };
    });

    res.status(201).json({
      data: {
        restaurantId: String(result.restaurantId),
        adminId: String(result.adminId),
        message: 'Restaurant onboarded successfully with initial policy and administrator.',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/platform/restaurants/:restaurantId
platformRouter.get('/restaurants/:restaurantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = String(req.params.restaurantId);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        r.id,
        r.name,
        r.contact_name,
        r.contact_mobile,
        r.contact_email,
        r.currency_code,
        r.currency_decimal_places,
        r.timezone,
        r.status,
        DATE_FORMAT(r.payroll_start_month, '%Y-%m-01') AS payroll_start_month,
        r.created_at,
        r.row_version,
        (SELECT COUNT(*) FROM admin_accounts a WHERE a.restaurant_id = r.id AND a.status = 'ACTIVE') AS active_admin_count,
        (SELECT COUNT(*) FROM employees e WHERE e.restaurant_id = r.id AND e.status = 'ACTIVE') AS active_employee_count
      FROM restaurants r 
      WHERE r.id = ?`,
      [restaurantId]
    );

    const r = rows[0];
    if (!r) {
      throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
    }

    res.json({
      data: {
        id: String(r.id),
        name: r.name,
        contactName: r.contact_name,
        contactMobile: r.contact_mobile,
        contactEmail: r.contact_email,
        currencyCode: r.currency_code,
        currencyDecimalPlaces: r.currency_decimal_places,
        timezone: r.timezone,
        status: r.status,
        payrollStartMonth: r.payroll_start_month,
        activeAdminCount: Number(r.active_admin_count),
        activeEmployeeCount: Number(r.active_employee_count),
        createdAt: r.created_at,
        rowVersion: Number(r.row_version),
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/platform/restaurants/:restaurantId
platformRouter.patch('/restaurants/:restaurantId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = String(req.params.restaurantId);
    const body = updateRestaurantSchema.parse(req.body);
    const actorId = req.sessionUser!.adminAccountId;

    const [updateRes] = await pool.execute<ResultSetHeader>(
      `UPDATE restaurants 
       SET name = COALESCE(?, name),
           contact_name = COALESCE(?, contact_name),
           contact_mobile = COALESCE(?, contact_mobile),
           contact_email = COALESCE(?, contact_email),
           row_version = row_version + 1
       WHERE id = ? AND row_version = ?`,
      [
        body.name || null,
        body.contactName !== undefined ? body.contactName : null,
        body.contactMobile !== undefined ? body.contactMobile : null,
        body.contactEmail !== undefined ? body.contactEmail : null,
        restaurantId,
        body.expectedVersion,
      ]
    );

    if (updateRes.affectedRows === 0) {
      throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Restaurant has been modified by another administrator');
    }

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: 'SUPERADMIN',
      action: 'UPDATE_RESTAURANT',
      entityType: 'RESTAURANT',
      entityId: restaurantId,
      requestId: req.requestId,
      afterValues: body,
    });

    res.json({
      data: { message: 'Restaurant updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/platform/restaurants/:restaurantId/status
platformRouter.patch('/restaurants/:restaurantId/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = String(req.params.restaurantId);
    const { status, expectedVersion } = req.body;
    if (!['ACTIVE', 'INACTIVE'].includes(status) || typeof expectedVersion !== 'number') {
      throw new AppError(422, 'INVALID_INPUT', 'Status must be ACTIVE or INACTIVE and expectedVersion is required');
    }

    const actorId = req.sessionUser!.adminAccountId;

    const [updateRes] = await pool.execute<ResultSetHeader>(
      `UPDATE restaurants 
       SET status = ?, row_version = row_version + 1 
       WHERE id = ? AND row_version = ?`,
      [status, restaurantId, expectedVersion]
    );

    if (updateRes.affectedRows === 0) {
      throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Restaurant has been modified by another administrator');
    }

    // If deactivated, revoke all active sessions for this restaurant's admins
    if (status === 'INACTIVE') {
      await pool.execute(
        `UPDATE sessions s 
         JOIN admin_accounts a ON a.id = s.admin_account_id 
         SET s.revoked_at = NOW(3) 
         WHERE a.restaurant_id = ? AND s.revoked_at IS NULL`,
        [restaurantId]
      );
    }

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: 'SUPERADMIN',
      action: status === 'ACTIVE' ? 'ACTIVATE_RESTAURANT' : 'DEACTIVATE_RESTAURANT',
      entityType: 'RESTAURANT',
      entityId: restaurantId,
      requestId: req.requestId,
      afterValues: { status },
    });

    res.json({
      data: { message: `Restaurant ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/platform/restaurants/:restaurantId/administrators
platformRouter.post('/restaurants/:restaurantId/administrators', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = String(req.params.restaurantId);
    const body = createAdministratorSchema.parse(req.body);
    const actorId = req.sessionUser!.adminAccountId;

    const password = body.password || 'RestaurantAdmin123!';
    const passwordHash = await hashPassword(password);
    const emailNorm = body.email.toLowerCase().trim();

    const [adminRes] = await pool.execute<ResultSetHeader>(
      `INSERT INTO admin_accounts 
        (restaurant_id, account_kind, full_name, email_normalized, mobile, password_hash, password_setup_required, status, created_by)
       VALUES (?, 'RESTAURANT_ADMIN', ?, ?, ?, ?, 0, 'ACTIVE', ?)`,
      [restaurantId, body.fullName, emailNorm, body.mobile || null, passwordHash, actorId]
    );

    await recordAuditEvent({
      restaurantId,
      actorId,
      actorKind: 'SUPERADMIN',
      action: 'CREATE_RESTAURANT_ADMIN',
      entityType: 'ADMIN_ACCOUNT',
      entityId: String(adminRes.insertId),
      requestId: req.requestId,
      afterValues: { fullName: body.fullName, email: emailNorm },
    });

    res.status(201).json({
      data: {
        adminId: String(adminRes.insertId),
        message: 'Administrator created successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
