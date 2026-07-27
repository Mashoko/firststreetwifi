import { db } from '../../db/index.js';

export function getVoucherLifecycleCounts({ from, to }) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sold,
         SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
         SUM(CASE WHEN status='used' AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='expired' OR (status='used' AND expires_at <= datetime('now')) THEN 1 ELSE 0 END) AS expired
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?)`
    )
    .get(from, to);

  return {
    sold: row.sold || 0,
    unused: row.unused || 0,
    active: row.active || 0,
    expired: row.expired || 0,
  };
}

export function getVoucherSalesTrend({ from, to }) {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getPackagePopularity({ from, to, packageId }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId] : [from, to];
  return db
    .prepare(
      `SELECT package_id, COUNT(*) AS count
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?) ${clause}
       GROUP BY package_id ORDER BY count DESC`
    )
    .all(...params);
}

export function getLatestVouchers({ from, to, packageId, limit = 25 }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId, limit] : [from, to, limit];
  return db
    .prepare(
      `SELECT code, package_id, minutes, status, expires_at, created_at, used_at
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?) ${clause}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params);
}
