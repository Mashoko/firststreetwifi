import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getVoucherLifecycleCounts,
  getVoucherSalesTrend,
  getPackagePopularity,
  getLatestVouchers,
} from '../../services/analytics/vouchers.js';
import { PACKAGES } from '../../packages.js';

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
