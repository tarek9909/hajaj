import { Router, type CookieOptions, type Request, type Response, type NextFunction } from 'express';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool, withTransaction } from '../../infrastructure/database/pool.js';
import { verifyPassword, hashPassword } from '../../infrastructure/auth/passwords.js';
import { SessionManager, hashToken, deriveCsrfToken } from '../../infrastructure/sessions/sessionManager.js';
import { issueAccountToken } from '../../infrastructure/email/accountLinks.js';
import { recordAuditEvent, type AuditParams } from '../../infrastructure/logging/audit.js';
import { authenticateSession, requireCsrfProtection } from '../../middleware/tenantContext.js';
import {
  loginSchema,
  passwordSetupSchema,
  passwordResetRequestSchema,
  passwordResetCompleteSchema,
} from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';

export const authRouter = Router();

const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_LOGINS;
}

function registerFailure(key: string): void {
  const now = Date.now();
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    if (failedLogins.size > 10000) {
      for (const [k, v] of failedLogins) if (v.resetAt <= now) failedLogins.delete(k);
    }
    failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(key: string): void {
  failedLogins.delete(key);
}

let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalization');
  return dummyHash;
}

function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-session' : 'session_token';
}

function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

async function safeAudit(params: AuditParams): Promise<void> {
  try {
    await recordAuditEvent(params);
  } catch (err) {
    console.error('Failed to record audit event:', err);
  }
}

async function consumeAccountToken(
  conn: PoolConnection,
  tokenHash: Buffer,
  purpose: 'PASSWORD_SETUP' | 'PASSWORD_RESET'
): Promise<RowDataPacket | null> {
  const [claim] = await conn.execute<ResultSetHeader>(
    `UPDATE account_tokens SET used_at = NOW(3)
     WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > NOW(3)`,
    [tokenHash, purpose]
  );
  if (claim.affectedRows !== 1) return null;

  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT a.id, a.restaurant_id, a.account_kind, a.status
     FROM account_tokens t
     JOIN admin_accounts a ON a.id = t.admin_account_id
     WHERE t.token_hash = ?`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

// GET /api/v1/auth/csrf
authRouter.get('/csrf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionToken = req.cookies?.session_token || req.cookies?.['__Host-session'];
    if (!sessionToken) {
      res.json({ data: { csrfToken: null } });
      return;
    }

    const sessionUser = await SessionManager.validateSession(sessionToken);
    if (!sessionUser) {
      res.json({ data: { csrfToken: null } });
      return;
    }

    res.json({ data: { csrfToken: deriveCsrfToken(sessionToken) } });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = loginSchema.parse(req.body);
    const emailNorm = body.email.toLowerCase().trim();
    const rateKey = `${req.ip}|${emailNorm}`;

    if (isRateLimited(rateKey)) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts. Please try again later.');
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, restaurant_id, account_kind, full_name, email_normalized, password_hash, status, password_setup_required
       FROM admin_accounts
       WHERE email_normalized = ?`,
      [emailNorm]
    );

    const account = rows[0];
    const passwordMatches = account?.password_hash
      ? await verifyPassword(body.password, account.password_hash)
      : await verifyPassword(body.password, await getDummyHash());

    if (!account || (account.password_hash && !passwordMatches)) {
      registerFailure(rateKey);
      await safeAudit({
        restaurantId: account?.restaurant_id ? String(account.restaurant_id) : null,
        actorKind: 'SYSTEM',
        action: 'LOGIN_FAILED',
        entityType: 'ADMIN_ACCOUNT',
        entityId: account ? String(account.id) : null,
        requestId: req.requestId,
        afterValues: { email: emailNorm, ip: req.ip ?? null },
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (account.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
    }

    if (!account.password_hash) {
      throw new AppError(400, 'PASSWORD_SETUP_REQUIRED', 'Password setup is required for this account');
    }

    let restaurantName: string | null = null;
    let restaurantCurrency: string | null = null;

    // Check restaurant status if restaurant admin
    if (account.account_kind === 'RESTAURANT_ADMIN' && account.restaurant_id) {
      const [restRows] = await pool.execute<RowDataPacket[]>(
        `SELECT name, currency_code, status FROM restaurants WHERE id = ?`,
        [account.restaurant_id]
      );
      if (!restRows[0] || restRows[0].status !== 'ACTIVE') {
        throw new AppError(403, 'RESTAURANT_INACTIVE', 'This restaurant has been deactivated');
      }
      restaurantName = restRows[0].name;
      restaurantCurrency = restRows[0].currency_code;
    }

    clearFailures(rateKey);

    // Create session
    const { sessionToken, csrfToken } = await SessionManager.createSession(String(account.id));

    // Update last_login_at
    await pool.execute(`UPDATE admin_accounts SET last_login_at = NOW(3) WHERE id = ?`, [account.id]);

    res.cookie(sessionCookieName(), sessionToken, { ...sessionCookieOptions(), maxAge: 12 * 60 * 60 * 1000 });

    await safeAudit({
      restaurantId: account.restaurant_id ? String(account.restaurant_id) : null,
      actorId: String(account.id),
      actorKind: account.account_kind,
      action: 'LOGIN_SUCCEEDED',
      entityType: 'ADMIN_ACCOUNT',
      entityId: String(account.id),
      requestId: req.requestId,
    });

    res.json({
      data: {
        adminAccountId: String(account.id),
        fullName: account.full_name,
        email: account.email_normalized,
        accountKind: account.account_kind,
        restaurantId: account.restaurant_id ? String(account.restaurant_id) : null,
        restaurantName,
        restaurantCurrency,
        csrfToken,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout
authRouter.post('/logout', authenticateSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionToken = req.cookies?.session_token || req.cookies?.['__Host-session'];
    if (sessionToken) {
      await SessionManager.revokeSession(sessionToken);
    }

    const user = req.sessionUser!;
    await safeAudit({
      restaurantId: user.restaurantId,
      actorId: user.adminAccountId,
      actorKind: user.accountKind,
      action: 'LOGOUT',
      entityType: 'ADMIN_ACCOUNT',
      entityId: user.adminAccountId,
      requestId: req.requestId,
    });

    res.clearCookie(sessionCookieName(), sessionCookieOptions());

    res.json({
      data: { message: 'Logged out successfully' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/me
authRouter.get('/me', authenticateSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.sessionUser!;
    let restaurantName: string | null = null;
    let restaurantCurrency: string | null = null;

    if (user.restaurantId) {
      const [restRows] = await pool.execute<RowDataPacket[]>(
        `SELECT name, currency_code FROM restaurants WHERE id = ?`,
        [user.restaurantId]
      );
      if (restRows[0]) {
        restaurantName = restRows[0].name;
        restaurantCurrency = restRows[0].currency_code;
      }
    }

    res.json({
      data: {
        adminAccountId: user.adminAccountId,
        fullName: user.fullName,
        email: user.email,
        accountKind: user.accountKind,
        restaurantId: user.restaurantId,
        restaurantName,
        restaurantCurrency,
      },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});


// POST /api/v1/auth/password-setup
authRouter.post('/password-setup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = passwordSetupSchema.parse(req.body);
    const tokenHash = hashToken(body.token);
    const hashedPassword = await hashPassword(body.newPassword);

    await withTransaction(async (conn) => {
      const account = await consumeAccountToken(conn, tokenHash, 'PASSWORD_SETUP');
      if (!account) {
        throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Password setup link is invalid or has expired');
      }

      await conn.execute(
        `UPDATE admin_accounts SET password_hash = ?, password_setup_required = 0 WHERE id = ?`,
        [hashedPassword, account.id]
      );
      await SessionManager.revokeAllAccountSessions(String(account.id), conn);
      await recordAuditEvent(
        {
          restaurantId: account.restaurant_id ? String(account.restaurant_id) : null,
          actorId: String(account.id),
          actorKind: account.account_kind,
          action: 'PASSWORD_SETUP_COMPLETED',
          entityType: 'ADMIN_ACCOUNT',
          entityId: String(account.id),
          requestId: req.requestId,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Password setup successful. You may now log in.' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/password-reset/request
authRouter.post('/password-reset/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = passwordResetRequestSchema.parse(req.body);
    const emailNorm = body.email.toLowerCase().trim();

    // Neutral response to avoid email enumeration
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, restaurant_id, account_kind FROM admin_accounts WHERE email_normalized = ? AND status = 'ACTIVE'`,
      [emailNorm]
    );

    const response: Record<string, unknown> = {
      message: 'If an active account exists with that email, a password reset link has been dispatched.',
    };

    if (rows[0]) {
      const { token, path } = await issueAccountToken(rows[0].id, 'PASSWORD_RESET', emailNorm);
      await safeAudit({
        restaurantId: rows[0].restaurant_id ? String(rows[0].restaurant_id) : null,
        actorId: String(rows[0].id),
        actorKind: rows[0].account_kind,
        action: 'PASSWORD_RESET_REQUESTED',
        entityType: 'ADMIN_ACCOUNT',
        entityId: String(rows[0].id),
        requestId: req.requestId,
      });

      if (process.env.NODE_ENV !== 'production') {
        response.resetToken = token;
        response.resetPath = path;
      }
    }

    res.json({
      data: response,
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/password-reset/complete
authRouter.post('/password-reset/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = passwordResetCompleteSchema.parse(req.body);
    const tokenHash = hashToken(body.token);
    const hashedPassword = await hashPassword(body.newPassword);

    await withTransaction(async (conn) => {
      const account = await consumeAccountToken(conn, tokenHash, 'PASSWORD_RESET');
      if (!account || account.status !== 'ACTIVE') {
        throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Reset link is invalid or expired');
      }

      await conn.execute(
        `UPDATE admin_accounts SET password_hash = ?, password_setup_required = 0 WHERE id = ?`,
        [hashedPassword, account.id]
      );
      await SessionManager.revokeAllAccountSessions(String(account.id), conn);
      await recordAuditEvent(
        {
          restaurantId: account.restaurant_id ? String(account.restaurant_id) : null,
          actorId: String(account.id),
          actorKind: account.account_kind,
          action: 'PASSWORD_RESET_COMPLETED',
          entityType: 'ADMIN_ACCOUNT',
          entityId: String(account.id),
          requestId: req.requestId,
        },
        conn
      );
    });

    res.json({
      data: { message: 'Password has been reset successfully. Please log in with your new password.' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
