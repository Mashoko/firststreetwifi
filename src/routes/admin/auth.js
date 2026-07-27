import crypto from 'crypto';
import { config } from '../../config.js';

export function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function adminConfigured() {
  return Boolean(config.admin.user && config.admin.password);
}

export function notConfigured(res) {
  return res.status(503).render('error', {
    message: 'Admin login is not configured. Set ADMIN_USER and ADMIN_PASSWORD in .env.',
  });
}

export function requireAdminAuth(req, res, next) {
  if (!adminConfigured()) return notConfigured(res);
  if (req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}
