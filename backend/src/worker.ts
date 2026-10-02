import type { RowDataPacket } from 'mysql2/promise';
import crypto from 'crypto';
import { withTransaction, pool } from './infrastructure/database/pool.js';
import { PayrollService } from './modules/payroll/payrollService.js';
import dotenv from 'dotenv';

dotenv.config();

let isRunning = true;

async function processNextJob(): Promise<boolean> {
  const leaseToken = crypto.randomBytes(16);
  const workerId = `worker-${process.pid}`;

  return await withTransaction(async (conn) => {
    // 1. Claim one queued job with SKIP LOCKED
    const [jobs] = await conn.execute<RowDataPacket[]>(
      `SELECT id, restaurant_id, job_type, payload, attempt_count, max_attempts 
       FROM jobs 
       WHERE status = 'QUEUED' AND available_at <= NOW(3) 
       ORDER BY available_at ASC, id ASC 
       LIMIT 1 
       FOR UPDATE SKIP LOCKED`
    );

    const job = jobs[0];
    if (!job) return false;

    // 2. Lock and set to RUNNING
    const leaseExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min lease
    await conn.execute(
      `UPDATE jobs 
       SET status = 'RUNNING',
           lease_token = ?,
           locked_by = ?,
           lease_expires_at = ?,
           started_at = NOW(3),
           attempt_count = attempt_count + 1
       WHERE id = ?`,
      [leaseToken, workerId, leaseExpires, job.id]
    );

    console.log(`[Worker] Claimed job ${job.id} (${job.job_type}) for restaurant ${job.restaurant_id}`);

    // 3. Process Job outside the long transaction or inside
    try {
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

      if (job.job_type === 'PAYROLL_RECALCULATE') {
        const month = payload.month ? payload.month.slice(0, 7) : new Date().toISOString().slice(0, 7);
        await PayrollService.executeCalculationRun(String(job.restaurant_id), month);
      }

      await conn.execute(
        `UPDATE jobs 
         SET status = 'SUCCEEDED',
             finished_at = NOW(3),
             lease_token = NULL,
             locked_by = NULL,
             lease_expires_at = NULL
         WHERE id = ?`,
        [job.id]
      );

      console.log(`[Worker] Job ${job.id} succeeded`);
    } catch (err: any) {
      console.error(`[Worker] Job ${job.id} failed:`, err);
      const isExhausted = Number(job.attempt_count) + 1 >= Number(job.max_attempts);
      const nextAvailable = new Date(Date.now() + 30 * 1000); // retry in 30s

      await conn.execute(
        `UPDATE jobs 
         SET status = ?,
             error_text = ?,
             available_at = ?,
             lease_token = NULL,
             locked_by = NULL,
             lease_expires_at = NULL
         WHERE id = ?`,
        [isExhausted ? 'FAILED' : 'QUEUED', err.message || 'Unknown error', nextAvailable, job.id]
      );
    }

    return true;
  });
}

async function startWorkerLoop(): Promise<void> {
  console.log('[Worker] Starting Restaurant Workforce Background Worker...');

  while (isRunning) {
    try {
      const worked = await processNextJob();
      if (!worked) {
        // Sleep 2 seconds before next poll
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (err) {
      console.error('[Worker] Polling loop error:', err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

if (process.argv[1]?.includes('worker')) {
  startWorkerLoop().catch((err) => {
    console.error('[Worker] Fatal error:', err);
    process.exit(1);
  });
}
