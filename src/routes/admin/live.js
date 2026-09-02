import express from 'express';
import { getConnectedClients } from '../../services/omada.js';

export const liveRouter = express.Router();

// Same isolation as the Overview page: an Omada failure here shouldn't 500
// this page, it should just show an "unavailable" state.
async function safeGetConnectedClients() {
  const [result] = await Promise.allSettled([getConnectedClients()]);
  return result.status === 'fulfilled'
    ? result.value
    : { total: 0, clients: [], unavailable: true };
}

liveRouter.get('/', async (req, res) => {
  const data = await safeGetConnectedClients();
  res.render('admin/live', data);
});

liveRouter.get('/data', async (req, res) => {
  const data = await safeGetConnectedClients();
  res.json(data);
});
