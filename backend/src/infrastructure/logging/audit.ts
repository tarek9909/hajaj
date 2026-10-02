import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../database/pool.js';
import type { AccountKind } from '../../contracts/types.js';

export interface AuditParams {
  restaurantId?: string | null;
  actorId?: string | null;
  actorKind: AccountKind | 'SYSTEM';
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  reason?: string | null;
  beforeValues?: Record<string, unknown> | null;
  afterValues?: Record<string, unknown> | null;
}

export async function recordAuditEvent(
  params: AuditParams,
  connection?: PoolConnection
): Promise<void> {
  const conn = connection || pool;
  await conn.execute(
    `INSERT INTO audit_events 
      (restaurant_id, actor_id, actor_kind, action, entity_type, entity_id, request_id, reason, before_values, after_values)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.restaurantId || null,
      params.actorId || null,
      params.actorKind,
      params.action,
      params.entityType,
      params.entityId || null,
      params.requestId || null,
      params.reason || null,
      params.beforeValues ? JSON.stringify(params.beforeValues) : null,
      params.afterValues ? JSON.stringify(params.afterValues) : null,
    ]
  );
}
