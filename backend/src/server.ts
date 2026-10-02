import { createApp } from './app.js';
import dotenv from 'dotenv';
import { pool } from './infrastructure/database/pool.js';

dotenv.config();

const port = parseInt(process.env.PORT || '3000', 10);
const app = createApp();

async function startServer(): Promise<void> {
  try {
    // Verify database connection
    await pool.query('SELECT 1');
    console.log('[Server] Database connection established successfully.');

    app.listen(port, () => {
      console.log(`[Server] Restaurant Workforce Management Platform API listening on port ${port}`);
    });
  } catch (err) {
    console.error('[Server] Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
