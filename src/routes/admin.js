import express from 'express';
import { db } from '../db/index.js';

export const adminRouter = express.Router();

adminRouter.get('/', (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                        AS total_tx,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END)  AS paid_tx,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 0) AS revenue
    FROM transactions
  `).get();

  const byPackage = db.prepare(`
    SELECT package_id, COUNT(*) AS count, COALESCE(SUM(amount),0) AS revenue
    FROM transactions WHERE status='paid'
    GROUP BY package_id ORDER BY revenue DESC
  `).all();

  const recent = db.prepare(`
    SELECT reference, package_id, amount, phone, status, voucher_code, created_at
    FROM transactions ORDER BY id DESC LIMIT 25
  `).all();

  res.render('admin', { totals, byPackage, recent });
});
