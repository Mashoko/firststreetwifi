import express from 'express';
import { PACKAGES, getPackage } from '../packages.js';
import { db } from '../db/index.js';
import { parseClientInfo } from '../services/omada.js';
import { initMobilePayment } from '../services/paynow.js';

export const portalRouter = express.Router();

// Landing / captive-portal entry point.
// Omada redirects the client here with query params (clientMac, apMac, ssidName, radioId, site...)
portalRouter.get('/', (req, res) => {
  const clientInfo = parseClientInfo(req.query);
  // Stash client info in session so we can authorize after payment.
  req.session.clientInfo = clientInfo;
  res.render('portal', { packages: PACKAGES, clientInfo });
});

// Buy: create a transaction + initiate EcoCash/OneMoney payment.
portalRouter.post('/buy', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { packageId, phone, email, method } = req.body;
    const pkg = getPackage(packageId);
    if (!pkg) return res.status(400).render('error', { message: 'Invalid package selected.' });
    if (!phone) return res.status(400).render('error', { message: 'Phone number is required.' });

    const reference = 'FSW-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const ci = req.session.clientInfo || {};

    db.prepare(
      `INSERT INTO transactions
        (reference, package_id, amount, phone, email, method,
         client_mac, ap_mac, ssid, radio_id, site, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')`
    ).run(
      reference, pkg.id, pkg.price, phone, email || null, method || 'ecocash',
      ci.clientMac || null, ci.apMac || null, ci.ssidName || null,
      ci.radioId || null, ci.site || null
    );

    const pay = await initMobilePayment({
      reference,
      amount: pkg.price,
      itemName: `${pkg.name} — Africom Hotspot`,
      phone,
      email,
      method: method || 'ecocash',
    });

    if (!pay.success) {
      db.prepare(`UPDATE transactions SET status='failed', updated_at=datetime('now') WHERE reference=?`).run(reference);
      return res.status(502).render('error', { message: pay.error || 'Could not start payment.' });
    }

    db.prepare(
      `UPDATE transactions SET status='sent', poll_url=?, updated_at=datetime('now') WHERE reference=?`
    ).run(pay.pollUrl, reference);

    // Show the "waiting for payment" page which polls the status endpoint.
    res.render('waiting', {
      reference,
      instructions: pay.instructions,
      pkg,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong starting your payment.' });
  }
});
