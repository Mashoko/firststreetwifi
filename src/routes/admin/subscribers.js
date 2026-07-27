import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getSubscriberOverview,
  getSubscriberGrowth,
  getNewestSubscribers,
  getTopSpenders,
  getLapsedCustomers,
} from '../../services/analytics/subscribers.js';

export const subscribersRouter = express.Router();

subscribersRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const overview = getSubscriberOverview();
    const growth = getSubscriberGrowth(range);
    const newest = getNewestSubscribers();
    const topSpenders = getTopSpenders();
    const lapsed = getLapsedCustomers();
    res.render('admin/subscribers', { overview, growth, newest, topSpenders, lapsed, range });
  } catch (err) {
    next(err);
  }
});
