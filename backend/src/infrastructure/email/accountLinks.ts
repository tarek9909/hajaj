import { randomBytes } from 'node:crypto';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../database/pool.js';
import { hashToken } from '../sessions/sessionManager.js';
import { hashPassword } from '../auth/passwords.js';
import { AppError } from '../../middleware/errorHandler.js';

export type AccountTokenPurpose = 'PASSWORD_SETUP' | 'PASSWORD_RESET';

const CONFIG = {
  PASSWORD_SETUP: { ttlMs: 48 * 60 * 60 * 1000, path: '/setup-password' },
  PASSWORD_RESET: { ttlMs: 60 * 60 * 1000, path: '/reset-password' },
} as const;

export async function issueAccountToken(
  adminAccountId: string | number,
  purpose: AccountTokenPurpose,
  email: string,
  connection?: PoolConnection
): Promise<{ token: string; path: string }> {
  const conn = connection || pool;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CONFIG[purpose].ttlMs);

  await conn.execute(
    `INSERT INTO account_tokens (admin_account_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [adminAccountId, purpose, hashToken(token), expiresAt]
  );

  const path = `${CONFIG[purpose].path}?token=${token}`;
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Account] ${purpose} link for ${email}: ${path}`);
  }
  return { token, path };
}

export interface NewRestaurantAdmin {
  restaurantId: string | number;
  fullName: string;
  email: string;
  mobile?: string | null;
  password?: string;
  actorId: string;
}

export async function insertRestaurantAdmin(
  conn: PoolConnection,
  admin: NewRestaurantAdmin
): Promise<{ adminId: number; setupToken?: string; setupPath?: string }> {
  const emailNorm = admin.email.toLowerCase().trim();
  const passwordHash = admin.password ? await hashPassword(admin.password) : null;

  let adminId: number;
  try {
    const [res] = await conn.execute<ResultSetHeader>(
      `INSERT INTO admin_accounts
        (restaurant_id, account_kind, full_name, email_normalized, mobile, password_hash, password_setup_required, status, created_by)
       VALUES (?, 'RESTAURANT_ADMIN', ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [admin.restaurantId, admin.fullName, emailNorm, admin.mobile || null, passwordHash, passwordHash ? 0 : 1, admin.actorId]
    );
    adminId = res.insertId;
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'An account with this email already exists');
    }
    throw err;
  }

  if (passwordHash) return { adminId };

  const { token, path } = await issueAccountToken(adminId, 'PASSWORD_SETUP', emailNorm, conn);
  return { adminId, setupToken: token, setupPath: path };
}
