import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getRevenueOverview,
  getRevenueTrend,
  getRevenueByPackage,
  getTransactionOutcomes,
  getRecentPayments,
  getFailedTransactions,
} from '../../services/analytics/revenue.js';
import { PACKAGES } from '../../packages.js';
import { toCsv } from '../../lib/csv.js';

export const revenueRouter = express.Router();

revenueRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const overview = getRevenueOverview();
    const trend = getRevenueTrend(range);
    const byPackage = getRevenueByPackage({ ...range, packageId });
    const outcomes = getTransactionOutcomes(range);
    const recent = getRecentPayments({ ...range, limit: 25 });
    const failed = getFailedTransactions({ ...range, limit: 25 });
    res.render('admin/revenue', {
      overview, trend, byPackage, outcomes, recent, failed,
      range, packageId, packages: PACKAGES.map((p) => p.id),
    });
  } catch (err) {
    next(err);
  }
});

revenueRouter.get('/export.csv', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const rows = getRecentPayments({ ...range, limit: 10000 });
    const csv = toCsv(rows, [
      { key: 'reference', label: 'Reference' },
      { key: 'package_id', label: 'Package' },
      { key: 'amount', label: 'Amount' },
      { key: 'phone', label: 'Phone' },
      { key: 'status', label: 'Status' },
      { key: 'voucher_code', label: 'Voucher' },
      { key: 'created_at', label: 'Date' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
