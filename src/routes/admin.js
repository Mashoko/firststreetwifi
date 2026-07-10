import crypto from 'crypto';
import express from 'express';
import { config } from '../config.js';
import { db } from '../db/index.js';

export const adminRouter = express.Router();

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function adminConfigured() {
  return Boolean(config.admin.user && config.admin.password);
}

function notConfigured(res) {
  return res.status(503).render('error', {
    message: 'Admin login is not configured. Set ADMIN_USER and ADMIN_PASSWORD in .env.',
  });
}

function requireAdminAuth(req, res, next) {
  if (!adminConfigured()) return notConfigured(res);
  if (req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

adminRouter.get('/login', (req, res) => {
  if (!adminConfigured()) return notConfigured(res);
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

adminRouter.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  if (!adminConfigured()) return notConfigured(res);
  const { username, password } = req.body;
  const validUser = safeCompare(username || '', config.admin.user);
  const validPass = safeCompare(password || '', config.admin.password);
  if (!validUser || !validPass) {
    return res.status(401).render('admin-login', { error: 'Invalid username or password.' });
  }
  req.session.isAdmin = true;
  res.redirect('/admin');
});

adminRouter.get('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

adminRouter.get('/', requireAdminAuth, (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                        AS total_tx,
      SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END)  AS paid_tx,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 0) AS revenue
    FROM transactions
  `).get();

  const byPackage = db.prepare(`
    SELECT package_id, COUNT(*) AS count, COALESCE(SUM(amount),0) AS revenue
    FROM transactions WHERE status='paid'
    GROUP BY package_id ORDER BY revenue DESC
  `).all();

  const recent = db.prepare(`
    SELECT reference, package_id, amount, phone, status, voucher_code, created_at
    FROM transactions ORDER BY id DESC LIMIT 25
  `).all();

  res.render('admin', { totals, byPackage, recent });
});
