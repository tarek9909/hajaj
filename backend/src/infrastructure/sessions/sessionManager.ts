import crypto from 'crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from '../database/pool.js';
import type { UserSession, AccountKind } from '../../contracts/types.js';

export function hashToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export class SessionManager {
  /**
   * Creates a new session in the database, returns the plaintext session token and CSRF token.
   */
  public static async createSession(
    adminAccountId: string,
    connection?: PoolConnection
  ): Promise<{ sessionToken: string; csrfToken: string }> {
    const conn = connection || pool;
    const sessionToken = generateToken();
    const csrfToken = generateToken();

    const tokenHash = hashToken(sessionToken);
    const csrfHash = hashToken(csrfToken);

    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes
    const absoluteExpiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours

    await conn.execute(
      `INSERT INTO sessions 
        (admin_account_id, token_hash, csrf_token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adminAccountId, tokenHash, csrfHash, now, now, idleExpiresAt, absoluteExpiresAt]
    );

    return { sessionToken, csrfToken };
  }

  /**
   * Validates a session token, touches last_seen_at & idle_expires_at,
   * checks admin status and restaurant status, returns UserSession.
   */
  public static async validateSession(
    sessionToken: string
  ): Promise<UserSession | null> {
    if (!sessionToken) return null;
    const tokenHash = hashToken(sessionToken);
    const now = new Date();

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 
        s.id AS session_id,
        s.admin_account_id,
        s.csrf_token_hash,
        s.idle_expires_at,
        s.absolute_expires_at,
        s.revoked_at,
        a.account_kind,
        a.restaurant_id,
        a.full_name,
        a.email_normalized,
        a.status AS admin_status,
        r.status AS restaurant_status
      FROM sessions s
      JOIN admin_accounts a ON a.id = s.admin_account_id
      LEFT JOIN restaurants r ON r.id = a.restaurant_id
      WHERE s.token_hash = ?`,
      [tokenHash]
    );

    const session = rows[0];
    if (!session) return null;

    // Check revocation and expiration
    if (session.revoked_at) return null;
    if (new Date(session.absolute_expires_at) <= now) return null;
    if (new Date(session.idle_expires_at) <= now) return null;

    // Check account status
    if (session.admin_status !== 'ACTIVE') return null;

    // Check restaurant status for restaurant admins
    if (session.account_kind === 'RESTAURANT_ADMIN') {
      if (!session.restaurant_id || session.restaurant_status !== 'ACTIVE') {
        return null;
      }
    }

    // Touch idle expiration (30 mins from now, capped at absolute expiry)
    const newIdleExpiresAt = new Date(
      Math.min(now.getTime() + 30 * 60 * 1000, new Date(session.absolute_expires_at).getTime())
    );

    await pool.execute(
      `UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?`,
      [now, newIdleExpiresAt, session.session_id]
    );

    return {
      sessionId: String(session.session_id),
      adminAccountId: String(session.admin_account_id),
      accountKind: session.account_kind as AccountKind,
      restaurantId: session.restaurant_id ? String(session.restaurant_id) : null,
      fullName: session.full_name,
      email: session.email_normalized,
      csrfToken: '', // verified separately against request header
    };
  }

  /**
   * Verifies CSRF token for a given session.
   */
  public static async verifyCsrfToken(
    sessionToken: string,
    suppliedCsrfToken: string
  ): Promise<boolean> {
    if (!sessionToken || !suppliedCsrfToken) return false;
    const tokenHash = hashToken(sessionToken);
    const csrfHash = hashToken(suppliedCsrfToken);

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT csrf_token_hash FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`,
      [tokenHash]
    );

    const session = rows[0];
    if (!session) return false;

    return crypto.timingSafeEqual(session.csrf_token_hash as Buffer, csrfHash);
  }

  /**
   * Revoke a single session.
   */
  public static async revokeSession(sessionToken: string): Promise<void> {
    const tokenHash = hashToken(sessionToken);
    await pool.execute(
      `UPDATE sessions SET revoked_at = NOW(3) WHERE token_hash = ?`,
      [tokenHash]
    );
  }

  /**
   * Revoke all sessions for an admin account (e.g. on deactivation or password reset).
   */
  public static async revokeAllAccountSessions(
    adminAccountId: string,
    connection?: PoolConnection
  ): Promise<void> {
    const conn = connection || pool;
    await conn.execute(
      `UPDATE sessions SET revoked_at = NOW(3) WHERE admin_account_id = ? AND revoked_at IS NULL`,
      [adminAccountId]
    );
  }
}
