import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '..', 'data.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reference    TEXT UNIQUE NOT NULL,
      package_id   TEXT NOT NULL,
      amount       REAL NOT NULL,
      phone        TEXT,
      email        TEXT,
      method       TEXT DEFAULT 'ecocash',
      poll_url     TEXT,
      status       TEXT DEFAULT 'created',   -- created | sent | paid | failed | cancelled
      voucher_code TEXT,
      client_mac   TEXT,
      ap_mac       TEXT,
      ssid         TEXT,
      radio_id     TEXT,
      site         TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vouchers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT UNIQUE NOT NULL,
      package_id   TEXT NOT NULL,
      minutes      INTEGER NOT NULL,
      status       TEXT DEFAULT 'unused',    -- unused | used | expired
      transaction_id INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      used_at      TEXT,
      expires_at   TEXT,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tx_ref ON transactions(reference);
    CREATE INDEX IF NOT EXISTS idx_voucher_code ON vouchers(code);
  `);
}
