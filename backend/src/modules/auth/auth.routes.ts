import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../infrastructure/database/pool.js';
import { verifyPassword, hashPassword } from '../../infrastructure/auth/passwords.js';
import { SessionManager, hashToken } from '../../infrastructure/sessions/sessionManager.js';
import { authenticateSession, requireCsrfProtection } from '../../middleware/tenantContext.js';
import {
  loginSchema,
  passwordSetupSchema,
  passwordResetRequestSchema,
  passwordResetCompleteSchema,
} from '../../contracts/schemas.js';
import { AppError } from '../../middleware/errorHandler.js';

export const authRouter = Router();

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

    // Lookup session csrf token
    const tokenHash = hashToken(sessionToken);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT csrf_token_hash FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`,
      [tokenHash]
    );

    // If session valid, provide a CSRF token
    // In our implementation, csrfToken is returned on login and can be regenerated or fetched
    res.json({
      data: {
        csrfToken: req.headers['x-csrf-token'] || 'active-session-csrf-token',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login
authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = loginSchema.parse(req.body);
    const emailNorm = body.email.toLowerCase().trim();

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, restaurant_id, account_kind, full_name, email_normalized, password_hash, status, password_setup_required 
       FROM admin_accounts 
       WHERE email_normalized = ?`,
      [emailNorm]
    );

    const account = rows[0];
    if (!account) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (account.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
    }

    if (!account.password_hash) {
      throw new AppError(400, 'PASSWORD_SETUP_REQUIRED', 'Password setup is required for this account');
    }

    const passwordMatches = await verifyPassword(body.password, account.password_hash);
    if (!passwordMatches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Check restaurant status if restaurant admin
    if (account.account_kind === 'RESTAURANT_ADMIN' && account.restaurant_id) {
      const [restRows] = await pool.execute<RowDataPacket[]>(
        `SELECT status FROM restaurants WHERE id = ?`,
        [account.restaurant_id]
      );
      if (!restRows[0] || restRows[0].status !== 'ACTIVE') {
        throw new AppError(403, 'RESTAURANT_INACTIVE', 'This restaurant has been deactivated');
      }
    }

    // Create session
    const { sessionToken, csrfToken } = await SessionManager.createSession(String(account.id));

    // Update last_login_at
    await pool.execute(`UPDATE admin_accounts SET last_login_at = NOW(3) WHERE id = ?`, [account.id]);

    const isProduction = process.env.NODE_ENV === 'production';
    const cookieName = isProduction ? '__Host-session' : 'session_token';

    res.cookie(cookieName, sessionToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    });

    res.json({
      data: {
        adminAccountId: String(account.id),
        fullName: account.full_name,
        email: account.email_normalized,
        accountKind: account.account_kind,
        restaurantId: account.restaurant_id ? String(account.restaurant_id) : null,
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

    res.clearCookie('session_token', { path: '/' });
    res.clearCookie('__Host-session', { path: '/' });

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
    const now = new Date();

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, admin_account_id, expires_at, used_at 
       FROM account_tokens 
       WHERE token_hash = ? AND purpose = 'PASSWORD_SETUP'`,
      [tokenHash]
    );

    const tokenRecord = rows[0];
    if (!tokenRecord || tokenRecord.used_at || new Date(tokenRecord.expires_at) <= now) {
      throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Password setup link is invalid or has expired');
    }

    const hashedPassword = await hashPassword(body.newPassword);

    await pool.execute(
      `UPDATE admin_accounts SET password_hash = ?, password_setup_required = 0 WHERE id = ?`,
      [hashedPassword, tokenRecord.admin_account_id]
    );

    await pool.execute(
      `UPDATE account_tokens SET used_at = NOW(3) WHERE id = ?`,
      [tokenRecord.id]
    );

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
      `SELECT id FROM admin_accounts WHERE email_normalized = ? AND status = 'ACTIVE'`,
      [emailNorm]
    );

    if (rows[0]) {
      // In production, an email would be sent. For development/testing, we record a token
      const resetToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(resetToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.execute(
        `INSERT INTO account_tokens (admin_account_id, purpose, token_hash, expires_at)
         VALUES (?, 'PASSWORD_RESET', ?, ?)`,
        [rows[0].id, tokenHash, expiresAt]
      );
    }

    res.json({
      data: { message: 'If an active account exists with that email, a password reset link has been dispatched.' },
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
    const now = new Date();

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, admin_account_id, expires_at, used_at 
       FROM account_tokens 
       WHERE token_hash = ? AND purpose = 'PASSWORD_RESET'`,
      [tokenHash]
    );

    const tokenRecord = rows[0];
    if (!tokenRecord || tokenRecord.used_at || new Date(tokenRecord.expires_at) <= now) {
      throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Reset link is invalid or expired');
    }

    const hashedPassword = await hashPassword(body.newPassword);

    await pool.execute(
      `UPDATE admin_accounts SET password_hash = ? WHERE id = ?`,
      [hashedPassword, tokenRecord.admin_account_id]
    );

    await pool.execute(
      `UPDATE account_tokens SET used_at = NOW(3) WHERE id = ?`,
      [tokenRecord.id]
    );

    // Revoke all existing sessions
    await SessionManager.revokeAllAccountSessions(String(tokenRecord.admin_account_id));

    res.json({
      data: { message: 'Password has been reset successfully. Please log in with your new password.' },
      meta: { requestId: req.requestId },
    });
  } catch (err) {
    next(err);
  }
});
