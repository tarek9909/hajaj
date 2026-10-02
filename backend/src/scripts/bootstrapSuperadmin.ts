import path from 'path';
import { pathToFileURL } from 'url';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../infrastructure/database/pool.js';
import { hashPassword } from '../infrastructure/auth/passwords.js';

const DEV_EMAIL = 'superadmin@workforce.local';
const DEV_PASSWORD = 'SuperAdminPassword123!';

export interface BootstrapOptions {
  email?: string;
  fullName?: string;
  password?: string;
  reset?: boolean;
}

export async function bootstrapSuperadmin(options: BootstrapOptions = {}): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  const email = options.email ?? process.env.BOOTSTRAP_SUPERADMIN_EMAIL ?? (isProduction ? undefined : DEV_EMAIL);
  const password =
    options.password ?? process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ?? (isProduction ? undefined : DEV_PASSWORD);
  const fullName = options.fullName ?? 'Platform Superadmin';

  if (!email || !password) {
    throw new Error(
      'Superadmin email and password are required in production (args: <email> <password> or BOOTSTRAP_SUPERADMIN_EMAIL / BOOTSTRAP_SUPERADMIN_PASSWORD).'
    );
  }
  if (password.length < 8) {
    throw new Error('Superadmin password must be at least 8 characters.');
  }

  const emailNorm = email.toLowerCase().trim();
  console.log(`Checking Superadmin: ${emailNorm}...`);

  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT id, account_kind FROM admin_accounts WHERE email_normalized = ?',
    [emailNorm]
  );

  if (existing.length > 0) {
    if (!options.reset) {
      console.log(`Superadmin ${emailNorm} already exists. Pass --reset to overwrite its password.`);
      return;
    }
    if (existing[0]!.account_kind !== 'SUPERADMIN') {
      throw new Error(`Account ${emailNorm} exists but is not a SUPERADMIN; refusing to reset it.`);
    }

    console.log(`Resetting credentials for Superadmin ${emailNorm}...`);
    const hashed = await hashPassword(password);
    await pool.execute(
      `UPDATE admin_accounts
       SET password_hash = ?, password_setup_required = 0, status = 'ACTIVE'
       WHERE id = ?`,
      [hashed, existing[0]!.id]
    );
    await pool.execute(`UPDATE sessions SET revoked_at = NOW(3) WHERE admin_account_id = ? AND revoked_at IS NULL`, [
      existing[0]!.id,
    ]);
    console.log(`Superadmin ${emailNorm} updated successfully.`);
    return;
  }

  console.log(`Creating initial Superadmin ${emailNorm}...`);
  const hashed = await hashPassword(password);
  await pool.execute(
    `INSERT INTO admin_accounts
      (restaurant_id, account_kind, full_name, email_normalized, password_hash, password_setup_required, status)
     VALUES (NULL, 'SUPERADMIN', ?, ?, ?, 0, 'ACTIVE')`,
    [fullName, emailNorm, hashed]
  );
  console.log(`Superadmin created: ${emailNorm}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const [email, password] = args.filter((a) => !a.startsWith('--'));

  bootstrapSuperadmin({ email, password, reset })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Superadmin bootstrap error:', err);
      process.exit(1);
    });
}
