import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = req.requestId || 'unknown-request';

  // Handle Zod Validation Errors
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: first ? `${where}${first.message}` : 'Invalid request input',
        details: { issues: err.issues },
      },
      meta: { requestId },
    });
    return;
  }

  // Handle Application Errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || {},
      },
      meta: { requestId },
    });
    return;
  }

  // MySQL specific errors
  if (err && typeof err === 'object' && 'errno' in err) {
    if (err.errno === 1062) {
      // Duplicate entry
      res.status(409).json({
        error: {
          code: 'DUPLICATE_RESOURCE',
          message: 'A resource with this identifier or unique property already exists.',
          details: { sqlMessage: err.sqlMessage },
        },
        meta: { requestId },
      });
      return;
    }
  }

  // Malformed JSON bodies and oversized payloads are client errors, not 500s
  if (err && typeof err === 'object' && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({
      error: { code: 'BAD_REQUEST', message: err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed JSON body' },
      meta: { requestId },
    });
    return;
  }

  console.error(`[${requestId}] Internal Server Error:`, err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred. Please try again.',
    },
    meta: { requestId },
  });
};
