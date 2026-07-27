import express from 'express';
import { getOverviewData } from '../../services/analytics/overview.js';

export const overviewRouter = express.Router();

overviewRouter.get('/', async (req, res, next) => {
  try {
    const data = await getOverviewData();
    res.render('admin/overview', data);
  } catch (err) {
    next(err);
  }
});
