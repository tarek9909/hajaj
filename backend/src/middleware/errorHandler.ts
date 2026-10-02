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
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request input',
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

  console.error(`[${requestId}] Internal Server Error:`, err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred. Please try again.',
    },
    meta: { requestId },
  });
};
