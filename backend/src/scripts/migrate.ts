import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { fileURLToPath, pathToFileURL } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASELINE_VERSION = '001_initial_schema';

/**
 * Splits a SQL script into individual statements, honouring DELIMITER directives
 * (used for triggers/procedures) and dropping CREATE DATABASE / USE statements.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer: string[] = [];

  const flush = (): void => {
    const statement = buffer.join('\n').trim();
    buffer = [];
    if (!statement) return;
    if (/^CREATE\s+DATABASE\b/i.test(statement) || /^USE\s/i.test(statement)) return;
    statements.push(statement);
  };

  for (const rawLine of script.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (buffer.length === 0) {
      if (trimmed === '' || trimmed.startsWith('--')) continue;
      const delimiterMatch = /^DELIMITER\s+(\S+)\s*$/i.exec(trimmed);
      if (delimiterMatch) {
        delimiter = delimiterMatch[1]!;
        continue;
      }
    }

    if (trimmed.endsWith(delimiter)) {
      buffer.push(line.slice(0, line.lastIndexOf(delimiter)));
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return statements;
}

async function runScript(conn: Connection, script: string): Promise<void> {
  for (const statement of splitSqlStatements(script)) {
    await conn.query(statement);
  }
}

export async function runMigrations(): Promise<void> {
  console.log('--- Checking Database Migrations ---');

  const dbName = process.env.DB_NAME || 'restaurant_workforce';
  const connectionConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    timezone: '+00:00',
  };

  const bootstrap = await mysql.createConnection(connectionConfig);
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  } finally {
    await bootstrap.end();
  }

  const conn = await mysql.createConnection({ ...connectionConfig, database: dbName });
  try {
    await conn.query(`SET time_zone = '+00:00'`);

    const [tables] = await conn.query<RowDataPacket[]>(`SHOW TABLES`);
    const tableNames = new Set(tables.map((row) => String(Object.values(row)[0])));

    if (!tableNames.has('schema_migrations')) {
      if (tableNames.size > 0) {
        throw new Error(
          `Database "${dbName}" contains tables but no schema_migrations table (a previous baseline run likely failed midway). Drop the database and re-run.`
        );
      }

      console.log('Database not yet initialized. Running baseline restaurant_workforce.sql...');
      const sqlPath = path.resolve(__dirname, '../../../restaurant_workforce.sql');
      if (!fs.existsSync(sqlPath)) {
        throw new Error(`Baseline SQL not found at: ${sqlPath}`);
      }

      // The baseline script records its own schema_migrations row as its final statement.
      await runScript(conn, fs.readFileSync(sqlPath, 'utf8'));
      console.log('Baseline schema created successfully.');
    } else {
      console.log('Baseline schema already applied.');
    }

    const migrationsDir = path.resolve(__dirname, '../../../database/migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      const [appliedRows] = await conn.query<RowDataPacket[]>('SELECT version FROM schema_migrations');
      const appliedSet = new Set(appliedRows.map((r) => r.version));

      for (const file of files) {
        const version = path.basename(file, '.sql');
        if (version === BASELINE_VERSION || appliedSet.has(version)) continue;

        console.log(`Applying migration: ${file}...`);
        await runScript(conn, fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
        await conn.query('INSERT INTO schema_migrations (version, description) VALUES (?, ?)', [
          version,
          `Migration ${file}`,
        ]);
        console.log(`Applied: ${file}`);
      }
    }
  } finally {
    await conn.end();
  }

  console.log('Migrations complete.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
