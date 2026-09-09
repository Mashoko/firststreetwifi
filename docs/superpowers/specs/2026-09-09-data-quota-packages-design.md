# Data-quota packages — design

## Problem

The current package model is purely time-based: a package grants N minutes
of access (`PACKAGES[].minutes`), enforced via the `time` field on Omada's
`extPortal/auth` client-authorization call. The business wants to switch to
data-volume-based packages (1GB/2GB/3GB/5GB/10GB) instead, at new prices and
durations, with per-purchase enforcement so a customer can't exceed what
they bought.

## Decisions made during brainstorming

- **No customer accounts.** Identity stays exactly as it is today: phone
  number + device MAC, redeemed via a one-time voucher code. No
  register/login system. ("Log back in and see your usage" from the
  original brief is explicitly out of scope.)
- **No live "used / remaining" meter.** Omada's `extPortal/auth` API
  supports a `totalTrafficLimitBytes` param that caps a session's data at
  authorization time, but its docs show no corresponding query API for
  bytes consumed so far. Building that would mean reviving the
  admin-scoped polling account deferred earlier in this project. Skipped
  for v1 — the portal/admin show what was *allocated*, not a live running
  balance. Omada still hard-enforces the cap regardless of whether we
  display it.
- **New purchase replaces the old one.** No stacking/combining of two
  active packages' quotas — not realistically buildable without the live
  usage polling above (we'd have no way to know a "remaining balance" to
  carry forward). A new `authorizeClient()` call for the same MAC
  naturally re-issues fresh limits with Omada's existing client-auth
  behavior; no extra code needed for this.

## Package definitions

Replacing `src/packages.js`'s `PACKAGES` array entirely:

| id     | name  | dataGB | price (USD) | minutes | duration label |
|--------|-------|-------:|------------:|--------:|----------------|
| `1gb`  | 1GB   |      1 |        0.50 |    1440 | 1 Day          |
| `2gb`  | 2GB   |      2 |        1.00 |    1440 | 1 Day          |
| `3gb`  | 3GB   |      3 |        2.00 |   10080 | 7 Days         |
| `5gb`  | 5GB   |      5 |        3.00 |   20160 | 14 Days        |
| `10gb` | 10GB  |     10 |        5.00 |   43200 | 30 Days        |

Each entry gains a `dataGB` field (for display) and a derived `dataBytes`
(`dataGB * 1024 * 1024 * 1024`, exact — no rounding) for the Omada API call.
`minutes` is kept as the session's hard time-based safety net (so a 1GB
pass that's barely used still expires after 1 day rather than staying
authorized indefinitely) — Omada enforces whichever of `time` /
`totalTrafficLimitBytes` is hit first.

The old `quick`/`day`/`week`/`month` ids are removed from `PACKAGES`
entirely (no active references in anything a customer can buy or see, per
requirement #13) — but they don't disappear from `getPackage()`. Two real
flows resolve a package id from a *stored* row, not from the current
offering, and both must keep working for whatever was actually sold:
`pay.js` finalizing an in-flight transaction, and `login.js` redeeming a
not-yet-used voucher (which may be weeks old under the old month-long
durations). `getPackage(id)` therefore checks the new `PACKAGES` array
first, then falls back to a small `LEGACY_PACKAGES` map holding just
`{id, name, minutes, price}` for the 4 retired ids (no `dataGB`/`dataBytes`
— those vouchers never had a data cap, and shouldn't gain one now). This
map is never exported to, offered by, or selectable from `/buy` or the
portal UI — its only purpose is honoring what was actually sold to someone
who already paid. No migration of historical rows.

## Enforcement — `src/services/omada.js`

`authorizeClient(clientInfo, durationMinutes, dataBytes)` gains a third,
**optional** param, passed as `totalTrafficLimitBytes` in the existing
`extPortal/auth` POST body, alongside the existing `time` field, only when
provided. Every *new* package has a data allocation, so callers using the
current `PACKAGES` list always pass it — but it stays optional so a
legacy (pre-cutover) voucher redemption, which never promised a data cap,
authorizes as time-only rather than the call inventing an arbitrary limit
that customer never bought.

## Call sites

Both existing callers already pass `pkg.minutes` and need the one extra
arg:

- `src/routes/pay.js` `finalizePaidTransaction()`: `authorizeClient(clientInfo, pkg.minutes, pkg.dataBytes)`
- `src/routes/login.js` (voucher redemption): same change, using
  `voucher.minutes` / `voucher.data_bytes` (see schema below)

## Schema change — `vouchers` table

Add one column via `initSchema()`'s `CREATE TABLE IF NOT EXISTS` (SQLite
`CREATE TABLE IF NOT EXISTS` doesn't retroactively add columns to an
existing table, so a `data_bytes` column needs an explicit `ALTER TABLE
... ADD COLUMN` guarded to run only if the column doesn't already exist,
the same pattern future schema changes to this file should follow):

```sql
ALTER TABLE vouchers ADD COLUMN data_bytes INTEGER;
```

`createVoucher()` in `src/services/vouchers.js` takes a `dataBytes` param
and stores it. Existing rows get `NULL` — never read for anything except
display (which only happens for *new* vouchers going forward).

## Display changes

- **`views/portal.ejs`** — each package card currently shows name + blurb
  + price. Replace the blurb line with data + duration
  (e.g. "3GB · 7 Days"), price stays as-is.
- **`views/success.ejs`** — currently converts `minutes` to a "N days" /
  "N hours" string. Add the GB amount alongside it (needs `pkg.dataGB`
  passed into the render call in both `pay.js`'s poll-status path and
  `login.js`'s voucher-redemption path — check both currently pass `pkg`).
- **Admin dashboard (Vouchers, Revenue)** — both already key off
  `package_id` as a raw string in their tables (`views/admin/vouchers.ejs`,
  `views/admin/revenue.ejs`); swapping which ids exist requires no code
  change there.

## Payment integrity (requirement #11)

Already holds today, confirming rather than changing: `portal.js`'s
`/buy` route resolves `pkg = getPackage(req.body.packageId)` server-side
and charges `pkg.price` — the client only ever sends a `packageId`, never
a price or data amount. This continues to hold unchanged with the new
package list.

## Out of scope (explicitly, from brainstorming)

- Customer accounts / login
- Live used/remaining data display, anywhere
- Multiple stacked/concurrent active packages per customer
- Admin UI for manually creating/granting a voucher (pre-existing gap,
  unrelated to this change — noted in an earlier conversation, not part
  of this spec)

## Testing

Manual verification (this app has no automated test suite):

1. Each of the 5 packages: buy in mock mode, confirm voucher shows correct
   GB/price/duration on the success page.
2. `authorizeClient()` call (can inspect via the same manual
   `node -e` probe pattern used earlier in this project against the real
   controller) — confirm `totalTrafficLimitBytes` in the request body
   matches `dataGB * 1024^3` exactly for each package.
3. Redeem a pre-cutover voucher (seed one with `package_id='day'` in a
   test DB) through `login.js`'s flow — confirm it resolves via
   `LEGACY_PACKAGES`, authorizes time-only (no `totalTrafficLimitBytes` in
   the request body), and doesn't crash. Same check for a `pay.js`
   in-flight transaction with a legacy `package_id`.
4. Buy a second package while a voucher from a first purchase is still
   within its validity window — confirm the second `authorizeClient()`
   call re-authorizes with the new package's fresh limits (manual check
   against the controller, not a DB assertion).
