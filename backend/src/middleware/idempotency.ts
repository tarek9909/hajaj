import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../infrastructure/database/pool.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_KEY_LENGTH = 128;

function reject(req: Request, res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: { code, message },
    meta: { requestId: req.requestId },
  });
}

export const handleIdempotency = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const rawKey = req.headers['idempotency-key'];
  if (!rawKey || !['POST', 'PUT', 'PATCH'].includes(req.method) || !req.sessionUser) {
    return next();
  }

  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0]! : rawKey;
  if (idempotencyKey.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(idempotencyKey)) {
    return reject(req, res, 400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-128 printable ASCII characters');
  }

  const adminAccountId = req.sessionUser.adminAccountId;
  const restaurantId = req.tenantContext?.restaurantId || null;
  const endpointPath = req.baseUrl + req.path;
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest();

  try {
    let recordId: number | null = null;

    for (let attempt = 0; attempt < 2 && recordId === null; attempt++) {
      try {
        const [ins] = await pool.execute<ResultSetHeader>(
          `INSERT INTO idempotency_requests
            (restaurant_id, admin_account_id, http_method, endpoint_path, idempotency_key, request_hash, status, lease_expires_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?)`,
          [
            restaurantId,
            adminAccountId,
            req.method,
            endpointPath,
            idempotencyKey,
            requestHash,
            new Date(Date.now() + LEASE_MS),
            new Date(Date.now() + RETENTION_MS),
          ]
        );
        recordId = ins.insertId;
        break;
      } catch (err: any) {
        if (err?.code !== 'ER_DUP_ENTRY') throw err;
      }

      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT id, status, response_status, response_body, request_hash,
                (expires_at <= NOW(3)) AS is_expired,
                (lease_expires_at IS NULL OR lease_expires_at <= NOW(3)) AS lease_lapsed
         FROM idempotency_requests
         WHERE admin_account_id = ? AND http_method = ? AND endpoint_path = ? AND idempotency_key = ?`,
        [adminAccountId, req.method, endpointPath, idempotencyKey]
      );
      const existing = rows[0];
      if (!existing) continue;

      if (existing.is_expired) {
        await pool.execute(`DELETE FROM idempotency_requests WHERE id = ? AND expires_at <= NOW(3)`, [existing.id]);
        continue;
      }

      const existingHash = existing.request_hash as Buffer;
      if (existingHash.length !== requestHash.length || !crypto.timingSafeEqual(existingHash, requestHash)) {
        return reject(
          req,
          res,
          409,
          'IDEMPOTENCY_CONFLICT',
          'A request with this Idempotency-Key was already processed with different payload'
        );
      }

      if (existing.status === 'COMPLETED' && existing.response_status) {
        res.setHeader('x-idempotent-replay', 'true');
        const body = typeof existing.response_body === 'string' ? JSON.parse(existing.response_body) : existing.response_body;
        if (body === null || body === undefined) {
          res.status(existing.response_status).end();
        } else {
          res.status(existing.response_status).json(body);
        }
        return;
      }

      // A crashed/abandoned request (lease lapsed) or a failed one may be retried.
      if (existing.status === 'FAILED' || (existing.status === 'PROCESSING' && existing.lease_lapsed)) {
        const [claim] = await pool.execute<ResultSetHeader>(
          `UPDATE idempotency_requests
           SET status = 'PROCESSING', response_status = NULL, response_body = NULL, lease_expires_at = ?
           WHERE id = ? AND (status = 'FAILED' OR (status = 'PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at <= NOW(3))))`,
          [new Date(Date.now() + LEASE_MS), existing.id]
        );
        if (claim.affectedRows === 1) {
          recordId = Number(existing.id);
          break;
        }
      }

      return reject(
        req,
        res,
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'A request with this Idempotency-Key is currently in progress'
      );
    }

    if (recordId === null) {
      return reject(req, res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'Unable to acquire idempotency lock, please retry');
    }

    const id = recordId;
    let captured: unknown;
    let hasBody = false;

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown): Response => {
      if (!hasBody) {
        hasBody = true;
        captured = body;
      }
      return originalSend(body as any);
    }) as Response['send'];

    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;

      let storedBody: string | null = null;
      let cacheable = success && res.statusCode >= 200 && res.statusCode < 300;

      if (cacheable) {
        if (hasBody && captured !== undefined) {
          try {
            const text = Buffer.isBuffer(captured) ? captured.toString('utf8') : String(captured);
            const isJson = String(res.getHeader('content-type') || '').includes('application/json');
            storedBody = isJson ? JSON.stringify(JSON.parse(text)) : null;
            cacheable = isJson;
          } catch {
            cacheable = false;
          }
        } else if (res.statusCode !== 204) {
          cacheable = false;
        }
      }

      const operation = cacheable
        ? pool.execute(
            `UPDATE idempotency_requests
             SET status = 'COMPLETED', response_status = ?, response_body = ?, lease_expires_at = NULL
             WHERE id = ?`,
            [res.statusCode, storedBody, id]
          )
        : pool.execute(`DELETE FROM idempotency_requests WHERE id = ?`, [id]);

      operation.catch((err) => console.error('Failed to settle idempotency record:', err));
    };

    res.on('finish', () => settle(true));
    res.on('close', () => settle(res.writableFinished));

    next();
  } catch (err) {
    next(err);
  }
};
