import express from 'express';
import { db } from '../db/index.js';
import { getPackage } from '../packages.js';
import { pollPayment } from '../services/paynow.js';
import { createVoucher, markVoucherUsed } from '../services/vouchers.js';
import { authorizeClient } from '../services/omada.js';
import { config } from '../config.js';

export const payRouter = express.Router();

// Finalize a paid transaction: generate voucher + authorize the client on Omada.
async function finalizePaidTransaction(tx) {
  const pkg = getPackage(tx.package_id);

  // Generate voucher if not already done.
  let voucherCode = tx.voucher_code;
  if (!voucherCode) {
    const v = createVoucher({ packageId: pkg.id, minutes: pkg.minutes, transactionId: tx.id });
    voucherCode = v.code;
    db.prepare(`UPDATE transactions SET status='paid', voucher_code=?, updated_at=datetime('now') WHERE id=?`)
      .run(voucherCode, tx.id);
  }

  // Authorize the client on the Omada controller (grants internet).
  const clientInfo = {
    clientMac: tx.client_mac,
    apMac: tx.ap_mac,
    ssidName: tx.ssid,
    radioId: tx.radio_id,
    site: tx.site,
  };
  if (clientInfo.clientMac) {
    try {
      await authorizeClient(clientInfo, pkg.minutes);
      markVoucherUsed(voucherCode, pkg.minutes);
    } catch (err) {
      console.error('Omada authorize error:', err.message);
      // Voucher still valid; user can retry login page.
    }
  }
  return voucherCode;
}

// AJAX endpoint the "waiting" page polls every few seconds.
payRouter.get('/status/:reference', async (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE reference = ?').get(req.params.reference);
  if (!tx) return res.status(404).json({ status: 'not_found' });

  if (tx.status === 'paid' && tx.voucher_code) {
    return res.json({ status: 'paid', voucher: tx.voucher_code });
  }

  try {
    const result = await pollPayment(tx.poll_url);
    if (result.paid) {
      const voucher = await finalizePaidTransaction(tx);
      return res.json({ status: 'paid', voucher });
    }
    return res.json({ status: 'pending', paynowStatus: result.status });
  } catch (err) {
    console.error('poll error:', err.message);
    return res.json({ status: 'pending' });
  }
});

// Paynow server-to-server callback (result URL). Paynow POSTs status updates here.
payRouter.post('/callback', express.urlencoded({ extended: true }), async (req, res) => {
  const reference = req.body.reference;
  const tx = reference ? db.prepare('SELECT * FROM transactions WHERE reference = ?').get(reference) : null;
  if (tx && String(req.body.status || '').toLowerCase() === 'paid') {
    await finalizePaidTransaction(tx);
  }
  res.status(200).send('ok');
});

// Browser return URL (customer redirected back here after Paynow).
payRouter.get('/return', (req, res) => {
  res.redirect('/');
});
