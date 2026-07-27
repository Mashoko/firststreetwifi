import { db } from '../../db/index.js';

export function getRevenueOverview() {
  const sumWhere = (clause) =>
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE status='paid' AND ${clause}`).get().n;

  const today = sumWhere(`date(created_at) = date('now')`);
  const yesterday = sumWhere(`date(created_at) = date('now','-1 day')`);
  const week = sumWhere(`date(created_at) >= date('now','-6 days')`);
  const month = sumWhere(`strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`);
  const year = sumWhere(`strftime('%Y', created_at) = strftime('%Y','now')`);

  const changePct = yesterday === 0 ? (today > 0 ? 100 : 0) : ((today - yesterday) / yesterday) * 100;

  return { today, week, month, year, yesterday, changePct };
}

export function getRevenueTrend({ from, to }) {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COALESCE(SUM(amount),0) AS revenue
       FROM transactions WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getRevenueByPackage({ from, to, packageId }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId] : [from, to];
  return db
    .prepare(
      `SELECT package_id, COUNT(*) AS count, COALESCE(SUM(amount),0) AS revenue
       FROM transactions
       WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?) ${clause}
       GROUP BY package_id ORDER BY revenue DESC`
    )
    .all(...params);
}

export function getTransactionOutcomes({ from, to }) {
  return db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM transactions WHERE date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY status`
    )
    .all(from, to);
}

export function getRecentPayments({ from, to, limit = 25 }) {
  return db
    .prepare(
      `SELECT reference, package_id, amount, phone, status, voucher_code, created_at
       FROM transactions WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(from, to, limit);
}

export function getFailedTransactions({ from, to, limit = 25 }) {
  return db
    .prepare(
      `SELECT reference, package_id, amount, phone, status, created_at
       FROM transactions WHERE status IN ('failed','cancelled') AND date(created_at) BETWEEN date(?) AND date(?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(from, to, limit);
}
