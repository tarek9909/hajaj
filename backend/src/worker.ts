import type { RowDataPacket } from 'mysql2/promise';
import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import { withTransaction, pool } from './infrastructure/database/pool.js';
import { PayrollService } from './modules/payroll/payrollService.js';
import dotenv from 'dotenv';

dotenv.config();

const LEASE_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const BASE_RETRY_DELAY_MS = 30 * 1000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

let isRunning = true;
let wakeSleep: (() => void) | null = null;

class NonRetryableJobError extends Error {}

interface ClaimedJob {
  id: number;
  restaurantId: number | null;
  jobType: string;
  payload: Record<string, any>;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: Buffer;
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  const leaseToken = crypto.randomBytes(16);
  const workerId = `worker-${process.pid}`;

  return await withTransaction(async (conn) => {
    const [jobs] = await conn.execute<RowDataPacket[]>(
      `SELECT id, restaurant_id, job_type, payload, attempt_count, max_attempts
       FROM jobs
       WHERE attempt_count < max_attempts
         AND ((status = 'QUEUED' AND available_at <= NOW(3))
              OR (status = 'RUNNING' AND lease_expires_at < NOW(3)))
       ORDER BY available_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    const job = jobs[0];
    if (!job) return null;

    await conn.execute(
      `UPDATE jobs
       SET status = 'RUNNING',
           lease_token = ?,
           locked_by = ?,
           lease_expires_at = ?,
           started_at = NOW(3),
           finished_at = NULL,
           attempt_count = attempt_count + 1
       WHERE id = ?`,
      [leaseToken, workerId, new Date(Date.now() + LEASE_MS), job.id]
    );

    return {
      id: Number(job.id),
      restaurantId: job.restaurant_id === null ? null : Number(job.restaurant_id),
      jobType: job.job_type,
      payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload,
      attemptCount: Number(job.attempt_count) + 1,
      maxAttempts: Number(job.max_attempts),
      leaseToken,
    };
  });
}

async function executeJob(job: ClaimedJob): Promise<void> {
  switch (job.jobType) {
    case 'PAYROLL_RECALCULATE': {
      if (job.restaurantId === null) {
        throw new NonRetryableJobError('PAYROLL_RECALCULATE requires a restaurant');
      }
      const month = job.payload.month ? String(job.payload.month).slice(0, 7) : new Date().toISOString().slice(0, 7);
      await PayrollService.executeCalculationRun(String(job.restaurantId), month);
      return;
    }
    case 'ACCOUNT_EMAIL': {
      console.log(`[Worker] ACCOUNT_EMAIL (no mail transport configured):`, JSON.stringify(job.payload));
      return;
    }
    default:
      throw new NonRetryableJobError(`Job type ${job.jobType} is not implemented`);
  }
}

async function finishJob(job: ClaimedJob, error: unknown | null): Promise<void> {
  await withTransaction(async (conn) => {
    if (error === null) {
      await conn.execute(
        `UPDATE jobs
         SET status = 'SUCCEEDED',
             finished_at = NOW(3),
             error_text = NULL,
             lease_token = NULL,
             locked_by = NULL,
             lease_expires_at = NULL
         WHERE id = ? AND lease_token = ?`,
        [job.id, job.leaseToken]
      );
      return;
    }

    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000) || 'Unknown error';
    const terminal = error instanceof NonRetryableJobError || job.attemptCount >= job.maxAttempts;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (job.attemptCount - 1), MAX_RETRY_DELAY_MS);

    await conn.execute(
      `UPDATE jobs
       SET status = ?,
           error_text = ?,
           available_at = ?,
           finished_at = ?,
           lease_token = NULL,
           locked_by = NULL,
           lease_expires_at = NULL
       WHERE id = ? AND lease_token = ?`,
      [
        terminal ? 'FAILED' : 'QUEUED',
        message,
        new Date(Date.now() + delay),
        terminal ? new Date() : null,
        job.id,
        job.leaseToken,
      ]
    );
  });
}

async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;

  console.log(`[Worker] Claimed job ${job.id} (${job.jobType}) for restaurant ${job.restaurantId}`);

  let failure: unknown | null = null;
  try {
    await executeJob(job);
  } catch (err) {
    failure = err ?? new Error('Unknown error');
    console.error(`[Worker] Job ${job.id} failed:`, err);
  }

  await finishJob(job, failure);
  if (failure === null) console.log(`[Worker] Job ${job.id} succeeded`);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

function stop(signal: string): void {
  if (!isRunning) return;
  console.log(`[Worker] Received ${signal}, shutting down after current job...`);
  isRunning = false;
  wakeSleep?.();
}

async function startWorkerLoop(): Promise<void> {
  console.log('[Worker] Starting Restaurant Workforce Background Worker...');
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (isRunning) {
    try {
      const worked = await processNextJob();
      if (!worked) await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error('[Worker] Polling loop error:', err);
      await sleep(5000);
    }
  }

  await pool.end();
  console.log('[Worker] Stopped.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startWorkerLoop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Worker] Fatal error:', err);
      process.exit(1);
    });
}
