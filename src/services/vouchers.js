import { db } from '../db/index.js';

// Human-friendly voucher codes (no ambiguous chars like 0/O, 1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function createVoucher({ packageId, minutes, dataBytes, transactionId }) {
  let code;
  // Ensure uniqueness
  for (let attempt = 0; attempt < 10; attempt++) {
    code = randomCode();
    const exists = db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code);
    if (!exists) break;
  }
  const info = db
    .prepare(
      `INSERT INTO vouchers (code, package_id, minutes, data_bytes, transaction_id, status)
       VALUES (?, ?, ?, ?, ?, 'unused')`
    )
    .run(code, packageId, minutes, dataBytes ?? null, transactionId);
  return { id: info.lastInsertRowid, code, minutes, dataBytes, packageId };
}

export function findVoucher(code) {
  return db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code.trim().toUpperCase());
}

export function markVoucherUsed(code, minutes) {
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  db.prepare(
    `UPDATE vouchers SET status = 'used', used_at = datetime('now'), expires_at = ? WHERE code = ?`
  ).run(expiresAt, code);
}
