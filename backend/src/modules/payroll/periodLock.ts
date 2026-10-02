import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { AppError } from '../../middleware/errorHandler.js';

/**
 * Locks the payroll period row (SELECT ... FOR UPDATE) and rejects if it is FINALIZED.
 * With `ensureExists`, a DRAFT period row is created first (needed by FKs from
 * salary_adjustments / debt_waivers). Must be called inside a transaction.
 */
export async function lockOpenPeriod(
  conn: PoolConnection,
  restaurantId: string | number,
  monthStart: string,
  finalizedMessage: string,
  ensureExists = false
): Promise<void> {
  if (ensureExists) {
    await conn.execute(
      `INSERT IGNORE INTO payroll_periods (restaurant_id, month_start, status, source_revision) VALUES (?, ?, 'DRAFT', 1)`,
      [restaurantId, monthStart]
    );
  }
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT status FROM payroll_periods WHERE restaurant_id = ? AND month_start = ? FOR UPDATE`,
    [restaurantId, monthStart]
  );
  if (rows[0]?.status === 'FINALIZED') {
    throw new AppError(409, 'PAYROLL_PERIOD_FINALIZED', finalizedMessage);
  }
}

/** Marks the period's inputs as changed so existing calculations become stale. */
export async function bumpSourceRevision(
  conn: PoolConnection,
  restaurantId: string | number,
  monthStart: string
): Promise<void> {
  await conn.execute(
    `UPDATE payroll_periods SET source_revision = source_revision + 1 WHERE restaurant_id = ? AND month_start = ?`,
    [restaurantId, monthStart]
  );
}
