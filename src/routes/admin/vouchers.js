import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getVoucherLifecycleCounts,
  getVoucherSalesTrend,
  getPackagePopularity,
  getLatestVouchers,
} from '../../services/analytics/vouchers.js';
import { PACKAGES } from '../../packages.js';
import { toCsv } from '../../lib/csv.js';

export const vouchersRouter = express.Router();

vouchersRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const lifecycle = getVoucherLifecycleCounts(range);
    const salesTrend = getVoucherSalesTrend(range);
    const popularity = getPackagePopularity({ ...range, packageId });
    const latest = getLatestVouchers({ ...range, packageId, limit: 25 });
    res.render('admin/vouchers', {
      lifecycle, salesTrend, popularity, latest,
      range, packageId, packages: PACKAGES.map((p) => p.id),
    });
  } catch (err) {
    next(err);
  }
});

vouchersRouter.get('/export.csv', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const rows = getLatestVouchers({ ...range, packageId, limit: 10000 });
    const csv = toCsv(rows, [
      { key: 'code', label: 'Code' },
      { key: 'package_id', label: 'Package' },
      { key: 'status', label: 'Status' },
      { key: 'expires_at', label: 'Expires' },
      { key: 'created_at', label: 'Created' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="vouchers.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
