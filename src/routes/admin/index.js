import express from 'express';
import { config } from '../../config.js';
import { safeCompare, adminConfigured, notConfigured, requireAdminAuth } from './auth.js';
import { overviewRouter } from './overview.js';

export const adminRouter = express.Router();

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

// Everything registered after this line requires a valid session.
adminRouter.use(requireAdminAuth);

adminRouter.use('/', overviewRouter);
