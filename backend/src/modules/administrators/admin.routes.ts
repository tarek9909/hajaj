import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { withTransaction, pool } from '../../infrastructure/database/pool.js';
import { insertRestaurantAdmin } from '../../infrastructure/email/accountLinks.js';
import { SessionManager } from '../../infrastructure/sessions/sessionManager.js';
import { recordAuditEvent } from '../../infrastructure/logging/audit.js';
import { createAdministratorSchema, updateAdministratorSchema } from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';

export const adminManagementRouter = Router({ mergeParams: true });

// GET /api/v1/restaurants/:restaurantId/administrators
adminManagementRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        id,
        restaurant_id,
        account_kind,
        full_name,
        email_normalized,
        mobile,
        status,
        last_login_at,
        created_at,
        row_version
       FROM admin_accounts 
       WHERE restaurant_id = ?
       ORDER BY full_name ASC`,
      [restaurantId]
    );

    res.json({
      data: rows.map((r) => ({
        id: String(r.id),
        restaurantId: String(r.restaurant_id),
        accountKind: r.account_kind,
        fullName: r.full_name,
        email: r.email_normalized,
        mobile: r.mobile,
        status: r.status,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        rowVersion: Number(r.row_version),
      })),
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/restaurants/:restaurantId/administrators
adminManagementRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const actorId = req.tenantContext!.actorId;
    const body = createAdministratorSchema.parse(req.body);

    const emailNorm = body.email.toLowerCase().trim();

    const result = await withTransaction(async (conn) => {
      const [restRows] = await conn.execute<RowDataPacket[]>(`SELECT id FROM restaurants WHERE id = ? FOR UPDATE`, [
        restaurantId,
      ]);
      if (!restRows[0]) {
        throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
      }

      const admin = await insertRestaurantAdmin(conn, {
        restaurantId,
        fullName: body.fullName,
        email: emailNorm,
        mobile: body.mobile,
        password: body.password,
        actorId,
      });

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'ADD_ADMINISTRATOR',
          entityType: 'ADMIN_ACCOUNT',
          entityId: String(admin.adminId),
          requestId: req.requestId,
          afterValues: { fullName: body.fullName, email: emailNorm },
        },
        conn
      );
      return admin;
    });

    res.status(201).json({
      data: {
        id: String(result.adminId),
        adminId: String(result.adminId),
        ...(result.setupToken ? { setupToken: result.setupToken, setupPath: result.setupPath } : {}),
        message: 'Administrator added successfully',
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/restaurants/:restaurantId/administrators/:administratorId
adminManagementRouter.patch('/:administratorId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const administratorId = String(req.params.administratorId);
    const body = updateAdministratorSchema.parse(req.body);
    const actorId = req.tenantContext!.actorId;

    await withTransaction(async (conn) => {
      const [updateRes] = await conn.execute<ResultSetHeader>(
        `UPDATE admin_accounts
         SET full_name = COALESCE(?, full_name),
             mobile = IF(?, ?, mobile),
             row_version = row_version + 1,
             updated_by = ?
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [
          body.fullName || null,
          body.mobile !== undefined ? 1 : 0,
          body.mobile || null,
          actorId,
          restaurantId,
          administratorId,
          body.expectedVersion,
        ]
      );

      if (updateRes.affectedRows === 0) {
        const [exists] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM admin_accounts WHERE restaurant_id = ? AND id = ?`,
          [restaurantId, administratorId]
        );
        if (!exists[0]) throw new AppError(404, 'ADMINISTRATOR_NOT_FOUND', 'Administrator not found');
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: 'UPDATE_ADMINISTRATOR',
          entityType: 'ADMIN_ACCOUNT',
          entityId: administratorId,
          requestId: req.requestId,
          afterValues: body,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Administrator updated successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

const handleAdminStatusUpdate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const administratorId = String(req.params.administratorId);
    const status = req.body.status;
    const expectedVersion = req.body.expectedVersion ?? req.body.version;
    if (!['ACTIVE', 'INACTIVE'].includes(status) || typeof expectedVersion !== 'number') {
      throw new AppError(422, 'INVALID_INPUT', 'Status must be ACTIVE or INACTIVE and expectedVersion is required');
    }

    const actorId = req.tenantContext!.actorId;

    await withTransaction(async (conn) => {
      // 1. Lock the restaurant record FOR UPDATE to prevent race conditions
      const [restLock] = await conn.execute<RowDataPacket[]>(
        `SELECT id FROM restaurants WHERE id = ? FOR UPDATE`,
        [restaurantId]
      );
      if (!restLock[0]) {
        throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
      }

      // 2. If deactivating, check active admin count
      if (status === 'INACTIVE') {
        const [activeAdmins] = await conn.execute<RowDataPacket[]>(
          `SELECT id FROM admin_accounts 
           WHERE restaurant_id = ? AND status = 'ACTIVE' 
           FOR UPDATE`,
          [restaurantId]
        );

        if (activeAdmins.length <= 1) {
          throw new AppError(
            409,
            'LAST_ADMINISTRATOR_PROTECTION',
            'Cannot deactivate the last active administrator for this restaurant. A restaurant must have at least one active administrator.'
          );
        }
      }

      // 3. Update account status
      const [updateRes] = await conn.execute<ResultSetHeader>(
        `UPDATE admin_accounts 
         SET status = ?, row_version = row_version + 1, updated_by = ? 
         WHERE restaurant_id = ? AND id = ? AND row_version = ?`,
        [status, actorId, restaurantId, administratorId, expectedVersion]
      );

      if (updateRes.affectedRows === 0) {
        throw new AppError(412, 'ROW_VERSION_CONFLICT', 'Record was modified by another administrator');
      }

      // 4. Revoke sessions immediately if deactivated
      if (status === 'INACTIVE') {
        await SessionManager.revokeAllAccountSessions(administratorId, conn);
      }

      // 5. Write audit event
      await recordAuditEvent(
        {
          restaurantId,
          actorId,
          actorKind: req.tenantContext!.accountKind,
          action: status === 'ACTIVE' ? 'ACTIVATE_ADMINISTRATOR' : 'DEACTIVATE_ADMINISTRATOR',
          entityType: 'ADMIN_ACCOUNT',
          entityId: administratorId,
          requestId: req.requestId,
          afterValues: { status },
        },
        conn
      );
    });

    res.json({
      data: { message: `Administrator ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
};

adminManagementRouter.patch('/:administratorId/status', handleAdminStatusUpdate);
adminManagementRouter.put('/:administratorId/status', handleAdminStatusUpdate);
