import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../infrastructure/database/pool.js';

export const handleIdempotency = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey || !['POST', 'PUT', 'PATCH'].includes(req.method) || !req.sessionUser) {
    return next();
  }

  const adminAccountId = req.sessionUser.adminAccountId;
  const restaurantId = req.tenantContext?.restaurantId || null;
  const endpointPath = req.baseUrl + req.path;
  const requestBodyStr = JSON.stringify(req.body || {});
  const requestHash = crypto.createHash('sha256').update(requestBodyStr).digest();

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, response_status, response_body, request_hash 
       FROM idempotency_requests 
       WHERE admin_account_id = ? AND http_method = ? AND endpoint_path = ? AND idempotency_key = ?`,
      [adminAccountId, req.method, endpointPath, idempotencyKey]
    );

    const existing = rows[0];
    if (existing) {
      const existingHash = existing.request_hash as Buffer;
      if (!crypto.timingSafeEqual(existingHash, requestHash)) {
        res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'A request with this Idempotency-Key was already processed with different payload',
          },
          meta: { requestId: req.requestId },
        });
        return;
      }

      if (existing.status === 'COMPLETED' && existing.response_status) {
        res.setHeader('x-idempotent-replay', 'true');
        res.status(existing.response_status).json(existing.response_body);
        return;
      }

      if (existing.status === 'PROCESSING') {
        res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_IN_PROGRESS',
            message: 'A request with this Idempotency-Key is currently in progress',
          },
          meta: { requestId: req.requestId },
        });
        return;
      }
    }

    // Insert processing record
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await pool.execute(
      `INSERT INTO idempotency_requests 
        (restaurant_id, admin_account_id, http_method, endpoint_path, idempotency_key, request_hash, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?)
       ON DUPLICATE KEY UPDATE updated_at = NOW(3)`,
      [restaurantId, adminAccountId, req.method, endpointPath, idempotencyKey, requestHash, expiresAt]
    );

    // Intercept response to store upon completion
    const originalJson = res.json.bind(res);
    res.json = (body: any): Response => {
      const statusCode = res.statusCode;
      // Asynchronously store completion
      pool.execute(
        `UPDATE idempotency_requests 
         SET status = 'COMPLETED', response_status = ?, response_body = ?, updated_at = NOW(3)
         WHERE admin_account_id = ? AND http_method = ? AND endpoint_path = ? AND idempotency_key = ?`,
        [statusCode, JSON.stringify(body), adminAccountId, req.method, endpointPath, idempotencyKey]
      ).catch((err) => console.error('Failed to save idempotency response:', err));

      return originalJson(body);
    };

    next();
  } catch (err) {
    next(err);
  }
};
