import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../infrastructure/database/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  console.log('--- Checking Database Migrations ---');

  // Check if schema_migrations exists
  let schemaMigrationsExists = false;
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SHOW TABLES LIKE 'schema_migrations'`
    );
    schemaMigrationsExists = rows.length > 0;
  } catch (err) {
    console.error('Database connection error:', err);
    throw err;
  }

  if (!schemaMigrationsExists) {
    console.log('Database not yet initialized. Running baseline restaurant_workforce.sql...');
    const sqlPath = path.resolve(__dirname, '../../../restaurant_workforce.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Baseline SQL not found at: ${sqlPath}`);
    }

    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    // Connect to execute
    const conn = await pool.getConnection();
    try {
      await conn.query(sqlContent);
      console.log('Baseline schema created successfully.');
    } finally {
      conn.release();
    }
  } else {
    console.log('Baseline schema already applied.');
  }

  // Check migrations folder for any subsequent versioned migrations
  const migrationsDir = path.resolve(__dirname, '../../../database/migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const [appliedRows] = await pool.query<RowDataPacket[]>(
      'SELECT version FROM schema_migrations'
    );
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (!appliedSet.has(version)) {
        console.log(`Applying migration: ${file}...`);
        const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const conn = await pool.getConnection();
        try {
          await conn.query(content);
          await conn.query(
            'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
            [version, `Migration ${file}`]
          );
          console.log(`Applied: ${file}`);
        } finally {
          conn.release();
        }
      }
    }
  }

  console.log('Migrations complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
