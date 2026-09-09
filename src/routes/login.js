import express from 'express';
import { findVoucher, markVoucherUsed } from '../services/vouchers.js';
import { getPackage } from '../packages.js';
import { authorizeClient, parseClientInfo } from '../services/omada.js';

export const loginRouter = express.Router();

loginRouter.post('/', express.urlencoded({ extended: true }), async (req, res) => {
  const code = (req.body.voucher || '').trim().toUpperCase();
  const voucher = findVoucher(code);

  if (!voucher) {
    return res.status(400).render('error', { message: 'Voucher not found. Check the code and try again.' });
  }
  if (voucher.status === 'used' && voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
    return res.status(400).render('error', { message: 'This voucher has expired.' });
  }

  const pkg = getPackage(voucher.package_id);
  const clientInfo = req.session.clientInfo || parseClientInfo(req.query);

  if (!clientInfo.clientMac) {
    return res.status(400).render('error', {
      message: 'No device info found. Please reconnect to the WiFi and try again.',
    });
  }

  try {
    await authorizeClient(clientInfo, voucher.minutes, voucher.data_bytes);
    if (voucher.status === 'unused') markVoucherUsed(code, voucher.minutes);
    return res.render('success', { minutes: voucher.minutes, pkg });
  } catch (err) {
    console.error('login authorize error:', err.message);
    return res.status(502).render('error', { message: 'Could not connect you to the network. Please try again.' });
  }
});
