import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../infrastructure/database/pool.js';
import { AppError } from '../../middleware/errorHandler.js';

/**
 * Tenant-scoped, read-only restaurant profile. Restaurant admins cannot call the
 * /platform endpoints, so every workspace screen reads its currency/timezone here.
 */
export const profileRouter = Router({ mergeParams: true });

profileRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const restaurantId = req.tenantContext!.restaurantId;
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, name, contact_name, contact_mobile, contact_email, currency_code, currency_decimal_places,
              timezone, status, DATE_FORMAT(payroll_start_month, '%Y-%m-01') AS payroll_start_month, row_version
       FROM restaurants WHERE id = ?`,
      [restaurantId]
    );
    const r = rows[0];
    if (!r) throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');

    res.json({
      data: {
        id: String(r.id),
        name: r.name,
        contactName: r.contact_name,
        contactMobile: r.contact_mobile,
        contactEmail: r.contact_email,
        currencyCode: r.currency_code,
        currencyDecimalPlaces: Number(r.currency_decimal_places),
        timezone: r.timezone,
        status: r.status,
        payrollStartMonth: r.payroll_start_month,
        rowVersion: Number(r.row_version),
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
