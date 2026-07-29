import express from 'express';
import { getConnectedClients } from '../../services/omada.js';

export const liveRouter = express.Router();

liveRouter.get('/', async (req, res, next) => {
  try {
    const data = await getConnectedClients();
    res.render('admin/live', data);
  } catch (err) {
    next(err);
  }
});

liveRouter.get('/data', async (req, res, next) => {
  try {
    const data = await getConnectedClients();
    res.json(data);
  } catch (err) {
    next(err);
  }
});
