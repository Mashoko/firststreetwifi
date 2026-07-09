# Admin Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a login before `/admin` (revenue/transaction reports) can be viewed.

**Architecture:** Session-based auth using the `express-session` middleware already mounted globally in `src/server.js`. A single admin account's credentials come from `.env` (`ADMIN_USER` / `ADMIN_PASSWORD`), compared with a constant-time check. On success, `req.session.isAdmin = true` gates the existing reports route.

**Tech Stack:** Node.js (ESM), Express, EJS, Node's built-in `crypto` module (`timingSafeEqual`). No new dependencies.

## Global Constraints

- Credentials are plaintext in `.env` (`ADMIN_USER` / `ADMIN_PASSWORD`), matching the existing pattern for `PAYNOW_INTEGRATION_KEY` etc. Never hash/encrypt them — that was explicitly decided against in the spec.
- If `ADMIN_USER` or `ADMIN_PASSWORD` is unset/empty, every admin route (`/admin`, `/admin/login`) must respond `503` with a message telling the operator to configure `.env` — fail closed, not fail open.
- No CSRF tokens on the login form — no other form in this app (`/buy`, `/login`) has them, so adding one only here would be inconsistent. Do not add CSRF protection as part of this work.
- No rate limiting / lockout / multi-admin support — out of scope (see spec `docs/superpowers/specs/2026-07-09-admin-auth-design.md`, Non-goals).
- This repo has no automated test framework (no test script in `package.json`, no test files anywhere). Verification in this plan is manual, via `npm start` + `curl`, matching the spec's own "Testing" section — do not introduce a test framework as part of this work.
- Dev server for manual verification must run on the port already configured in the local `.env` (`PORT=3100`, not the default 3000 — 3000 is occupied by an unrelated project on this machine). Use `http://localhost:3100` in all curl commands below.

---

### Task 1: Admin credentials config

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`
- Modify: `.env` (local only, already gitignored — not committed)

**Interfaces:**
- Produces: `config.admin.user` (string, `''` if unset), `config.admin.password` (string, `''` if unset) — consumed by Task 2's route handlers.

- [ ] **Step 1: Add the `admin` block to `config.js`**

Open `src/config.js`. The file currently ends with the `omada` block closing and the outer object closing:

```js
  omada: {
    type: (process.env.OMADA_CONTROLLER_TYPE || 'software').toLowerCase(),
    baseUrl: (process.env.OMADA_BASE_URL || '').replace(/\/+$/, ''),
    controllerId: process.env.OMADA_CONTROLLER_ID || '',
    site: process.env.OMADA_SITE || 'Default',
    operatorUser: process.env.OMADA_OPERATOR_USER || '',
    operatorPass: process.env.OMADA_OPERATOR_PASS || '',
    verifyTls: bool(process.env.OMADA_VERIFY_TLS, false),
  },
};
```

Replace the closing `  },\n};` with:

```js
  omada: {
    type: (process.env.OMADA_CONTROLLER_TYPE || 'software').toLowerCase(),
    baseUrl: (process.env.OMADA_BASE_URL || '').replace(/\/+$/, ''),
    controllerId: process.env.OMADA_CONTROLLER_ID || '',
    site: process.env.OMADA_SITE || 'Default',
    operatorUser: process.env.OMADA_OPERATOR_USER || '',
    operatorPass: process.env.OMADA_OPERATOR_PASS || '',
    verifyTls: bool(process.env.OMADA_VERIFY_TLS, false),
  },

  admin: {
    user: process.env.ADMIN_USER || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
};
```

- [ ] **Step 2: Add the vars to `.env.example`**

Append to the end of `.env.example`:

```
# ── Admin dashboard (/admin) ──
# Required to log in to the reports page. Leave unset to keep /admin disabled.
ADMIN_USER=admin
ADMIN_PASSWORD=change-this-password
```

- [ ] **Step 3: Add real test values to local `.env`**

Append the same two lines to `.env` (the local, gitignored file) with a test password:

```
ADMIN_USER=admin
ADMIN_PASSWORD=test-password-123
```

- [ ] **Step 4: Verify config loads correctly**

Run:
```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi" && node -e "import('./src/config.js').then(m => console.log(m.config.admin))"
```
Expected output: `{ user: 'admin', password: 'test-password-123' }`

- [ ] **Step 5: Commit**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi"
git add src/config.js .env.example
git commit -m "Add admin credential config"
```
(`.env` is gitignored and will not be staged — confirm with `git status` that it does not appear.)

---

### Task 2: Admin login route, middleware, and view

**Files:**
- Modify: `src/routes/admin.js`
- Create: `views/admin-login.ejs`
- Modify: `views/admin.ejs`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `config.admin.user`, `config.admin.password` (from Task 1).
- Produces: `req.session.isAdmin` (boolean) — the auth flag other code can check; no other task depends on this yet.

- [ ] **Step 1: Add the password input style**

In `public/style.css`, find this line (around line 84):
```css
input[type=text], input[type=tel], input[type=email], select {
```
Replace it with:
```css
input[type=text], input[type=tel], input[type=email], input[type=password], select {
```

- [ ] **Step 2: Create the login view**

Create `views/admin-login.ejs`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin login · First Street WiFi</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="mark">FS</div>
      <div><h1>First Street WiFi</h1><div class="sub">Admin login</div></div>
    </div>

    <div class="card">
      <% if (error) { %>
        <p class="lead msg-err"><%= error %></p>
      <% } %>
      <form method="POST" action="/admin/login">
        <label class="field">
          <span>Username</span>
          <input type="text" name="username" autocomplete="username" required>
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit" class="btn">Log in</button>
      </form>
    </div>
  </div>
</body>
</html>
```

- [ ] **Step 3: Add a logout link to the reports page**

In `views/admin.ejs`, find:
```html
    <div class="brand">
      <div class="mark">FS</div>
      <div><h1>First Street WiFi</h1><div class="sub">Reports &amp; analytics</div></div>
    </div>
```
Replace with:
```html
    <div class="brand">
      <div class="mark">FS</div>
      <div><h1>First Street WiFi</h1><div class="sub">Reports &amp; analytics</div></div>
    </div>

    <div style="text-align:right;margin-bottom:16px">
      <a href="/admin/logout" style="font-size:12px;color:var(--muted)">Log out</a>
    </div>
```

- [ ] **Step 4: Rewrite `src/routes/admin.js` with auth**

Replace the full contents of `src/routes/admin.js` with:

```js
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
```

- [ ] **Step 5: Start the dev server**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi" && (nohup npm start > /tmp/admin-auth-test.log 2>&1 &) && sleep 1.5 && cat /tmp/admin-auth-test.log
```
Expected: log shows `🌐 First Street WiFi running at http://localhost:3100` with no errors.

- [ ] **Step 6: Verify unauthenticated access redirects to login**

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3100/admin
```
Expected: `302 http://localhost:3100/admin/login` (or a relative `/admin/login` redirect target).

- [ ] **Step 7: Verify wrong credentials are rejected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3100/admin/login -d "username=admin&password=wrong"
```
Expected: `401`

- [ ] **Step 8: Verify correct credentials log in and reach the reports page**

```bash
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -w "%{http_code} %{redirect_url}\n" -X POST http://localhost:3100/admin/login -d "username=admin&password=test-password-123"
curl -s -b admin-cookies.txt http://localhost:3100/admin | grep -o "Reports &amp; analytics"
```
Expected: first command prints `302` with redirect to `/admin`; second command prints `Reports &amp; analytics`.

- [ ] **Step 9: Verify logout clears the session**

```bash
cd /tmp && curl -s -b admin-cookies.txt -c admin-cookies.txt -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3100/admin/logout
curl -s -b admin-cookies.txt -o /dev/null -w "%{http_code}\n" http://localhost:3100/admin
```
Expected: first command `302` to `/admin/login`; second command `302` (redirected again, not `200`).

- [ ] **Step 10: Verify fail-closed behavior when unconfigured**

Temporarily comment out the two `ADMIN_*` lines in `.env`, restart the server, and check:
```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi"
sed -i 's/^ADMIN_USER=/#ADMIN_USER=/; s/^ADMIN_PASSWORD=/#ADMIN_PASSWORD=/' .env
pkill -f "node src/server.js"; sleep 0.5
(nohup npm start > /tmp/admin-auth-test.log 2>&1 &) && sleep 1.5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/admin
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/admin/login
```
Expected: both print `503`.

Then restore `.env` and restart once more, confirming normal login still works:
```bash
sed -i 's/^#ADMIN_USER=/ADMIN_USER=/; s/^#ADMIN_PASSWORD=/ADMIN_PASSWORD=/' .env
pkill -f "node src/server.js"; sleep 0.5
(nohup npm start > /tmp/admin-auth-test.log 2>&1 &) && sleep 1.5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3100/admin
```
Expected: `302` (redirect to login, not `503`) — confirms `.env` restore worked.

- [ ] **Step 11: Stop the dev server**

```bash
pkill -f "node src/server.js"
```

- [ ] **Step 12: Commit**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi"
git add src/routes/admin.js views/admin-login.ejs views/admin.ejs public/style.css
git commit -m "Add admin login, session guard, and logout"
```

---

## Post-plan note

`README.md` currently lists "Add auth to `/admin` before deploying publicly (currently open)" under Notes / next steps. After this plan lands, update that line to describe the login instead (small follow-up, not included as a task here since it's a one-line doc edit the user can do directly, or ask for in a follow-up).
