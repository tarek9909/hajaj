import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../infrastructure/database/pool.js';
import { hashPassword } from '../infrastructure/auth/passwords.js';

export async function bootstrapSuperadmin(
  email = 'superadmin@workforce.local',
  fullName = 'Platform Superadmin',
  password = 'SuperAdminPassword123!'
): Promise<void> {
  const emailNorm = email.toLowerCase().trim();
  console.log(`Checking Superadmin: ${emailNorm}...`);

  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT id, email_normalized, status FROM admin_accounts WHERE email_normalized = ?',
    [emailNorm]
  );

  const hashed = await hashPassword(password);

  if (existing.length > 0) {
    console.log(`Superadmin ${emailNorm} already exists. Updating credentials...`);
    await pool.execute(
      `UPDATE admin_accounts 
       SET password_hash = ?, password_setup_required = 0, status = 'ACTIVE' 
       WHERE id = ?`,
      [hashed, existing[0]!.id]
    );
    console.log(`Superadmin ${emailNorm} updated successfully.`);
  } else {
    console.log(`Creating initial Superadmin ${emailNorm}...`);
    await pool.execute(
      `INSERT INTO admin_accounts 
        (restaurant_id, account_kind, full_name, email_normalized, password_hash, password_setup_required, status)
       VALUES (NULL, 'SUPERADMIN', ?, ?, ?, 0, 'ACTIVE')`,
      [fullName, emailNorm, hashed]
    );
    console.log(`Superadmin created: ${emailNorm}`);
  }
}

if (process.argv[1]?.includes('bootstrapSuperadmin')) {
  bootstrapSuperadmin()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Superadmin bootstrap error:', err);
      process.exit(1);
    });
}
