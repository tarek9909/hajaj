import type { PoolConnection, Pool, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../../middleware/errorHandler.js';

type Db = PoolConnection | Pool;

/** Accepts YYYY-MM, YYYY-MM-01, or any date YYYY-MM-DD and returns YYYY-MM-01; throws 422 otherwise. */
export function normalizeMonthStart(value: string, field = 'month'): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/.exec(value);
  if (!m) {
    throw new AppError(422, 'INVALID_MONTH', `${field} must be in YYYY-MM format`);
  }
  return `${m[1]}-${m[2]}-01`;
}

/** Throws 409 when the payroll period for the given month (YYYY-MM-01) is FINALIZED. */
export async function assertMonthNotFinalized(db: Db, restaurantId: string, monthStart: string): Promise<void> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ?`,
    [restaurantId, monthStart]
  );
  if (rows[0]?.status === 'FINALIZED') {
    throw new AppError(
      409,
      'PAYROLL_PERIOD_FINALIZED',
      `Payroll period ${monthStart.slice(0, 7)} is finalized and cannot be changed. Reopen it first.`
    );
  }
}

/** Throws 409 when any payroll period in [fromDate, toDate] (inclusive dates) is FINALIZED. */
export async function assertRangeNotFinalized(
  db: Db,
  restaurantId: string,
  fromDate: string,
  toDate: string
): Promise<void> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(month_start, '%Y-%m') AS finalized_month
     FROM payroll_periods
     WHERE restaurant_id = ? AND status = 'FINALIZED'
       AND month_start <= ? AND DATE_ADD(month_start, INTERVAL 1 MONTH) > ?`,
    [restaurantId, toDate, fromDate]
  );
  if (rows.length > 0) {
    throw new AppError(
      409,
      'PAYROLL_PERIOD_FINALIZED',
      `Cannot modify data in finalized month(s): ${rows.map((r) => r.finalized_month).join(', ')}`
    );
  }
}

/**
 * Bump source_revision for non-FINALIZED periods whose month_start >= fromMonth
 * (and <= toMonth when given). Finalized periods are immutable snapshots.
 */
export async function bumpSourceRevision(
  db: Db,
  restaurantId: string,
  fromMonth: string,
  toMonth?: string | null
): Promise<void> {
  await db.execute(
    `UPDATE payroll_periods SET source_revision = source_revision + 1
     WHERE restaurant_id = ? AND month_start >= ? ${toMonth ? 'AND month_start <= ?' : ''}
       AND status <> 'FINALIZED'`,
    toMonth ? [restaurantId, fromMonth, toMonth] : [restaurantId, fromMonth]
  );
}
