# Analytics dashboard — design

## Problem

`/admin` (`src/routes/admin.js`, `views/admin.ejs`) currently shows three plain
HTML tables: revenue/paid-vouchers/total-attempts totals, a by-package
breakdown, and the 25 most recent transactions. There's no visibility into
subscriber growth, trends over time, live connected users, or voucher
lifecycle — despite that being the explicit ask for this project.

The original request described a full enterprise ISP analytics platform
(Redis, WebSocket streaming, 5 RBAC roles, per-router bandwidth monitoring,
support ticketing, 100,000+ subscriber scale, PDF/Excel/email reporting).
That doesn't match this project: one site ("Africom Hotspot"), one physical
controller, a handful of concurrent clients, one admin user, one payment
method (Paynow/EcoCash), and no infrastructure beyond Express + SQLite. This
spec covers a **real v1**: a premium-looking dashboard built entirely on data
that actually exists, scoped down from the original ask by explicit agreement
(see Non-goals).

## Goals

- Replace `/admin`'s plain tables with a 5-page dashboard: Overview,
  Subscribers, Revenue, Vouchers, Live.
- Show real metrics derived from the existing `transactions`/`vouchers`
  tables: subscriber counts and growth, revenue trends, voucher lifecycle,
  top/most-purchased packages, lapsed customers.
- Show live connected clients using `getConnectedClients()` (already built in
  `src/services/omada.js`), refreshed by polling.
- A premium dark-mode visual style (glassmorphism cards, KPI stat tiles with
  sparklines, sidebar navigation) using a validated, accessible color palette
  — not an improvised one.
- CSV export on the main data tables.
- Ship on the existing stack: Express + EJS + `better-sqlite3`, no new
  frontend framework, no new charting library, no new infrastructure.

## Non-goals (YAGNI) — explicitly cut after scope discussion

- **RBAC / multiple roles.** Single admin login (`ADMIN_USER`/`ADMIN_PASSWORD`,
  already built) stays as the only access control. Revisit if/when more staff
  need restricted access.
- **Router/bandwidth analytics, multi-hotspot comparison.** One site, one
  controller — nothing to compare.
- **Support ticketing.** No support system exists; out of scope.
- **Multi-payment-method breakdowns.** Only Paynow (EcoCash/OneMoney) exists.
  "Payment method distribution" charts are moot with one method.
- **WebSocket server, Redis, 100,000+ subscriber scale infrastructure,
  virtualized tables, server-side pagination.** Current scale is a handful of
  concurrent clients on one site. Polling (see Design) gives a "live" feel
  with zero new infrastructure.
- **PDF, Excel, scheduled reports, email reports.** Only CSV export ships in
  v1 — cheap (formats an existing query), no new libraries or mail service.
- **Light mode.** Dark mode (Midnight Minimal) only. Revisit if a real need
  shows up (e.g. outdoor/bright-screen use).
- **Churn cohort analysis / forecast charts.** Replaced by a simple "lapsed
  customers" table (last purchase >7 days ago, no new purchase since).
- **Device type, OS, browser, signal strength, upload/download speed per
  client.** `getConnectedClients()` doesn't expose these (Omada's basic API
  doesn't either, without significant further integration); the Live page
  shows what's actually available: mac, name, ip, ssid, apName, connectedAt.

## Design

### Pages

Sidebar navigation (glass sidebar + top bar), five pages, all behind the
existing `requireAdminAuth` session guard in `src/routes/admin.js`:

1. **Overview** (landing page after login): KPI row (Total Subscribers,
   Today's Revenue, Live Now, Vouchers Today), Revenue trend chart (30 days,
   fixed range, no filter control), Top Package chart, Live Connected Users
   table (first N rows, "see all" links to the Live page).
2. **Subscribers**: date-range filter; daily-signups growth chart; newest
   subscribers table; top-spenders table; lapsed/at-risk customers table.
3. **Revenue**: date-range + package filters; daily/weekly/monthly revenue
   figures; revenue-by-package chart; transaction-outcomes chart
   (paid/failed/pending counts); recent payments table; failed transactions
   table.
4. **Vouchers**: date-range + package filters; voucher lifecycle counts
   (sold/active/unused/expired) as a stat-tile row; voucher-sales-over-time
   chart; package-popularity chart; latest vouchers table.
5. **Live**: full connected-clients table from `getConnectedClients()`,
   client-side searchable, polling-refreshed (see Real-time below).

### Data definitions (no schema changes)

Everything derives from the existing `transactions` and `vouchers` tables
(`src/db/index.js`) — no new tables, no migration:

- **Subscriber** = a distinct `phone` value across `transactions` where
  `status='paid'`.
- **Active subscriber** = a phone with at least one voucher where
  `status='used' AND expires_at > datetime('now')` (currently within its
  paid window).
- **Voucher state** (computed at query time, not stored — avoids a
  background job to flip statuses):
  - `unused` — as stored (`vouchers.status = 'unused'`)
  - `active` — `status='used' AND expires_at > datetime('now')`
  - `expired` — `status='used' AND expires_at <= datetime('now')`, or
    explicit `status='expired'`
- **Monthly growth** = count of distinct phones whose *first-ever* paid
  transaction falls in the current calendar month, vs. the same count for
  last month, as a percentage change.
- **Lapsed/at-risk customer** = a phone whose most recent paid transaction
  is more than 7 days old, with no purchase since.
- **Live Now** = `getConnectedClients().total` — real Omada data, entirely
  independent of the billing tables above.
- Revenue/package/voucher breakdowns extend the existing `byPackage`/`recent`
  query patterns already in `src/routes/admin.js`, adding
  `GROUP BY date(created_at)` for trend charts and a `WHERE date(created_at)
  BETWEEN ? AND ?` clause for the date-range filter.

### Visual design system

- **Palette**: the dataviz skill's validated default dark palette, not an
  invented one — confirmed (via `scripts/validate_palette.js`) to pass every
  accessibility check against this project's chosen surface color:
  - Chart/card surface `#1a1a19`, page background `#0d0d0d`, primary ink
    `#ffffff`, secondary ink `#c3c2b7`, muted `#898781`, hairline borders
    `rgba(255,255,255,0.10)`.
  - Status colors (fixed, never themed): good `#0ca30c`, warning `#fab219`,
    serious `#ec835a`, critical `#d03b3b`.
  - Sequential (magnitude charts): single blue hue, light→dark ramp.
  - Categorical (only where distinct series must be told apart — package
    popularity across many packages, if that ever exceeds what a sequential
    ranking communicates): the validated 8-hue fixed-order set, used in
    order, never cycled or reassigned when a filter changes which packages
    are visible.
- **Glass card**: one reusable style —
  `background: rgba(255,255,255,0.045); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;`
  — applied to KPI cards, chart containers, tables, and the live-users panel
  alike.
- **Layout**: a shared `views/partials/admin-shell.ejs` renders the sidebar +
  top bar (search box, date/time, a visual theme-toggle slot with no actual
  light mode behind it yet); each page (`views/admin/overview.ejs`,
  `subscribers.ejs`, `revenue.ejs`, `vouchers.ejs`, `live.ejs`) renders inside
  it. Extends the existing EJS + `public/style.css` pattern — no new frontend
  framework, no build step.
- **KPI stat tile**: icon + label + animated count-up number (small vanilla
  JS, no library) + trend badge (▲/▼ + %, colored via the status palette;
  reversed for metrics where "down" is good, e.g. failed transactions).
- Existing `/admin/login` and `requireAdminAuth` are unchanged.

### Charts (form chosen by job, per the dataviz skill)

- **KPI numbers** → stat tiles (number + delta + small single-hue
  sparkline), not full charts.
- **Revenue trend, Subscriber growth** → line charts, single series each,
  sequential blue. No legend (a single series is named by its title).
- **Top Package, Revenue by Package, Package popularity** → horizontal bar,
  sequential blue (magnitude ranking, not "distinct series").
- **Voucher lifecycle counts** → a stat-tile row (sold/active/unused/expired
  are each a single current count, not a part-to-whole chart).
- **Transaction outcomes** (paid/failed/pending) → horizontal bar, replacing
  the dropped multi-payment-method chart.
- Every chart ships its hover layer: line charts get a crosshair + one
  tooltip listing the value at that date; bars are their own hit targets
  with per-bar tooltips. Tables are the built-in "table view" — no separate
  data-table export step needed.
- Charts are hand-rolled SVG/HTML per the dataviz skill's mark specs — no
  new charting library dependency.

### Filters

- **Date range** (Today / 7 / 30 / 90 days / custom): one row above the
  content on the Subscribers, Revenue, and Vouchers pages. Selecting a range
  re-renders every chart/stat/table on that page from the same query
  parameter, so numbers always agree. Implemented as a link/select row plus
  a `?range=` query param the server reads — no client-side state framework.
  The Overview page stays fixed at "last 30 days," no filter control.
- **Package filter**: a secondary filter on Revenue and Vouchers pages
  (`package_id` already exists on every row).

### Real-time behavior

No WebSocket server, no Redis — neither exists, and current scale (a
handful of concurrent clients) doesn't justify building them. The Live page
and the Overview "Live Now" KPI poll `getConnectedClients()` via a `fetch()`
loop every ~10 seconds and patch the DOM in place (no flash, no layout
jump, preserves scroll position) — visually equivalent to push-based "live"
at this scale. Revenue/subscriber charts and KPIs are not polled; they
reflect data as of page load/navigation, since those numbers don't need
sub-minute freshness the way "who's online right now" does.

### CSV export

A `?format=csv` query param on each page's main table route (transactions,
vouchers, subscribers), reusing the same SQL query that renders the HTML
table, piped through a plain comma-join formatter instead of EJS. No new
dependency.

## Testing

This repo has no automated test framework (established project convention).
Verification is manual:

1. Seed sample transactions/vouchers (mock mode already supports this via
   the existing purchase flow), hit each of the 5 pages, and hand-verify
   every number against a direct SQL query against `data.sqlite`.
2. Change the date-range filter on Subscribers/Revenue/Vouchers and confirm
   the displayed numbers match a manually re-run query for that range.
3. Confirm the Live page shows `getConnectedClients()`'s current data
   (mock-mode fixture today; real controller data once the physical
   controller migration is live) and that the ~10s poll updates the DOM
   without a full page reload or visible flash.
4. Confirm CSV export opens correctly in a spreadsheet application and its
   rows match the corresponding on-screen table.
5. Confirm `/admin/login` and `requireAdminAuth` still gate all 5 new pages
   exactly as they gate the current `/admin` page.
