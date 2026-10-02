import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app.js';
import { pool } from './infrastructure/database/pool.js';

const port = parseInt(process.env.PORT || '3000', 10);
const app = createApp();

async function startServer(): Promise<void> {
  try {
    // Verify database connection
    await pool.query('SELECT 1');
    console.log('[Server] Database connection established successfully.');

    const server = app.listen(port, () => {
      console.log(`[Server] Restaurant Workforce Management Platform API listening on port ${port}`);
    });

    const shutdown = (signal: string) => {
      console.log(`[Server] ${signal} received, shutting down...`);
      server.close(async () => {
        await pool.end().catch(() => undefined);
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('[Server] Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
