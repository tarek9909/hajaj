import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { SessionManager } from '../infrastructure/sessions/sessionManager.js';
import type { TenantContext, UserSession } from '../contracts/types.js';

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      sessionUser?: UserSession;
      tenantContext?: TenantContext;
    }
  }
}

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.requestId = reqId;
  res.setHeader('x-request-id', reqId);
  next();
};

export const authenticateSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const sessionToken = req.cookies?.session_token || req.cookies?.['__Host-session'];
  if (!sessionToken) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  const sessionUser = await SessionManager.validateSession(sessionToken);
  if (!sessionUser) {
    res.status(401).json({
      error: { code: 'SESSION_INVALID_OR_EXPIRED', message: 'Session is invalid, expired, or deactivated' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  req.sessionUser = sessionUser;
  next();
};

export const requireCsrfProtection = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const sessionToken = req.cookies?.session_token || req.cookies?.['__Host-session'];
  const csrfToken = req.headers['x-csrf-token'] as string;

  if (!sessionToken || !csrfToken) {
    res.status(403).json({
      error: { code: 'CSRF_TOKEN_MISSING', message: 'Missing CSRF token in request header' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  const isValid = await SessionManager.verifyCsrfToken(sessionToken, csrfToken);
  if (!isValid) {
    res.status(403).json({
      error: { code: 'CSRF_TOKEN_INVALID', message: 'Invalid CSRF token' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  next();
};

export const requireSuperadmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.sessionUser || req.sessionUser.accountKind !== 'SUPERADMIN') {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Superadmin access required' },
      meta: { requestId: req.requestId },
    });
    return;
  }
  next();
};

export const resolveTenantContext = (req: Request, res: Response, next: NextFunction): void => {
  const sessionUser = req.sessionUser;
  if (!sessionUser) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  const rawParam = req.params.restaurantId;
  const routeRestaurantId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (!routeRestaurantId) {
    res.status(400).json({
      error: { code: 'TENANT_ID_REQUIRED', message: 'Restaurant ID parameter missing' },
      meta: { requestId: req.requestId },
    });
    return;
  }

  // Superadmins can access any restaurant context.
  // Restaurant admins can ONLY access their own assigned restaurant.
  if (sessionUser.accountKind === 'RESTAURANT_ADMIN') {
    if (sessionUser.restaurantId !== routeRestaurantId) {
      res.status(403).json({
        error: { code: 'TENANT_ACCESS_DENIED', message: 'Cross-tenant access prohibited' },
        meta: { requestId: req.requestId },
      });
      return;
    }
  }

  req.tenantContext = {
    restaurantId: routeRestaurantId,
    actorId: sessionUser.adminAccountId,
    accountKind: sessionUser.accountKind,
    requestId: req.requestId,
  };

  next();
};
