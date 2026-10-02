import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

export const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'restaurant_workforce',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  timezone: '+00:00',
});

pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/**
 * Execute a unit of work inside an explicit transaction.
 * Automatically commits on success and rolls back on failure.
 */
export async function withTransaction<T>(
  callback: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
