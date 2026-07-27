import { db } from '../../db/index.js';

const PAID_PHONE_FILTER = `status='paid' AND phone IS NOT NULL AND phone != ''`;

export function getSubscriberOverview() {
  const total = db
    .prepare(`SELECT COUNT(DISTINCT phone) AS n FROM transactions WHERE ${PAID_PHONE_FILTER}`)
    .get().n;

  const active = db
    .prepare(
      `SELECT COUNT(DISTINCT t.phone) AS n
       FROM vouchers v
       JOIN transactions t ON t.id = v.transaction_id
       WHERE v.status='used' AND v.expires_at > datetime('now')
         AND t.phone IS NOT NULL AND t.phone != ''`
    )
    .get().n;

  const firstPurchasePerPhone = `
    SELECT phone, MIN(created_at) AS first_paid
    FROM transactions WHERE ${PAID_PHONE_FILTER}
    GROUP BY phone
  `;

  const newThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${firstPurchasePerPhone})
       WHERE strftime('%Y-%m', first_paid) = strftime('%Y-%m', 'now')`
    )
    .get().n;

  const newLastMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${firstPurchasePerPhone})
       WHERE strftime('%Y-%m', first_paid) = strftime('%Y-%m', 'now', '-1 month')`
    )
    .get().n;

  const growthPct =
    newLastMonth === 0 ? (newThisMonth > 0 ? 100 : 0) : ((newThisMonth - newLastMonth) / newLastMonth) * 100;

  return { total, active, newThisMonth, newLastMonth, growthPct };
}

export function getSubscriberGrowth({ from, to }) {
  return db
    .prepare(
      `SELECT day, COUNT(*) AS newSubscribers FROM (
         SELECT phone, date(MIN(created_at)) AS day
         FROM transactions WHERE ${PAID_PHONE_FILTER}
         GROUP BY phone
       )
       WHERE day BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getNewestSubscribers(limit = 10) {
  return db
    .prepare(
      `SELECT phone, MIN(created_at) AS first_purchase, COUNT(*) AS purchases, SUM(amount) AS totalSpent
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone ORDER BY first_purchase DESC LIMIT ?`
    )
    .all(limit);
}

export function getTopSpenders(limit = 10) {
  return db
    .prepare(
      `SELECT phone, SUM(amount) AS totalSpent, COUNT(*) AS purchases
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone ORDER BY totalSpent DESC LIMIT ?`
    )
    .all(limit);
}

export function getLapsedCustomers(limit = 10) {
  return db
    .prepare(
      `SELECT phone, MAX(created_at) AS lastPurchase,
              julianday('now') - julianday(MAX(created_at)) AS daysSince
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone
       HAVING daysSince > 7
       ORDER BY lastPurchase DESC LIMIT ?`
    )
    .all(limit);
}
