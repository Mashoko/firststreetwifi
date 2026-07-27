# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-table `/admin` page with a 5-page dark-glassmorphism analytics dashboard (Overview, Subscribers, Revenue, Vouchers, Live) built entirely on real data already in `transactions`/`vouchers` plus the existing `getConnectedClients()` Omada integration.

**Architecture:** Express + EJS + `better-sqlite3`, unchanged stack, no new frontend framework, no new charting library, no WebSocket/Redis. A new `src/services/analytics/` layer holds pure SQL query functions (one file per domain: subscribers, revenue, vouchers, overview). `src/routes/admin.js` is restructured into `src/routes/admin/` (one router file per page) behind the existing session-auth guard. Charts are hand-rolled SVG/HTML (`src/lib/charts.js`) styled with the dataviz skill's validated dark palette, with a small shared hover/tooltip script (`public/chart-tooltip.js`). The "live" feel on the Live page comes from client-side polling (`public/live-poll.js`) against a small JSON endpoint — no push infrastructure.

**Tech Stack:** Node.js (ESM), Express, EJS, `better-sqlite3`, vanilla CSS/JS. No new dependencies.

## Global Constraints

- No new npm dependencies — no charting library, no WebSocket library, no Redis client. Charts are hand-rolled SVG/HTML per `src/lib/charts.js` (Task 6).
- No schema changes/migrations. All analytics are derived from the existing `transactions` and `vouchers` tables (`src/db/index.js`).
- **Subscriber** = a distinct `phone` across `transactions` where `status='paid'`. **Active subscriber** = a phone with a voucher where `status='used' AND expires_at > datetime('now')`. **Voucher states** are computed at query time (not stored): `unused` as stored, `active` = `status='used' AND expires_at > datetime('now')`, `expired` = `status='used' AND expires_at <= datetime('now')` or explicit `status='expired'`. These exact definitions are load-bearing for every task below — do not redefine them per-task.
- Color palette is the dataviz skill's validated dark default, not invented: chart/card surface `#1a1a19`, page background `#0d0d0d`, primary ink `#ffffff`, secondary ink `#c3c2b7`, muted `#898781`, hairline border `rgba(255,255,255,0.10)`, status good `#0ca30c` / warning `#fab219` / serious `#ec835a` / critical `#d03b3b`, sequential/chart blue `#3987e5`. Use these exact values — do not substitute different hex values.
- Chart form is fixed per the spec: KPI numbers → stat tiles (not charts). Revenue/subscriber trends → single-series line, sequential blue, no legend. Package/revenue rankings → horizontal bar, sequential blue (not the 8-color categorical set — this is a magnitude comparison, not "distinct series"). Voucher lifecycle counts → a stat-tile row, not a pie/donut.
- This repo has no automated test framework (no test script in `package.json`, no test files anywhere) — verification throughout is manual: `node -e` for pure functions, `npm start` + `curl`/`grep` for routes and pages, matching `docs/superpowers/plans/2026-07-09-admin-auth.md`'s established convention. Do not introduce a test framework.
- Dev server for manual verification runs on the local `.env`'s `PORT` (check the worktree's `.env`; the original project's local `.env` used `PORT=3100` — if this worktree has no `.env`, `MOCK_MODE` still defaults to `true` per `src/config.js`, so `PORT` falls back to `3000`; use whichever the running server actually logs).
- Dark mode only — no light mode, no theme toggle behavior (the top-bar slot is visual only per the approved design, not functional).
- Existing `/admin/login`, `/admin/logout`, `requireAdminAuth`, and the constant-time credential check must keep their exact current behavior — only their file location changes (Task 7).
- `views/admin-login.ejs`, `public/style.css`, and every other customer-facing page (`portal.ejs`, `success.ejs`, `error.ejs`, `waiting.ejs`) are out of scope — do not restyle them. Only the authenticated dashboard pages get the new dark glass treatment.
- A seed script is created once (Task 2) at the project root as `seed-tmp.mjs`, used for manual verification across multiple later tasks, and **must never be committed** — each task that uses it must confirm `git status` doesn't show it staged, and it must exist on disk (do not delete it) until Task 12 is complete, since later tasks re-run it or rely on the data it seeded still being in `data.sqlite`. Re-running it is safe (it always inserts fresh `SEED-*` rows; it does not delete existing ones).

---

### Task 1: Date-range utility

**Files:**
- Create: `src/lib/dateRange.js`

**Interfaces:**
- Produces: `export function parseDateRange(query)` → `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', preset: 'today'|'7d'|'30d'|'90d' }`. Consumed by Tasks 8, 9, 10 (page routes). Not consumed by Tasks 2-4 (analytics functions take an already-computed `{from, to}` object, they don't call this themselves).

- [ ] **Step 1: Create `src/lib/dateRange.js`**

```js
const PRESET_DAYS = {
  today: 0,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Reads `range` (and, for a custom range, `from`/`to`) off a request query
 * object and returns a normalized { from, to, preset } — always valid
 * (unrecognized or incomplete input falls back to the last 30 days).
 */
export function parseDateRange(query) {
  const requested = query.range || '30d';

  if (requested === 'custom' && query.from && query.to) {
    return { from: query.from, to: query.to, preset: 'custom' };
  }

  const days = PRESET_DAYS[requested] ?? PRESET_DAYS['30d'];
  const preset = PRESET_DAYS[requested] !== undefined ? requested : '30d';

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);

  return { from: toIsoDate(from), to: toIsoDate(to), preset };
}
```

- [ ] **Step 2: Verify behavior for each preset and the fallback case**

```bash
cd "<worktree>" && node -e "
import('./src/lib/dateRange.js').then((m) => {
  console.log('today:', m.parseDateRange({ range: 'today' }));
  console.log('7d:', m.parseDateRange({ range: '7d' }));
  console.log('30d default:', m.parseDateRange({}));
  console.log('custom:', m.parseDateRange({ range: 'custom', from: '2026-01-01', to: '2026-01-31' }));
  console.log('bogus falls back:', m.parseDateRange({ range: 'nonsense' }));
});
"
```

Expected: `today` has `from === to` (today's date) and `preset: 'today'`; `7d`/`30d` show `from` 7/30 days before `to` with matching presets; the no-args call defaults to `preset: '30d'`; `custom` echoes the given dates with `preset: 'custom'`; the bogus-range call falls back to `preset: '30d'` with a valid 30-day window (not a crash, not `preset: 'nonsense'`).

- [ ] **Step 3: Commit**

```bash
cd "<worktree>"
git add src/lib/dateRange.js
git commit -m "Add date-range parsing utility for dashboard filters"
```

---

### Task 2: Subscriber analytics + shared seed data

**Files:**
- Create: `src/services/analytics/subscribers.js`
- Create (temporary, never committed): `seed-tmp.mjs` at the project root

**Interfaces:**
- Produces: `getSubscriberOverview()` → `{ total, active, newThisMonth, newLastMonth, growthPct }`. `getSubscriberGrowth({from, to})` → `Array<{ day: 'YYYY-MM-DD', newSubscribers: number }>`. `getNewestSubscribers(limit=10)` → `Array<{ phone, first_purchase, purchases, totalSpent }>`. `getTopSpenders(limit=10)` → `Array<{ phone, totalSpent, purchases }>`. `getLapsedCustomers(limit=10)` → `Array<{ phone, lastPurchase, daysSince }>`. All consumed by Task 4 (`overview.js`) and Task 8 (Subscribers page).
- Also produces (side effect, not a code interface): seeded rows in `data.sqlite` under references `SEED-0` through `SEED-5`, that Tasks 3, 4, 7, 8, 9, 10, 12 reuse for their own verification. Do not delete these rows or the seed script until Task 12 is complete.

- [ ] **Step 1: Create `src/services/analytics/subscribers.js`**

```js
import { db } from '../../db/index.js';

const PAID_PHONE_FILTER = `status='paid' AND phone IS NOT NULL AND phone != ''`;

export function getSubscriberOverview() {
  const total = db
    .prepare(`SELECT COUNT(DISTINCT phone) AS n FROM transactions WHERE ${PAID_PHONE_FILTER}`)
    .get().n;

  const active = db
    .prepare(
      `SELECT COUNT(DISTINCT t.phone) AS n
       FROM vouchers v
       JOIN transactions t ON t.id = v.transaction_id
       WHERE v.status='used' AND v.expires_at > datetime('now')
         AND t.phone IS NOT NULL AND t.phone != ''`
    )
    .get().n;

  const firstPurchasePerPhone = `
    SELECT phone, MIN(created_at) AS first_paid
    FROM transactions WHERE ${PAID_PHONE_FILTER}
    GROUP BY phone
  `;

  const newThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${firstPurchasePerPhone})
       WHERE strftime('%Y-%m', first_paid) = strftime('%Y-%m', 'now')`
    )
    .get().n;

  const newLastMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${firstPurchasePerPhone})
       WHERE strftime('%Y-%m', first_paid) = strftime('%Y-%m', 'now', '-1 month')`
    )
    .get().n;

  const growthPct =
    newLastMonth === 0 ? (newThisMonth > 0 ? 100 : 0) : ((newThisMonth - newLastMonth) / newLastMonth) * 100;

  return { total, active, newThisMonth, newLastMonth, growthPct };
}

export function getSubscriberGrowth({ from, to }) {
  return db
    .prepare(
      `SELECT day, COUNT(*) AS newSubscribers FROM (
         SELECT phone, date(MIN(created_at)) AS day
         FROM transactions WHERE ${PAID_PHONE_FILTER}
         GROUP BY phone
       )
       WHERE day BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getNewestSubscribers(limit = 10) {
  return db
    .prepare(
      `SELECT phone, MIN(created_at) AS first_purchase, COUNT(*) AS purchases, SUM(amount) AS totalSpent
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone ORDER BY first_purchase DESC LIMIT ?`
    )
    .all(limit);
}

export function getTopSpenders(limit = 10) {
  return db
    .prepare(
      `SELECT phone, SUM(amount) AS totalSpent, COUNT(*) AS purchases
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone ORDER BY totalSpent DESC LIMIT ?`
    )
    .all(limit);
}

export function getLapsedCustomers(limit = 10) {
  return db
    .prepare(
      `SELECT phone, MAX(created_at) AS lastPurchase,
              julianday('now') - julianday(MAX(created_at)) AS daysSince
       FROM transactions WHERE ${PAID_PHONE_FILTER}
       GROUP BY phone
       HAVING daysSince > 7
       ORDER BY lastPurchase DESC LIMIT ?`
    )
    .all(limit);
}
```

- [ ] **Step 2: Create the shared seed script `seed-tmp.mjs` at the project root**

```js
import { db, initSchema } from './src/db/index.js';

initSchema();

const now = Date.now();
const DAY = 86400000;
const MINUTES_BY_PACKAGE = { quick: 60, day: 1440, week: 10080, month: 43200 };

function iso(ts) {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

const insertTx = db.prepare(
  `INSERT INTO transactions (reference, package_id, amount, phone, method, status, voucher_code, created_at)
   VALUES (?, ?, ?, ?, 'ecocash', ?, ?, ?)`
);
const insertVoucher = db.prepare(
  `INSERT INTO vouchers (code, package_id, minutes, status, transaction_id, created_at, used_at, expires_at)
   VALUES (?, ?, ?, 'used', ?, ?, ?, ?)`
);

const samples = [
  { phone: '0771111111', pkg: 'day', amount: 2.0, daysAgo: 0, status: 'paid' },
  { phone: '0771111111', pkg: 'week', amount: 8.0, daysAgo: 10, status: 'paid' },
  { phone: '0772222222', pkg: 'quick', amount: 0.5, daysAgo: 1, status: 'paid' },
  { phone: '0773333333', pkg: 'month', amount: 25.0, daysAgo: 20, status: 'paid' },
  { phone: '0774444444', pkg: 'day', amount: 2.0, daysAgo: 5, status: 'paid' },
  { phone: '0775555555', pkg: 'day', amount: 2.0, daysAgo: 2, status: 'failed' },
];

samples.forEach((s, i) => {
  const reference = `SEED-${i}`;
  const createdAt = iso(now - s.daysAgo * DAY);
  const voucherCode = s.status === 'paid' ? `SEEDV${i}` : null;
  const info = insertTx.run(reference, s.pkg, s.amount, s.phone, s.status, voucherCode, createdAt);
  if (s.status === 'paid') {
    const minutes = MINUTES_BY_PACKAGE[s.pkg];
    const expiresAt = iso(now - s.daysAgo * DAY + minutes * 60000);
    insertVoucher.run(voucherCode, s.pkg, minutes, info.lastInsertRowid, createdAt, createdAt, expiresAt);
  }
});

console.log(`Seeded ${samples.length} transactions.`);
```

This gives **4 distinct paid phones** across 5 paid transactions (`0771111111` appears twice — 2 purchases 10 days apart, so it counts once as a subscriber but contributes 2 rows to `transactions`/`vouchers`), plus 1 failed transaction from a 5th phone, and a spread of `daysAgo` values (0, 1, 2, 5, 10, 20) so revenue/subscriber trend queries have real data across the last 30 days. Voucher expiry math naturally produces a mix of currently-active and already-expired vouchers (e.g. the `daysAgo: 0` day-pass is still active; the `daysAgo: 10` week-pass has expired).

- [ ] **Step 3: Run the seed script and verify it inserted correctly**

```bash
cd "<worktree>" && npm run init-db && node seed-tmp.mjs
node -e "
import('./src/db/index.js').then(({ db }) => {
  console.log(db.prepare('SELECT COUNT(*) AS n FROM transactions').get());
  console.log(db.prepare(\"SELECT COUNT(DISTINCT phone) AS n FROM transactions WHERE status='paid'\").get());
});
"
```

Expected: total transaction count `6`, distinct paid-phone count `4`.

- [ ] **Step 4: Verify `subscribers.js` against the seeded data**

```bash
cd "<worktree>" && node -e "
import('./src/services/analytics/subscribers.js').then((m) => {
  console.log('overview:', m.getSubscriberOverview());
  console.log('newest:', m.getNewestSubscribers());
  console.log('topSpenders:', m.getTopSpenders());
  console.log('lapsed:', m.getLapsedCustomers());
});
"
```

Expected: `overview.total === 4` (4 distinct paid phones — `0771111111` counts once despite its 2 purchases); `newest` lists 4 phones ordered by each phone's *first-ever* purchase date descending — `0772222222` (first purchase 1 day ago) on top, then `0774444444` (5 days ago), then `0771111111` (its first purchase was the *week*-pass 10 days ago, not today's day-pass — `MIN(created_at)` per phone), then `0773333333` (20 days ago) last; `topSpenders` ranks `0773333333` ($25, month pass) highest; `lapsed` includes only `0773333333` (its one and only purchase is 20 days old) — **not** `0771111111`, even though one of its two purchases is 10 days old, because the query's `HAVING` clause is driven by `MAX(created_at)` per phone (its most recent purchase was today).

- [ ] **Step 5: Confirm the seed script is not staged**

```bash
cd "<worktree>" && git status
```

Expected: `seed-tmp.mjs` and `data.sqlite*` do not appear as staged/trackable changes to commit (`data.sqlite*` is already gitignored; `seed-tmp.mjs` is untracked — leave it untracked, do not `git add` it).

- [ ] **Step 6: Commit only the analytics module**

```bash
cd "<worktree>"
git add src/services/analytics/subscribers.js
git commit -m "Add subscriber analytics queries"
```

---

### Task 3: Revenue analytics

**Files:**
- Create: `src/services/analytics/revenue.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent SQL module); reuses the seed data from Task 2 (already in `data.sqlite`, do not re-seed).
- Produces: `getRevenueOverview()` → `{ today, week, month, year, yesterday, changePct }`. `getRevenueTrend({from,to})` → `Array<{day, revenue}>`. `getRevenueByPackage({from,to,packageId})` → `Array<{package_id, count, revenue}>` (packageId optional — omit or pass `''`/`undefined` for no filter). `getTransactionOutcomes({from,to})` → `Array<{status, count}>`. `getRecentPayments({from,to,limit})` → `Array<{reference, package_id, amount, phone, status, voucher_code, created_at}>`. `getFailedTransactions({from,to,limit})` → `Array<{reference, package_id, amount, phone, status, created_at}>`. All consumed by Task 4 (`overview.js` uses `getRevenueOverview`, `getRevenueTrend`, `getRevenueByPackage`) and Task 9 (Revenue page, uses all six).

- [ ] **Step 1: Create `src/services/analytics/revenue.js`**

```js
import { db } from '../../db/index.js';

export function getRevenueOverview() {
  const sumWhere = (clause) =>
    db.prepare(`SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE status='paid' AND ${clause}`).get().n;

  const today = sumWhere(`date(created_at) = date('now')`);
  const yesterday = sumWhere(`date(created_at) = date('now','-1 day')`);
  const week = sumWhere(`date(created_at) >= date('now','-6 days')`);
  const month = sumWhere(`strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`);
  const year = sumWhere(`strftime('%Y', created_at) = strftime('%Y','now')`);

  const changePct = yesterday === 0 ? (today > 0 ? 100 : 0) : ((today - yesterday) / yesterday) * 100;

  return { today, week, month, year, yesterday, changePct };
}

export function getRevenueTrend({ from, to }) {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COALESCE(SUM(amount),0) AS revenue
       FROM transactions WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getRevenueByPackage({ from, to, packageId }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId] : [from, to];
  return db
    .prepare(
      `SELECT package_id, COUNT(*) AS count, COALESCE(SUM(amount),0) AS revenue
       FROM transactions
       WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?) ${clause}
       GROUP BY package_id ORDER BY revenue DESC`
    )
    .all(...params);
}

export function getTransactionOutcomes({ from, to }) {
  return db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM transactions WHERE date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY status`
    )
    .all(from, to);
}

export function getRecentPayments({ from, to, limit = 25 }) {
  return db
    .prepare(
      `SELECT reference, package_id, amount, phone, status, voucher_code, created_at
       FROM transactions WHERE status='paid' AND date(created_at) BETWEEN date(?) AND date(?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(from, to, limit);
}

export function getFailedTransactions({ from, to, limit = 25 }) {
  return db
    .prepare(
      `SELECT reference, package_id, amount, phone, status, created_at
       FROM transactions WHERE status IN ('failed','cancelled') AND date(created_at) BETWEEN date(?) AND date(?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(from, to, limit);
}
```

- [ ] **Step 2: Verify against the seeded data (do not re-run `seed-tmp.mjs` — Task 2's data is already in `data.sqlite`)**

```bash
cd "<worktree>" && node -e "
import('./src/services/analytics/revenue.js').then((m) => {
  console.log('overview:', m.getRevenueOverview());
  console.log('trend:', m.getRevenueTrend({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('byPackage:', m.getRevenueByPackage({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('outcomes:', m.getTransactionOutcomes({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('recent:', m.getRecentPayments({ from: '2026-06-01', to: '2026-12-31', limit: 25 }));
  console.log('failed:', m.getFailedTransactions({ from: '2026-06-01', to: '2026-12-31', limit: 25 }));
});
"
```

(Use a wide `from`/`to` window covering whenever the seed actually ran — check today's date if the 20-day-ago seed row falls outside a narrower range.)

Expected: `overview.today` equals the day-pass amount ($2.00, from the `daysAgo: 0` seed row); `outcomes` includes one `{status: 'paid', count: 5}` and one `{status: 'failed', count: 1}`; `failed` lists exactly the one `0775555555` row; `recent` lists 5 paid rows, newest first.

- [ ] **Step 3: Commit**

```bash
cd "<worktree>"
git add src/services/analytics/revenue.js
git commit -m "Add revenue analytics queries"
```

---

### Task 4: Voucher analytics + Overview aggregation

**Files:**
- Create: `src/services/analytics/vouchers.js`
- Create: `src/services/analytics/overview.js`

**Interfaces:**
- Consumes: `getSubscriberOverview` (Task 2), `getRevenueOverview`, `getRevenueTrend`, `getRevenueByPackage` (Task 3), `getConnectedClients` from `src/services/omada.js` (already built, returns `Promise<{total, clients}>`).
- Produces: from `vouchers.js` — `getVoucherLifecycleCounts({from,to})` → `{sold, unused, active, expired}`; `getVoucherSalesTrend({from,to})` → `Array<{day, count}>`; `getPackagePopularity({from,to,packageId})` → `Array<{package_id, count}>`; `getLatestVouchers({from,to,packageId,limit})` → `Array<{code, package_id, minutes, status, expires_at, created_at, used_at}>`. From `overview.js` — `export async function getOverviewData()` → `Promise<{subscribers, revenue, vouchersToday, live, revenueTrend, topPackages}>`, consumed by Task 7 (Overview page route). `vouchers.js`'s exports are also consumed directly by Task 10 (Vouchers page) and Task 12 (CSV export).

- [ ] **Step 1: Create `src/services/analytics/vouchers.js`**

```js
import { db } from '../../db/index.js';

export function getVoucherLifecycleCounts({ from, to }) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sold,
         SUM(CASE WHEN status='unused' THEN 1 ELSE 0 END) AS unused,
         SUM(CASE WHEN status='used' AND expires_at > datetime('now') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status='expired' OR (status='used' AND expires_at <= datetime('now')) THEN 1 ELSE 0 END) AS expired
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?)`
    )
    .get(from, to);

  return {
    sold: row.sold || 0,
    unused: row.unused || 0,
    active: row.active || 0,
    expired: row.expired || 0,
  };
}

export function getVoucherSalesTrend({ from, to }) {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?)
       GROUP BY day ORDER BY day`
    )
    .all(from, to);
}

export function getPackagePopularity({ from, to, packageId }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId] : [from, to];
  return db
    .prepare(
      `SELECT package_id, COUNT(*) AS count
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?) ${clause}
       GROUP BY package_id ORDER BY count DESC`
    )
    .all(...params);
}

export function getLatestVouchers({ from, to, packageId, limit = 25 }) {
  const clause = packageId ? 'AND package_id = ?' : '';
  const params = packageId ? [from, to, packageId, limit] : [from, to, limit];
  return db
    .prepare(
      `SELECT code, package_id, minutes, status, expires_at, created_at, used_at
       FROM vouchers WHERE date(created_at) BETWEEN date(?) AND date(?) ${clause}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params);
}
```

- [ ] **Step 2: Create `src/services/analytics/overview.js`**

```js
import { getSubscriberOverview } from './subscribers.js';
import { getRevenueOverview, getRevenueTrend, getRevenueByPackage } from './revenue.js';
import { getVoucherLifecycleCounts } from './vouchers.js';
import { getConnectedClients } from '../omada.js';

export async function getOverviewData() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

  const [subscribers, revenue, vouchersLifecycleToday, live, revenueTrend, topPackages] = await Promise.all([
    Promise.resolve(getSubscriberOverview()),
    Promise.resolve(getRevenueOverview()),
    Promise.resolve(getVoucherLifecycleCounts({ from: today, to: today })),
    getConnectedClients(),
    Promise.resolve(getRevenueTrend({ from, to: today })),
    Promise.resolve(getRevenueByPackage({ from, to: today })),
  ]);

  return {
    subscribers,
    revenue,
    vouchersToday: vouchersLifecycleToday.sold,
    live,
    revenueTrend,
    topPackages,
  };
}
```

- [ ] **Step 3: Verify `vouchers.js` against the seeded data**

```bash
cd "<worktree>" && node -e "
import('./src/services/analytics/vouchers.js').then((m) => {
  console.log('lifecycle:', m.getVoucherLifecycleCounts({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('trend:', m.getVoucherSalesTrend({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('popularity:', m.getPackagePopularity({ from: '2026-06-01', to: '2026-12-31' }));
  console.log('latest:', m.getLatestVouchers({ from: '2026-06-01', to: '2026-12-31', limit: 25 }));
});
"
```

Expected: `lifecycle.sold === 5` (one voucher per paid transaction); `lifecycle.active + lifecycle.expired === 5` (all 5 seeded vouchers are marked `used`, split between currently-active and already-expired depending on each one's `daysAgo` + package duration — see Task 2 Step 2's note); `latest` lists 5 rows.

- [ ] **Step 4: Verify `overview.js` end-to-end (exercises mock-mode `getConnectedClients()` too)**

```bash
cd "<worktree>" && node -e "
import('./src/services/analytics/overview.js').then(async (m) => {
  console.log(JSON.stringify(await m.getOverviewData(), null, 2));
});
"
```

Expected: a single object with all six keys populated; `live.total === 3` and `live.clients` has 3 entries (the mock fixture from the earlier Omada work — `MOCK_MODE` defaults to `true`); `revenueTrend` and `topPackages` reflect the seeded transactions.

- [ ] **Step 5: Commit**

```bash
cd "<worktree>"
git add src/services/analytics/vouchers.js src/services/analytics/overview.js
git commit -m "Add voucher analytics queries and overview aggregation"
```

---

### Task 5: Visual shell — dashboard CSS and layout partials

**Files:**
- Create: `public/dashboard.css`
- Create: `views/partials/admin-head.ejs`
- Create: `views/partials/admin-foot.ejs`

**Interfaces:**
- Produces: the CSS classes `.glass-card`, `.kpi-row`, `.kpi-tile`, `.chart-row`, `.chart-card`, `.dash-table`, `.filter-row`, `.chart-tooltip`, `.bar-row`/`.bar-label`/`.bar-track`/`.bar-fill`/`.bar-value` (the last five used by Task 6's `horizontalBarChart`), and the CSS custom properties listed in this plan's Global Constraints. Produces the `admin-head`/`admin-foot` EJS partials, taking locals `{ activePage: 'overview'|'subscribers'|'revenue'|'vouchers'|'live', title: string }`, consumed by every page view in Tasks 7-11.
- Does **not** yet add the `chart-tooltip.js`/`live-poll.js` `<script>` tags — those files don't exist until Tasks 6 and 11. Task 6 edits `admin-foot.ejs` to add its script tag; Task 11 edits it again for its own.

- [ ] **Step 1: Create `public/dashboard.css`**

```css
:root {
  --bg-page: #0d0d0d;
  --bg-surface: #1a1a19;
  --ink-primary: #ffffff;
  --ink-secondary: #c3c2b7;
  --ink-muted: #898781;
  --border-hairline: rgba(255, 255, 255, 0.10);
  --glass-bg: rgba(255, 255, 255, 0.045);
  --glass-border: rgba(255, 255, 255, 0.08);
  --status-good: #0ca30c;
  --status-warning: #fab219;
  --status-serious: #ec835a;
  --status-critical: #d03b3b;
  --chart-blue: #3987e5;
}

body.dashboard {
  margin: 0;
  font-family: 'Inter', system-ui, -apple-system, "Segoe UI", sans-serif;
  background: radial-gradient(circle at 30% 0%, #111827 0%, transparent 55%), var(--bg-page);
  color: var(--ink-primary);
  min-height: 100vh;
}

.dash-layout { display: flex; min-height: 100vh; }

.dash-sidebar {
  width: 200px;
  flex-shrink: 0;
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  border-right: 1px solid var(--border-hairline);
  padding: 20px 14px;
}
.dash-sidebar .brand { font-weight: 700; margin-bottom: 24px; font-size: 15px; }
.dash-sidebar nav a {
  display: block;
  color: var(--ink-secondary);
  text-decoration: none;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 13px;
  margin-bottom: 4px;
}
.dash-sidebar nav a.active { background: rgba(255, 255, 255, 0.06); color: var(--ink-primary); }
.dash-sidebar nav a:hover { background: rgba(255, 255, 255, 0.04); }

.dash-main { flex: 1; padding: 20px 24px; min-width: 0; }

.dash-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--glass-bg);
  border: 1px solid var(--border-hairline);
  border-radius: 20px;
  padding: 10px 16px;
  margin-bottom: 16px;
  font-size: 12px;
  color: var(--ink-secondary);
}
.dash-topbar a { color: var(--ink-secondary); text-decoration: none; }

.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  padding: 16px;
}

.kpi-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.kpi-tile { flex: 1; min-width: 160px; }
.kpi-tile .label { font-size: 10px; letter-spacing: 0.05em; color: var(--ink-muted); text-transform: uppercase; }
.kpi-tile .value { font-size: 26px; font-weight: 700; margin: 6px 0; font-variant-numeric: tabular-nums; }
.kpi-tile .delta { font-size: 12px; }
.kpi-tile .delta.up { color: var(--status-good); }
.kpi-tile .delta.down { color: var(--status-critical); }
.kpi-tile .delta.neutral { color: var(--ink-secondary); }

.chart-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.chart-card { flex: 1; min-width: 280px; }
.chart-card h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ink-muted);
  margin: 0 0 10px;
  font-weight: 600;
}

.dash-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dash-table th {
  text-align: left;
  color: var(--ink-muted);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-hairline);
}
.dash-table td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-variant-numeric: tabular-nums;
}
.dash-table tbody tr:hover { background: rgba(255, 255, 255, 0.02); }

.filter-row { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
.filter-row a, .filter-row select {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  color: var(--ink-secondary);
  border-radius: 10px;
  padding: 6px 12px;
  font-size: 12px;
  text-decoration: none;
}
.filter-row a.active { color: var(--ink-primary); border-color: rgba(255, 255, 255, 0.24); }

.chart-tooltip {
  position: fixed;
  background: #0d0d0d;
  border: 1px solid var(--border-hairline);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 12px;
  pointer-events: none;
  display: none;
  z-index: 10;
  white-space: nowrap;
}
.chart-tooltip .tt-value { font-weight: 700; color: var(--ink-primary); }
.chart-tooltip .tt-label { color: var(--ink-muted); font-size: 11px; }

.bar-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.bar-label {
  width: 110px;
  font-size: 12px;
  color: var(--ink-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-track { flex: 1; height: 10px; background: rgba(255, 255, 255, 0.06); border-radius: 6px; overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--chart-blue); border-radius: 6px; }
.bar-row:hover .bar-fill, .bar-row:focus .bar-fill { background: #5598e7; outline: none; }
.bar-value { width: 60px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 2: Create `views/partials/admin-head.ejs`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><%= title %> · First Street WiFi</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body class="dashboard">
  <div class="dash-layout">
    <aside class="dash-sidebar">
      <div class="brand">FS · First Street WiFi</div>
      <nav>
        <a href="/admin" class="<%= activePage === 'overview' ? 'active' : '' %>">Overview</a>
        <a href="/admin/subscribers" class="<%= activePage === 'subscribers' ? 'active' : '' %>">Subscribers</a>
        <a href="/admin/revenue" class="<%= activePage === 'revenue' ? 'active' : '' %>">Revenue</a>
        <a href="/admin/vouchers" class="<%= activePage === 'vouchers' ? 'active' : '' %>">Vouchers</a>
        <a href="/admin/live" class="<%= activePage === 'live' ? 'active' : '' %>">Live</a>
      </nav>
    </aside>
    <main class="dash-main">
      <div class="dash-topbar">
        <span><%= title %></span>
        <span><a href="/admin/logout">Log out</a></span>
      </div>
```

- [ ] **Step 3: Create `views/partials/admin-foot.ejs`**

```html
    </main>
  </div>
</body>
</html>
```

- [ ] **Step 4: Verify the partials render without error using a throwaway EJS call**

```bash
cd "<worktree>" && node -e "
import ejs from 'ejs';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(__dirname, 'views');
const head = ejs.render(
  \"<%- include('partials/admin-head', { activePage: 'subscribers', title: 'Subscribers' }) %>Hello<%- include('partials/admin-foot') %>\",
  {},
  { views: [viewsDir] }
);
console.log(head.includes('class=\"active\"') ? 'PASS: active class present' : 'FAIL: no active class');
console.log(head.includes('Subscribers · First Street WiFi') ? 'PASS: title present' : 'FAIL: title missing');
console.log(head.includes('Hello') ? 'PASS: body content present' : 'FAIL: body missing');
"
```

Expected: three `PASS` lines.

- [ ] **Step 5: Commit**

```bash
cd "<worktree>"
git add public/dashboard.css views/partials/admin-head.ejs views/partials/admin-foot.ejs
git commit -m "Add dashboard visual shell (dark glassmorphism CSS + layout partials)"
```

---

### Task 6: Chart rendering helper and hover/tooltip script

**Files:**
- Create: `src/lib/charts.js`
- Create: `public/chart-tooltip.js`
- Modify: `views/partials/admin-foot.ejs`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: the `.chart-tooltip`, `.bar-row`/`.bar-label`/`.bar-track`/`.bar-fill`/`.bar-value` CSS classes from Task 5.
- Produces: `export function lineChart(points, opts)` where `points: Array<{label, value, displayValue?}>`, returns an SVG markup string. `export function horizontalBarChart(items)` where `items: Array<{label, value, displayValue?}>`, returns an HTML markup string. `export function sparkline(values, opts)` where `values: Array<number>`, returns a small SVG markup string (no axes, no interaction — used inline in KPI tiles only if a task chooses to; none of Tasks 7-10 currently use it, it exists per the spec's "stat tile" definition for future use). Both `lineChart` and `horizontalBarChart` are registered as Express `app.locals` in `src/server.js`, so every EJS template can call them directly (e.g. `<%- lineChart(...) %>`) without each route importing and passing them manually. Consumed by Tasks 7, 8, 9, 10.

- [ ] **Step 1: Create `src/lib/charts.js`**

```js
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

/**
 * Single-series line chart. Renders as inline SVG with a hit-rect and a
 * hidden crosshair line that public/chart-tooltip.js drives on pointer move.
 */
export function lineChart(points, { width = 560, height = 160, padding = 10, color = '#3987e5' } = {}) {
  if (!points.length) {
    return `<div style="color:var(--ink-muted);font-size:12px">No data for this range.</div>`;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: padding + step * i,
    y: padding + innerHeight - ((p.value - min) / range) * innerHeight,
    label: p.label,
    value: p.value,
    displayValue: p.displayValue ?? p.value,
  }));

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];
  const dataForJs = JSON.stringify(coords.map((c) => ({ x: c.x, label: c.label, displayValue: c.displayValue })));

  return `
<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" data-points='${escapeAttr(dataForJs)}'>
  <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border-hairline)" stroke-width="1" />
  <polyline points="${polylinePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="${color}" />
  <line class="chart-crosshair" x1="0" y1="${padding}" x2="0" y2="${height - padding}" stroke="rgba(255,255,255,0.2)" style="display:none" />
  <rect class="chart-hitrect" x="0" y="0" width="${width}" height="${height}" fill="transparent" />
</svg>`;
}

/**
 * Horizontal bar ranking, plain HTML/CSS (not SVG) — each row is its own
 * hover/focus target for the shared tooltip script.
 */
export function horizontalBarChart(items) {
  if (!items.length) {
    return `<div style="color:var(--ink-muted);font-size:12px">No data for this range.</div>`;
  }

  const max = Math.max(...items.map((i) => i.value), 1);

  return items
    .map((item) => {
      const pct = Math.max(Math.round((item.value / max) * 100), 2);
      const display = item.displayValue ?? item.value;
      return `<div class="bar-row" tabindex="0" data-tt-value="${escapeAttr(display)}" data-tt-label="${escapeAttr(item.label)}">
  <span class="bar-label">${escapeHtml(item.label)}</span>
  <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
  <span class="bar-value">${escapeHtml(String(display))}</span>
</div>`;
    })
    .join('\n');
}

/** Small single-series sparkline — no axes, no interaction. */
export function sparkline(values, { width = 100, height = 30, color = '#3987e5' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" /></svg>`;
}
```

- [ ] **Step 2: Create `public/chart-tooltip.js`**

```js
(function () {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  document.body.appendChild(tooltip);

  function showTooltip(clientX, clientY, label, value) {
    tooltip.textContent = '';
    const valueEl = document.createElement('div');
    valueEl.className = 'tt-value';
    valueEl.textContent = value;
    const labelEl = document.createElement('div');
    labelEl.className = 'tt-label';
    labelEl.textContent = label;
    tooltip.appendChild(valueEl);
    tooltip.appendChild(labelEl);
    tooltip.style.display = 'block';
    tooltip.style.left = clientX + 14 + 'px';
    tooltip.style.top = clientY + 14 + 'px';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  // Line charts: crosshair + nearest-point tooltip driven by pointer position.
  document.querySelectorAll('.chart-svg[data-points]').forEach((svg) => {
    const points = JSON.parse(svg.getAttribute('data-points'));
    const crosshair = svg.querySelector('.chart-crosshair');
    const hitrect = svg.querySelector('.chart-hitrect');
    const viewBox = svg.viewBox.baseVal;

    function nearestPoint(localX, renderedWidth) {
      const scale = viewBox.width / renderedWidth;
      const x = localX * scale;
      let closest = points[0];
      let minDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p.x - x);
        if (d < minDist) {
          minDist = d;
          closest = p;
        }
      }
      return closest;
    }

    function onMove(e) {
      const rect = svg.getBoundingClientRect();
      const point = nearestPoint(e.clientX - rect.left, rect.width);
      if (crosshair) {
        crosshair.style.display = 'block';
        crosshair.setAttribute('x1', point.x);
        crosshair.setAttribute('x2', point.x);
      }
      showTooltip(e.clientX, e.clientY, point.label, point.displayValue);
    }

    function onLeave() {
      if (crosshair) crosshair.style.display = 'none';
      hideTooltip();
    }

    hitrect.addEventListener('pointermove', onMove);
    hitrect.addEventListener('pointerleave', onLeave);
  });

  // Bar charts: each row is its own hit target.
  document.querySelectorAll('[data-tt-value]').forEach((el) => {
    function onShow(e) {
      const rect = el.getBoundingClientRect();
      const clientX = e.clientX ?? rect.left;
      const clientY = e.clientY ?? rect.top;
      showTooltip(clientX, clientY, el.getAttribute('data-tt-label') || '', el.getAttribute('data-tt-value') || '');
    }
    el.addEventListener('pointerenter', onShow);
    el.addEventListener('pointermove', onShow);
    el.addEventListener('pointerleave', hideTooltip);
    el.addEventListener('focus', onShow);
    el.addEventListener('blur', hideTooltip);
  });
})();
```

- [ ] **Step 3: Add the script tag to `views/partials/admin-foot.ejs`**

Replace the full contents of `views/partials/admin-foot.ejs` with:

```html
    </main>
  </div>
  <script src="/chart-tooltip.js" defer></script>
</body>
</html>
```

- [ ] **Step 4: Wire the chart helpers into `src/server.js`**

Open `src/server.js`. Add the import near the other imports (after `import { adminRouter } from './routes/admin.js';` — note this import line will itself change in Task 7; add the new import below it as it exists right now):

```js
import { adminRouter } from './routes/admin.js';
import { lineChart, horizontalBarChart, sparkline } from './lib/charts.js';
```

Then, after the line `const app = express();`, add:

```js
const app = express();
app.locals.lineChart = lineChart;
app.locals.horizontalBarChart = horizontalBarChart;
app.locals.sparkline = sparkline;
```

- [ ] **Step 5: Verify the chart functions produce valid markup**

```bash
cd "<worktree>" && node -e "
import('./src/lib/charts.js').then((m) => {
  const line = m.lineChart([{ label: '2026-07-01', value: 10 }, { label: '2026-07-02', value: 25 }]);
  console.log(line.includes('<svg') && line.includes('polyline') ? 'PASS: lineChart renders svg+polyline' : 'FAIL');
  console.log(line.includes('data-points') ? 'PASS: lineChart exposes data-points for tooltip.js' : 'FAIL');

  const bars = m.horizontalBarChart([{ label: 'Day Pass', value: 40 }, { label: 'Week Pass', value: 10 }]);
  console.log(bars.includes('bar-row') && bars.includes('Day Pass') ? 'PASS: horizontalBarChart renders rows' : 'FAIL');

  const empty = m.lineChart([]);
  console.log(empty.includes('No data') ? 'PASS: empty line chart handled' : 'FAIL');

  const xss = m.horizontalBarChart([{ label: '<script>alert(1)</script>', value: 1 }]);
  console.log(!xss.includes('<script>alert') ? 'PASS: label HTML-escaped' : 'FAIL: unescaped label');
});
"
```

Expected: all `PASS` lines.

- [ ] **Step 6: Start the dev server and confirm `app.locals` wiring doesn't crash the app**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
```

Expected: the usual `🌐 First Street WiFi running at ...` startup log, no stack trace. Stop it afterward: `pkill -f "node src/server.js"`.

- [ ] **Step 7: Commit**

```bash
cd "<worktree>"
git add src/lib/charts.js public/chart-tooltip.js views/partials/admin-foot.ejs src/server.js
git commit -m "Add hand-rolled chart rendering (line, bar, sparkline) and hover tooltip"
```

---

### Task 7: Restructure admin routes and build the Overview page

**Files:**
- Create: `src/routes/admin/auth.js`
- Create: `src/routes/admin/index.js`
- Create: `src/routes/admin/overview.js`
- Create: `views/admin/overview.ejs`
- Delete: `src/routes/admin.js`
- Delete: `views/admin.ejs`
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `getOverviewData()` (Task 4), `admin-head`/`admin-foot` partials (Task 5), `lineChart`/`horizontalBarChart` via `app.locals` (Task 6).
- Produces: `export const adminRouter` (same export name as the old `src/routes/admin.js`, now from `src/routes/admin/index.js`) — `src/server.js`'s import path changes accordingly. `export function requireAdminAuth` from `src/routes/admin/auth.js`, consumed by Tasks 8-11's page routers (each mounted under `adminRouter`, which applies `requireAdminAuth` once via router-level middleware — individual page routers do **not** need to re-apply it).

- [ ] **Step 1: Create `src/routes/admin/auth.js`**

```js
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
```

This is a straight extraction of the existing functions from the current `src/routes/admin.js` (lines 8-28) — behavior is unchanged, only the file location.

- [ ] **Step 2: Create `src/routes/admin/index.js`**

```js
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
```

Note: `/subscribers`, `/revenue`, `/vouchers`, `/live` sub-routers are added by Tasks 8-11 — each of those tasks adds one `adminRouter.use('/<page>', <page>Router);` line and one import line to this file. This task only wires `overviewRouter`.

- [ ] **Step 3: Create `src/routes/admin/overview.js`**

```js
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
```

- [ ] **Step 4: Create `views/admin/overview.ejs`**

```html
<%- include('../partials/admin-head', { activePage: 'overview', title: 'Overview' }) %>

<div class="kpi-row">
  <div class="glass-card kpi-tile">
    <div class="label">Total Subscribers</div>
    <div class="value"><%= subscribers.total %></div>
    <div class="delta <%= subscribers.growthPct >= 0 ? 'up' : 'down' %>">
      <%= subscribers.growthPct >= 0 ? '▲' : '▼' %> <%= Math.abs(subscribers.growthPct).toFixed(1) %>% this month
    </div>
  </div>
  <div class="glass-card kpi-tile">
    <div class="label">Today's Revenue</div>
    <div class="value">$<%= Number(revenue.today).toFixed(2) %></div>
    <div class="delta <%= revenue.changePct >= 0 ? 'up' : 'down' %>">
      <%= revenue.changePct >= 0 ? '▲' : '▼' %> <%= Math.abs(revenue.changePct).toFixed(1) %>% vs yesterday
    </div>
  </div>
  <div class="glass-card kpi-tile">
    <div class="label">Live Now</div>
    <div class="value"><%= live.total %></div>
    <div class="delta neutral">● connected</div>
  </div>
  <div class="glass-card kpi-tile">
    <div class="label">Vouchers Today</div>
    <div class="value"><%= vouchersToday %></div>
    <div class="delta neutral">sold today</div>
  </div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card" style="flex:2">
    <h3>Revenue — Last 30 Days</h3>
    <%- lineChart(revenueTrend.map(function(r) { return { label: r.day, value: r.revenue, displayValue: '$' + Number(r.revenue).toFixed(2) }; })) %>
  </div>
  <div class="glass-card chart-card">
    <h3>Top Package</h3>
    <%- horizontalBarChart(topPackages.map(function(p) { return { label: p.package_id, value: p.revenue, displayValue: '$' + Number(p.revenue).toFixed(2) }; })) %>
  </div>
</div>

<div class="glass-card">
  <h3>Live Connected Users</h3>
  <table class="dash-table">
    <thead><tr><th>Device</th><th>IP</th><th>SSID</th><th>Connected</th></tr></thead>
    <tbody>
      <% live.clients.slice(0, 5).forEach(function(c) { %>
        <tr><td><%= c.name %></td><td><%= c.ip %></td><td><%= c.ssid %></td><td><%= c.connectedAt %></td></tr>
      <% }); %>
      <% if (live.clients.length === 0) { %><tr><td colspan="4" style="color:var(--ink-muted)">No one connected right now.</td></tr><% } %>
    </tbody>
  </table>
  <p style="margin-top:10px"><a href="/admin/live" style="color:var(--ink-secondary);font-size:12px">See all connected users →</a></p>
</div>

<%- include('../partials/admin-foot') %>
```

- [ ] **Step 5: Delete the old flat route file and view**

```bash
cd "<worktree>"
git rm src/routes/admin.js views/admin.ejs
```

- [ ] **Step 6: Update `src/server.js`'s import**

Find this line (added in Task 6, Step 4):

```js
import { adminRouter } from './routes/admin.js';
import { lineChart, horizontalBarChart, sparkline } from './lib/charts.js';
```

Replace with:

```js
import { adminRouter } from './routes/admin/index.js';
import { lineChart, horizontalBarChart, sparkline } from './lib/charts.js';
```

- [ ] **Step 7: Start the dev server and verify the full login → overview flow**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
```

Expected: normal startup log, no crash (this exercises the new `admin/index.js` and `overview.js` wiring end-to-end).

Set admin credentials if this worktree's `.env` doesn't already have them (check first with `grep ADMIN_USER .env`), then log in and hit the Overview page. Use whatever `PORT` the startup log printed (substitute below):

```bash
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -w "%{http_code} %{redirect_url}\n" -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt http://localhost:<PORT>/admin > overview.html
grep -o 'Total Subscribers' overview.html
grep -o '<div class="value">4</div>' overview.html
grep -o 'Live Connected Users' overview.html
```

Expected: login `302` to `/admin`; the Overview page HTML contains "Total Subscribers", a KPI tile showing `4` (the seeded distinct-paid-phone count from Task 2 — see Task 2's corrected note: `0771111111` has 2 purchases but counts once), and "Live Connected Users". Also confirm logged-out access still redirects: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:<PORT>/admin` (no cookie) → `302` to `/admin/login`.

Stop the server afterward: `pkill -f "node src/server.js"`.

- [ ] **Step 8: Commit**

```bash
cd "<worktree>"
git add src/routes/admin/auth.js src/routes/admin/index.js src/routes/admin/overview.js views/admin/overview.ejs src/server.js
git commit -m "Restructure admin routes into src/routes/admin/ and add the Overview dashboard page"
```

(The `git rm` from Step 5 is already staged from that command — it will be included in this same commit.)

---

### Task 8: Subscribers page

**Files:**
- Create: `src/routes/admin/subscribers.js`
- Create: `views/admin/subscribers.ejs`
- Create: `views/partials/filter-row.ejs`
- Modify: `src/routes/admin/index.js`

**Interfaces:**
- Consumes: `parseDateRange` (Task 1), `getSubscriberOverview`/`getSubscriberGrowth`/`getNewestSubscribers`/`getTopSpenders`/`getLapsedCustomers` (Task 2), `lineChart` via `app.locals` (Task 6), `admin-head`/`admin-foot` (Task 5).
- Produces: `views/partials/filter-row.ejs`, taking locals `{ basePath, range, packageId, showPackageFilter, packages }` — consumed by Tasks 9 and 10 as well (do not redefine it there).

- [ ] **Step 1: Create `views/partials/filter-row.ejs`**

```html
<div class="filter-row">
  <% ['today','7d','30d','90d'].forEach(function(r) { %>
    <a href="<%= basePath %>?range=<%= r %><%= packageId ? '&package=' + packageId : '' %>" class="<%= range === r ? 'active' : '' %>">
      <%= ({ today: 'Today', '7d': '7 Days', '30d': '30 Days', '90d': '90 Days' })[r] %>
    </a>
  <% }); %>
  <% if (showPackageFilter) { %>
    <form method="GET" action="<%= basePath %>" style="display:inline">
      <input type="hidden" name="range" value="<%= range %>">
      <select name="package" onchange="this.form.submit()">
        <option value="">All packages</option>
        <% packages.forEach(function(p) { %>
          <option value="<%= p %>" <%= packageId === p ? 'selected' : '' %>><%= p %></option>
        <% }); %>
      </select>
    </form>
  <% } %>
</div>
```

- [ ] **Step 2: Create `src/routes/admin/subscribers.js`**

```js
import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getSubscriberOverview,
  getSubscriberGrowth,
  getNewestSubscribers,
  getTopSpenders,
  getLapsedCustomers,
} from '../../services/analytics/subscribers.js';

export const subscribersRouter = express.Router();

subscribersRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const overview = getSubscriberOverview();
    const growth = getSubscriberGrowth(range);
    const newest = getNewestSubscribers();
    const topSpenders = getTopSpenders();
    const lapsed = getLapsedCustomers();
    res.render('admin/subscribers', { overview, growth, newest, topSpenders, lapsed, range });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Create `views/admin/subscribers.ejs`**

```html
<%- include('../partials/admin-head', { activePage: 'subscribers', title: 'Subscribers' }) %>

<%- include('../partials/filter-row', { basePath: '/admin/subscribers', range: range.preset, packageId: '', showPackageFilter: false, packages: [] }) %>

<div class="kpi-row">
  <div class="glass-card kpi-tile"><div class="label">Total Subscribers</div><div class="value"><%= overview.total %></div></div>
  <div class="glass-card kpi-tile"><div class="label">Active Subscribers</div><div class="value"><%= overview.active %></div></div>
  <div class="glass-card kpi-tile">
    <div class="label">New This Month</div>
    <div class="value"><%= overview.newThisMonth %></div>
    <div class="delta <%= overview.growthPct >= 0 ? 'up' : 'down' %>">
      <%= overview.growthPct >= 0 ? '▲' : '▼' %> <%= Math.abs(overview.growthPct).toFixed(1) %>% vs last month
    </div>
  </div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card" style="flex:1">
    <h3>Daily Subscriber Growth</h3>
    <%- lineChart(growth.map(function(g) { return { label: g.day, value: g.newSubscribers, displayValue: g.newSubscribers }; })) %>
  </div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card">
    <h3>Newest Subscribers</h3>
    <table class="dash-table">
      <thead><tr><th>Phone</th><th>First Purchase</th><th>Purchases</th><th>Spent</th></tr></thead>
      <tbody>
        <% newest.forEach(function(s) { %>
          <tr><td><%= s.phone %></td><td><%= s.first_purchase %></td><td><%= s.purchases %></td><td>$<%= Number(s.totalSpent).toFixed(2) %></td></tr>
        <% }); %>
        <% if (newest.length === 0) { %><tr><td colspan="4" style="color:var(--ink-muted)">No subscribers yet.</td></tr><% } %>
      </tbody>
    </table>
  </div>
  <div class="glass-card chart-card">
    <h3>Top Spending Customers</h3>
    <table class="dash-table">
      <thead><tr><th>Phone</th><th>Purchases</th><th>Spent</th></tr></thead>
      <tbody>
        <% topSpenders.forEach(function(s) { %>
          <tr><td><%= s.phone %></td><td><%= s.purchases %></td><td>$<%= Number(s.totalSpent).toFixed(2) %></td></tr>
        <% }); %>
        <% if (topSpenders.length === 0) { %><tr><td colspan="3" style="color:var(--ink-muted)">No data yet.</td></tr><% } %>
      </tbody>
    </table>
  </div>
</div>

<div class="glass-card">
  <h3>Lapsed / At-Risk Customers</h3>
  <table class="dash-table">
    <thead><tr><th>Phone</th><th>Last Purchase</th><th>Days Since</th></tr></thead>
    <tbody>
      <% lapsed.forEach(function(s) { %>
        <tr><td><%= s.phone %></td><td><%= s.lastPurchase %></td><td><%= Math.floor(s.daysSince) %></td></tr>
      <% }); %>
      <% if (lapsed.length === 0) { %><tr><td colspan="3" style="color:var(--ink-muted)">No lapsed customers.</td></tr><% } %>
    </tbody>
  </table>
</div>

<%- include('../partials/admin-foot') %>
```

- [ ] **Step 4: Wire `subscribersRouter` into `src/routes/admin/index.js`**

Find:

```js
import { overviewRouter } from './overview.js';
```

Replace with:

```js
import { overviewRouter } from './overview.js';
import { subscribersRouter } from './subscribers.js';
```

Find:

```js
adminRouter.use('/', overviewRouter);
```

Replace with:

```js
adminRouter.use('/', overviewRouter);
adminRouter.use('/subscribers', subscribersRouter);
```

- [ ] **Step 5: Start the dev server and verify**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt "http://localhost:<PORT>/admin/subscribers?range=30d" > subscribers.html
grep -o '0773333333' subscribers.html
grep -o 'Lapsed / At-Risk Customers' subscribers.html
```

Expected: the page renders, contains the seeded lapsed phone `0773333333` (20 days since its only purchase) somewhere in the newest-subscribers/top-spenders/lapsed tables, and includes the "Lapsed / At-Risk Customers" heading. Stop the server afterward.

- [ ] **Step 6: Commit**

```bash
cd "<worktree>"
git add src/routes/admin/subscribers.js views/admin/subscribers.ejs views/partials/filter-row.ejs src/routes/admin/index.js
git commit -m "Add Subscribers dashboard page"
```

---

### Task 9: Revenue page

**Files:**
- Create: `src/routes/admin/revenue.js`
- Create: `views/admin/revenue.ejs`
- Modify: `src/routes/admin/index.js`

**Interfaces:**
- Consumes: `parseDateRange` (Task 1), all six exports of `src/services/analytics/revenue.js` (Task 3), `PACKAGES` from `src/packages.js` (existing), `filter-row.ejs` (Task 8), `lineChart`/`horizontalBarChart` via `app.locals` (Task 6).

- [ ] **Step 1: Create `src/routes/admin/revenue.js`**

```js
import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getRevenueOverview,
  getRevenueTrend,
  getRevenueByPackage,
  getTransactionOutcomes,
  getRecentPayments,
  getFailedTransactions,
} from '../../services/analytics/revenue.js';
import { PACKAGES } from '../../packages.js';

export const revenueRouter = express.Router();

revenueRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const overview = getRevenueOverview();
    const trend = getRevenueTrend(range);
    const byPackage = getRevenueByPackage({ ...range, packageId });
    const outcomes = getTransactionOutcomes(range);
    const recent = getRecentPayments({ ...range, limit: 25 });
    const failed = getFailedTransactions({ ...range, limit: 25 });
    res.render('admin/revenue', {
      overview, trend, byPackage, outcomes, recent, failed,
      range, packageId, packages: PACKAGES.map((p) => p.id),
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Create `views/admin/revenue.ejs`**

```html
<%- include('../partials/admin-head', { activePage: 'revenue', title: 'Revenue' }) %>

<%- include('../partials/filter-row', { basePath: '/admin/revenue', range: range.preset, packageId: packageId, showPackageFilter: true, packages: packages }) %>

<div class="kpi-row">
  <div class="glass-card kpi-tile"><div class="label">Today</div><div class="value">$<%= Number(overview.today).toFixed(2) %></div></div>
  <div class="glass-card kpi-tile"><div class="label">This Week</div><div class="value">$<%= Number(overview.week).toFixed(2) %></div></div>
  <div class="glass-card kpi-tile"><div class="label">This Month</div><div class="value">$<%= Number(overview.month).toFixed(2) %></div></div>
  <div class="glass-card kpi-tile"><div class="label">This Year</div><div class="value">$<%= Number(overview.year).toFixed(2) %></div></div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card" style="flex:2">
    <h3>Revenue Trend</h3>
    <%- lineChart(trend.map(function(r) { return { label: r.day, value: r.revenue, displayValue: '$' + Number(r.revenue).toFixed(2) }; })) %>
  </div>
  <div class="glass-card chart-card">
    <h3>Revenue by Package</h3>
    <%- horizontalBarChart(byPackage.map(function(p) { return { label: p.package_id, value: p.revenue, displayValue: '$' + Number(p.revenue).toFixed(2) }; })) %>
  </div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card">
    <h3>Transaction Outcomes</h3>
    <%- horizontalBarChart(outcomes.map(function(o) { return { label: o.status, value: o.count, displayValue: o.count }; })) %>
  </div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">Recent Payments</h3>
      <a href="/admin/revenue/export.csv?range=<%= range.preset %><%= packageId ? '&package=' + packageId : '' %>" style="font-size:11px;color:var(--ink-secondary)">Export CSV</a>
    </div>
    <table class="dash-table">
      <thead><tr><th>Ref</th><th>Package</th><th>Amount</th><th>Phone</th><th>Voucher</th></tr></thead>
      <tbody>
        <% recent.forEach(function(t) { %>
          <tr><td style="font-size:11px"><%= t.reference %></td><td><%= t.package_id %></td><td>$<%= Number(t.amount).toFixed(2) %></td><td><%= t.phone || '—' %></td><td style="font-family:monospace"><%= t.voucher_code || '—' %></td></tr>
        <% }); %>
        <% if (recent.length === 0) { %><tr><td colspan="5" style="color:var(--ink-muted)">No payments in this range.</td></tr><% } %>
      </tbody>
    </table>
  </div>
  <div class="glass-card chart-card">
    <h3>Failed Transactions</h3>
    <table class="dash-table">
      <thead><tr><th>Ref</th><th>Package</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>
        <% failed.forEach(function(t) { %>
          <tr><td style="font-size:11px"><%= t.reference %></td><td><%= t.package_id %></td><td>$<%= Number(t.amount).toFixed(2) %></td><td><%= t.status %></td></tr>
        <% }); %>
        <% if (failed.length === 0) { %><tr><td colspan="4" style="color:var(--ink-muted)">No failures in this range.</td></tr><% } %>
      </tbody>
    </table>
  </div>
</div>

<%- include('../partials/admin-foot') %>
```

Note: the `Export CSV` link points at `/admin/revenue/export.csv`, which doesn't exist until Task 12 — it will 404 until then. This is expected and matches how Task 5/6's script-tag-before-file-exists sequencing already works in this plan.

- [ ] **Step 3: Wire `revenueRouter` into `src/routes/admin/index.js`**

Find:

```js
import { subscribersRouter } from './subscribers.js';
```

Replace with:

```js
import { subscribersRouter } from './subscribers.js';
import { revenueRouter } from './revenue.js';
```

Find:

```js
adminRouter.use('/subscribers', subscribersRouter);
```

Replace with:

```js
adminRouter.use('/subscribers', subscribersRouter);
adminRouter.use('/revenue', revenueRouter);
```

- [ ] **Step 4: Start the dev server and verify**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt "http://localhost:<PORT>/admin/revenue?range=30d" > revenue.html
grep -o 'SEED-5' revenue.html
grep -o 'Failed Transactions' revenue.html
```

Expected: page renders; `SEED-5` (the one seeded failed transaction) appears in the Failed Transactions table; the page includes all four KPI tiles. Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
cd "<worktree>"
git add src/routes/admin/revenue.js views/admin/revenue.ejs src/routes/admin/index.js
git commit -m "Add Revenue dashboard page"
```

---

### Task 10: Vouchers page

**Files:**
- Create: `src/routes/admin/vouchers.js`
- Create: `views/admin/vouchers.ejs`
- Modify: `src/routes/admin/index.js`

**Interfaces:**
- Consumes: `parseDateRange` (Task 1), all four exports of `src/services/analytics/vouchers.js` (Task 4), `PACKAGES` (existing), `filter-row.ejs` (Task 8), `lineChart`/`horizontalBarChart` via `app.locals` (Task 6).

- [ ] **Step 1: Create `src/routes/admin/vouchers.js`**

```js
import express from 'express';
import { parseDateRange } from '../../lib/dateRange.js';
import {
  getVoucherLifecycleCounts,
  getVoucherSalesTrend,
  getPackagePopularity,
  getLatestVouchers,
} from '../../services/analytics/vouchers.js';
import { PACKAGES } from '../../packages.js';

export const vouchersRouter = express.Router();

vouchersRouter.get('/', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const lifecycle = getVoucherLifecycleCounts(range);
    const salesTrend = getVoucherSalesTrend(range);
    const popularity = getPackagePopularity({ ...range, packageId });
    const latest = getLatestVouchers({ ...range, packageId, limit: 25 });
    res.render('admin/vouchers', {
      lifecycle, salesTrend, popularity, latest,
      range, packageId, packages: PACKAGES.map((p) => p.id),
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Create `views/admin/vouchers.ejs`**

```html
<%- include('../partials/admin-head', { activePage: 'vouchers', title: 'Vouchers' }) %>

<%- include('../partials/filter-row', { basePath: '/admin/vouchers', range: range.preset, packageId: packageId, showPackageFilter: true, packages: packages }) %>

<div class="kpi-row">
  <div class="glass-card kpi-tile"><div class="label">Sold</div><div class="value"><%= lifecycle.sold %></div></div>
  <div class="glass-card kpi-tile"><div class="label">Active</div><div class="value"><%= lifecycle.active %></div></div>
  <div class="glass-card kpi-tile"><div class="label">Unused</div><div class="value"><%= lifecycle.unused %></div></div>
  <div class="glass-card kpi-tile"><div class="label">Expired</div><div class="value"><%= lifecycle.expired %></div></div>
</div>

<div class="chart-row">
  <div class="glass-card chart-card" style="flex:1">
    <h3>Voucher Sales Over Time</h3>
    <%- lineChart(salesTrend.map(function(s) { return { label: s.day, value: s.count, displayValue: s.count }; })) %>
  </div>
  <div class="glass-card chart-card">
    <h3>Package Popularity</h3>
    <%- horizontalBarChart(popularity.map(function(p) { return { label: p.package_id, value: p.count, displayValue: p.count }; })) %>
  </div>
</div>

<div class="glass-card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h3 style="margin:0">Latest Vouchers</h3>
    <a href="/admin/vouchers/export.csv?range=<%= range.preset %><%= packageId ? '&package=' + packageId : '' %>" style="font-size:11px;color:var(--ink-secondary)">Export CSV</a>
  </div>
  <table class="dash-table">
    <thead><tr><th>Code</th><th>Package</th><th>Status</th><th>Expires</th><th>Created</th></tr></thead>
    <tbody>
      <% latest.forEach(function(v) { %>
        <tr><td style="font-family:monospace"><%= v.code %></td><td><%= v.package_id %></td><td><%= v.status %></td><td><%= v.expires_at || '—' %></td><td><%= v.created_at %></td></tr>
      <% }); %>
      <% if (latest.length === 0) { %><tr><td colspan="5" style="color:var(--ink-muted)">No vouchers in this range.</td></tr><% } %>
    </tbody>
  </table>
</div>

<%- include('../partials/admin-foot') %>
```

(As with Task 9's Export CSV link, this points at a route that doesn't exist until Task 12 — expected 404 until then.)

- [ ] **Step 3: Wire `vouchersRouter` into `src/routes/admin/index.js`**

Find:

```js
import { revenueRouter } from './revenue.js';
```

Replace with:

```js
import { revenueRouter } from './revenue.js';
import { vouchersRouter } from './vouchers.js';
```

Find:

```js
adminRouter.use('/revenue', revenueRouter);
```

Replace with:

```js
adminRouter.use('/revenue', revenueRouter);
adminRouter.use('/vouchers', vouchersRouter);
```

- [ ] **Step 4: Start the dev server and verify**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt "http://localhost:<PORT>/admin/vouchers?range=30d" > vouchers.html
grep -o 'SEEDV0' vouchers.html
grep -o '<div class="value">5</div>' vouchers.html
```

Expected: page renders; `SEEDV0` (one of the seeded voucher codes) appears in the Latest Vouchers table; the Sold KPI tile shows `5`. Stop the server afterward.

- [ ] **Step 5: Commit**

```bash
cd "<worktree>"
git add src/routes/admin/vouchers.js views/admin/vouchers.ejs src/routes/admin/index.js
git commit -m "Add Vouchers dashboard page"
```

---

### Task 11: Live Connected Users page

**Files:**
- Create: `src/routes/admin/live.js`
- Create: `views/admin/live.ejs`
- Create: `public/live-poll.js`
- Modify: `src/routes/admin/index.js`
- Modify: `views/partials/admin-foot.ejs`

**Interfaces:**
- Consumes: `getConnectedClients()` from `src/services/omada.js` (already built), `admin-head`/`admin-foot` (Task 5).
- Produces: `GET /admin/live/data` — a JSON endpoint (`{ total, clients }`, same shape as `getConnectedClients()`'s return value) that `public/live-poll.js` polls every 10 seconds. Nothing later in this plan depends on this task.

- [ ] **Step 1: Create `src/routes/admin/live.js`**

```js
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
```

- [ ] **Step 2: Create `views/admin/live.ejs`**

```html
<%- include('../partials/admin-head', { activePage: 'live', title: 'Live Connected Users' }) %>

<div class="glass-card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h3 style="margin:0">Live Connected Users (<span id="live-total"><%= total %></span>)</h3>
    <input type="text" id="live-search" placeholder="Search device, IP, MAC..." style="background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--ink-primary);border-radius:10px;padding:6px 12px;font-size:12px">
  </div>
  <table class="dash-table" id="live-table">
    <thead><tr><th>Device</th><th>MAC</th><th>IP</th><th>SSID</th><th>Access Point</th><th>Connected Since</th></tr></thead>
    <tbody id="live-tbody">
      <% clients.forEach(function(c) { %>
        <tr>
          <td><%= c.name %></td>
          <td><%= c.mac %></td>
          <td><%= c.ip %></td>
          <td><%= c.ssid %></td>
          <td><%= c.apName %></td>
          <td><%= c.connectedAt %></td>
        </tr>
      <% }); %>
    </tbody>
  </table>
  <p id="live-empty" style="color:var(--ink-muted);<%= clients.length ? 'display:none' : '' %>">No one connected right now.</p>
</div>

<script src="/live-poll.js" defer></script>
<%- include('../partials/admin-foot') %>
```

- [ ] **Step 3: Create `public/live-poll.js`**

```js
(function () {
  const tbody = document.getElementById('live-tbody');
  const totalEl = document.getElementById('live-total');
  const emptyEl = document.getElementById('live-empty');
  const searchInput = document.getElementById('live-search');
  if (!tbody) return;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function applyFilter() {
    const q = (searchInput.value || '').toLowerCase();
    Array.from(tbody.rows).forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function render(clients) {
    tbody.innerHTML = clients
      .map(
        (c) => `<tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.mac)}</td>
      <td>${escapeHtml(c.ip)}</td>
      <td>${escapeHtml(c.ssid)}</td>
      <td>${escapeHtml(c.apName)}</td>
      <td>${escapeHtml(c.connectedAt)}</td>
    </tr>`
      )
      .join('');
    emptyEl.style.display = clients.length ? 'none' : '';
    applyFilter();
  }

  searchInput.addEventListener('input', applyFilter);

  async function poll() {
    try {
      const res = await fetch('/admin/live/data');
      if (!res.ok) return;
      const data = await res.json();
      totalEl.textContent = data.total;
      render(data.clients);
    } catch (e) {
      // Network hiccup — keep showing the last known state, retry next tick.
    }
  }

  setInterval(poll, 10000);
})();
```

- [ ] **Step 4: Wire `liveRouter` into `src/routes/admin/index.js`**

Find:

```js
import { vouchersRouter } from './vouchers.js';
```

Replace with:

```js
import { vouchersRouter } from './vouchers.js';
import { liveRouter } from './live.js';
```

Find:

```js
adminRouter.use('/vouchers', vouchersRouter);
```

Replace with:

```js
adminRouter.use('/vouchers', vouchersRouter);
adminRouter.use('/live', liveRouter);
```

- [ ] **Step 5: Start the dev server and verify both the page and the polling endpoint**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt http://localhost:<PORT>/admin/live > live.html
grep -o 'Guest-Phone-1' live.html
curl -s -b admin-cookies.txt http://localhost:<PORT>/admin/live/data
```

Expected: `live.html` contains `Guest-Phone-1` (the mock fixture from `getConnectedClients()`); the `/admin/live/data` call returns JSON with `"total":3` and a `clients` array — confirm this endpoint is also gated by auth: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:<PORT>/admin/live/data` (no cookie) → expect `302` (redirect to login), not `200`. Stop the server afterward.

- [ ] **Step 6: Commit**

```bash
cd "<worktree>"
git add src/routes/admin/live.js views/admin/live.ejs public/live-poll.js src/routes/admin/index.js
git commit -m "Add Live Connected Users dashboard page with polling refresh"
```

---

### Task 12: CSV export

**Files:**
- Create: `src/lib/csv.js`
- Modify: `src/routes/admin/revenue.js`
- Modify: `src/routes/admin/vouchers.js`

**Interfaces:**
- Produces: `export function toCsv(rows, columns)` where `columns: Array<{key, label}>`, returns a CSV string (header + escaped rows, trailing newline). Consumed only within this task.
- This is the last task in the plan — after this task, delete `seed-tmp.mjs` (Global Constraints required keeping it until now).

- [ ] **Step 1: Create `src/lib/csv.js`**

```js
function escapeCsvValue(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvValue(row[c.key])).join(','));
  return [header, ...lines].join('\n') + '\n';
}
```

- [ ] **Step 2: Add the export route to `src/routes/admin/revenue.js`**

Add this import near the top:

```js
import { toCsv } from '../../lib/csv.js';
```

Add this route (after the existing `revenueRouter.get('/', ...)` handler):

```js
revenueRouter.get('/export.csv', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const rows = getRecentPayments({ ...range, limit: 10000 });
    const csv = toCsv(rows, [
      { key: 'reference', label: 'Reference' },
      { key: 'package_id', label: 'Package' },
      { key: 'amount', label: 'Amount' },
      { key: 'phone', label: 'Phone' },
      { key: 'status', label: 'Status' },
      { key: 'voucher_code', label: 'Voucher' },
      { key: 'created_at', label: 'Date' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Add the export route to `src/routes/admin/vouchers.js`**

Add this import near the top:

```js
import { toCsv } from '../../lib/csv.js';
```

Add this route (after the existing `vouchersRouter.get('/', ...)` handler):

```js
vouchersRouter.get('/export.csv', (req, res, next) => {
  try {
    const range = parseDateRange(req.query);
    const packageId = req.query.package || '';
    const rows = getLatestVouchers({ ...range, packageId, limit: 10000 });
    const csv = toCsv(rows, [
      { key: 'code', label: 'Code' },
      { key: 'package_id', label: 'Package' },
      { key: 'status', label: 'Status' },
      { key: 'expires_at', label: 'Expires' },
      { key: 'created_at', label: 'Created' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="vouchers.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Verify `toCsv` directly**

```bash
cd "<worktree>" && node -e "
import('./src/lib/csv.js').then((m) => {
  const csv = m.toCsv(
    [{ a: 'hello, world', b: 'line\nbreak' }, { a: 'plain', b: 42 }],
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
  );
  console.log(csv);
  console.log(csv.includes('\"hello, world\"') ? 'PASS: comma value quoted' : 'FAIL');
  console.log(csv.includes('\"line\\nbreak\"') ? 'PASS: newline value quoted' : 'FAIL');
});
"
```

Expected: both `PASS` lines (values containing commas/newlines are quoted; plain values are not).

- [ ] **Step 5: Start the dev server and verify both CSV endpoints, and that the "Export CSV" links added in Tasks 9-10 now resolve**

```bash
cd "<worktree>" && (nohup npm start > /tmp/dashboard-test.log 2>&1 &) && sleep 1.5 && cat /tmp/dashboard-test.log
cd /tmp && curl -s -c admin-cookies.txt -o /dev/null -X POST http://localhost:<PORT>/admin/login -d "username=<ADMIN_USER>&password=<ADMIN_PASSWORD>"
curl -s -b admin-cookies.txt "http://localhost:<PORT>/admin/revenue/export.csv?range=30d" | head -3
curl -s -b admin-cookies.txt "http://localhost:<PORT>/admin/vouchers/export.csv?range=30d" | head -3
```

Expected: both print a CSV header row followed by data rows (revenue: `Reference,Package,Amount,Phone,Status,Voucher,Date` then the 5 seeded paid transactions; vouchers: `Code,Package,Status,Expires,Created` then the 5 seeded vouchers). Stop the server afterward.

- [ ] **Step 6: Remove the temporary seed script (no longer needed by any later task)**

```bash
cd "<worktree>" && rm seed-tmp.mjs && git status
```

Confirm `seed-tmp.mjs` doesn't appear in `git status` output at all (it was never tracked, so removing it leaves no trace). The seeded rows remain in `data.sqlite` (gitignored, irrelevant to the commit either way).

- [ ] **Step 7: Commit**

```bash
cd "<worktree>"
git add src/lib/csv.js src/routes/admin/revenue.js src/routes/admin/vouchers.js
git commit -m "Add CSV export for revenue and voucher tables"
```

---

## Post-plan note

After all 12 tasks land, the controller (not a task implementer) should do one live visual pass in an actual browser — starting the dev server and viewing all 5 pages — before calling the feature done, per this project's standing instruction that UI work must be visually verified, not just structurally curl-checked. The per-task `curl`/`grep` verifications above confirm each page renders the right data; they do not confirm the glassmorphism styling, chart legibility, or hover/tooltip behavior actually look right, which only a real browser check can do.

`README.md` is not updated by this plan — a short follow-up documenting the new dashboard pages (replacing the old single-page `/admin` description) is reasonable but small enough to do directly rather than as a plan task.
