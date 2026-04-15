const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const hasPostgres = Boolean(connectionString);

let pool = null;

if (hasPostgres) {
  pool = new Pool({
    connectionString,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

async function query(sql, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return pool.query(sql, params);
}

async function initDatabase() {
  if (!pool) return;

  await query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      owner_email TEXT NOT NULL,
      owner_name TEXT,
      industry TEXT,
      plan TEXT NOT NULL DEFAULT 'starter',
      trial_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT,
      identifier TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, identifier)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      identifier TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'citizen',
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'citizen';`);
  await query(`CREATE INDEX IF NOT EXISTS idx_otp_identifier ON otp_codes(identifier);`);

  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      complaint TEXT NOT NULL,
      severity_score INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      upload_token TEXT UNIQUE NOT NULL,
      upload_expiry TIMESTAMPTZ NOT NULL,
      notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_org_created ON tickets(org_id, created_at DESC);`);

  await query(`
    CREATE TABLE IF NOT EXISTS ticket_files (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`ALTER TABLE ticket_files ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'local';`);
  await query(`ALTER TABLE ticket_files ADD COLUMN IF NOT EXISTS storage_key TEXT;`);

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      org_id TEXT,
      identifier TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      org_id TEXT UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'trialing',
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      accepted_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = {
  hasPostgres,
  initDatabase,
  query,
};
