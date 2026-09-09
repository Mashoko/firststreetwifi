# ERPNext invoice integration — design

## Problem

Every successful package purchase on the Africom Hotspot portal should create a
real, submitted, paid Sales Invoice in the business's existing ERPNext
instance (`https://erp.ai.co.zw`), so Finance can see and reconcile hotspot
revenue the same way they see any other retail sale — without changing how
the portal itself sells access or activates a customer's WiFi.

## Findings from the live ERPNext instance (not assumed — verified via API)

An integration user (`hotspot.integration@afri-com.net`) and its API
key/secret already exist and were verified read-capable against Customer,
Item, Sales Invoice, and Payment Entry (`GET` 200 on all four; write access
to be confirmed by the first real test invoice, per Testing below — the
brief explicitly forbids a destructive test to confirm this in advance).
Frappe 16.32.0 / ERPNext 16.32.3.

- **This is a multi-company, multi-currency instance.** 8 companies exist,
  none defaulting to USD (all ZWL or ZWG) — but multi-currency invoicing
  (USD invoice against a ZWG-default company, with a per-invoice
  `conversion_rate`) is already standard practice here, not something this
  integration introduces.
- **Company: `Africom Private Ltd ZiG`.** Its `domain` field is literally
  `"Retail"`, `default_income_account` is `"4101 - Subscriptions - APLG"`,
  default cost center `"200 - Africom Retail - APLG"` — and real invoices
  using the `SINV-RET-*` naming series are actively posted against it today,
  in USD.
- **Existing `$1`–`$5 Hotspot Voucher` Items are the wrong fit and are not
  reused.** They're `is_stock_item: 1` (physical stock-tracked cards, with an
  `opening_stock` count) at different price points than the current 5
  packages. This integration creates 5 new non-stock, service-type Items
  instead (table below).
- **Exchange rate is already solved by ERPNext itself.** A `Currency
  Exchange` doctype holds a daily-updated USD→ZWG rate (verified: 5 most
  recent days all present, one per day). The sync fetches the latest one at
  invoice-creation time; it is not computed or cached by this app.
- **Customer: the existing generic `CASH USD`** (customer_group: Retail).
  This app has no customer accounts (identity is phone number + device MAC
  only, no login) — `CASH USD` is the org's own existing convention for
  exactly this kind of anonymous cash-equivalent retail sale. No new
  ERPNext Customer is created per buyer.
- **Tax: `Zimbabwe Tax - APLG`.** Note this is *not* the template flagged
  `is_default: 1` in the Sales Taxes and Charges Template list (that's
  `vat output - APLG`) — the real retail invoice inspected
  (`SINV-RET-2026-03716`) actually uses `Zimbabwe Tax - APLG`, so this
  integration matches observed practice over the default flag.
- **ZIMRA fiscalisation is required, and the existing pattern requires a
  registered fiscal device tied to a POS Profile.** The real invoice
  inspected has `custom_fiscalise: 1`, a ZIMRA QR code, verification code,
  and `deviceid`, tied to a specific POS Profile (`ThrogmortonShop`). Six
  POS Profiles exist, one per physical shop (`Bulawayo Shop`, `Contact
  Centre`, `Gweru`, `MutareShop`, `StanleyHse Shop`, `ThrogmortonShop`) —
  **none for an online/web channel.** Registering a dedicated fiscal device
  for online sales is an external ZIMRA compliance step outside this
  project's scope. **Decision: route through the existing `Contact Centre`
  profile** (cost center "205 - Brand Experience - APLG") as a stand-in
  until a dedicated device is registered — flagged to the user as a
  follow-up, not solved here.
- **No `OneMoney` (or generic `Paynow`) Mode of Payment exists** — only
  various `Ecocash` variants tied to specific shops/tills. Two new Modes of
  Payment are created: `Paynow EcoCash`, `Paynow OneMoney`.
- **Naming series: `SINV-RET-.YYYY.-`** — the real retail series, reused as-is.

## Decisions made during brainstorming

- **No customer accounts, no per-buyer ERPNext Customer.** Every hotspot
  sale posts against the single `CASH USD` customer.
- **Invoice + Payment Entry created together, always.** By the time this
  integration ever sees a transaction, Paynow has already confirmed real
  payment — there is no "unpaid ERPNext invoice" state to represent. Every
  synced transaction gets a submitted Sales Invoice *and* a matching
  Payment Entry in the same sync pass, mirroring the real `SINV-RET-*`
  invoices (all `status: "Paid"`).
- **ERP sync is fully decoupled from package activation.** The existing
  `finalizePaidTransaction()` in `src/routes/pay.js` — the one authoritative
  place a payment becomes genuinely successful — only marks
  `erpnext_sync_status = 'pending'` on the transaction row. It makes no
  ERPNext HTTP call itself. A customer's WiFi access is never delayed or
  put at risk by ERPNext being slow or unavailable.
- **Retry via a small cron script, not a new queue.** This app has no
  existing job queue (Express + SQLite, no Celery/BullMQ/Redis inside this
  specific project). A new Node script, `scripts/sync-erpnext-invoices.js`,
  follows the existing `scripts/check-connected-clients.js` pattern — run
  on a schedule via system cron on the production server, not a
  long-running process inside the web app.
- **Fiscalisation now, via the `Contact Centre` stand-in profile** — not
  deferred, per explicit instruction, with the caveat above about a proper
  dedicated device being a follow-up.

## Package → Item mapping

| Package id | Item Code | Item Name | Item Group | Price (USD) |
|---|---|---|---|---:|
| `1gb` | `HOTSPOT-1GB-1D` | Hotspot 1GB Data (1 Day) | Airtime | 0.50 |
| `2gb` | `HOTSPOT-2GB-1D` | Hotspot 2GB Data (1 Day) | Airtime | 1.00 |
| `3gb` | `HOTSPOT-3GB-7D` | Hotspot 3GB Data (7 Days) | Airtime | 2.00 |
| `5gb` | `HOTSPOT-5GB-14D` | Hotspot 5GB Data (14 Days) | Airtime | 3.00 |
| `10gb` | `HOTSPOT-10GB-30D` | Hotspot 10GB Data (30 Days) | Airtime | 5.00 |

These 5 Items are created once, by a dedicated one-time setup script (see
"One-time ERPNext setup" below) — never by the recurring sync script. The
sync script must not assume they already exist and should fail clearly
(not silently) if a mapped Item Code is missing, rather than attempting to
create one mid-sync (creating full Item records with the right
group/stock/pricing settings is exactly the kind of thing that should
happen once, reviewed, not repeatedly on every cron tick).

Legacy package ids (`quick`/`day`/`week`/`month`, from before the
data-quota-packages change) have no ERPNext Item mapping and are not
synced — see Out of scope.

## Database changes — `transactions` table

New columns, all nullable, added the same guarded way the
`data_bytes` column was added to `vouchers` (`PRAGMA table_info` check +
conditional `ALTER TABLE` in `initSchema()`):

```sql
ALTER TABLE transactions ADD COLUMN erpnext_customer TEXT;
ALTER TABLE transactions ADD COLUMN erpnext_invoice_name TEXT;
ALTER TABLE transactions ADD COLUMN erpnext_payment_entry_name TEXT;
ALTER TABLE transactions ADD COLUMN erpnext_sync_status TEXT;        -- pending | success | failed
ALTER TABLE transactions ADD COLUMN erpnext_sync_attempts INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN erpnext_last_sync_attempt TEXT;
ALTER TABLE transactions ADD COLUMN erpnext_synced_at TEXT;
ALTER TABLE transactions ADD COLUMN erpnext_sync_error TEXT;
```

`erpnext_invoice_name`/`erpnext_payment_entry_name` hold the actual Frappe
document name (e.g. `SINV-RET-2026-03717`) — Frappe doctypes have no
separate numeric ID apart from this name, so the brief's
`erpnext_invoice_id`/`erpnext_invoice_number` distinction collapses to one
field each here.

No changes to the `vouchers` table — the ERP invoice represents the *sale*
(one per successful payment), not the *voucher* (which can be redeemed
later, possibly on a different device, with no new money changing hands at
redemption time). Voucher redemption in `login.js` is unaffected by this
work entirely.

## Sync flow

**Trigger point — `src/routes/pay.js`, inside `finalizePaidTransaction()`,**
right after the existing voucher-creation and `authorizeClient()` call
(success or failure of `authorizeClient()` doesn't gate this — a customer
who bought access should still get an invoice even if, say, they closed
their laptop before the Omada authorize call completed):

```javascript
db.prepare(
  `UPDATE transactions SET erpnext_sync_status='pending', updated_at=datetime('now') WHERE id=?`
).run(tx.id);
```

That's the entire change to the existing request path. Everything else
lives in the new sync script.

**`scripts/sync-erpnext-invoices.js`** (new file, run via cron, e.g. every 3
minutes):

1. Query transactions where `erpnext_sync_status IN ('pending','failed')
   AND erpnext_sync_attempts < 5`, ordered oldest-first, backoff-gated by
   `erpnext_last_sync_attempt` (skip a row whose next eligible retry time —
   1min/5min/15min per attempt count — hasn't arrived yet).
2. For each transaction, in one ERPNext "session" (login once, reuse the
   session across all rows in this run — see Client below):
   - **Idempotency check first:** if `tx.erpnext_invoice_name` is already
     set, skip (already done, shouldn't be in the pending/failed query
     result at all, but a cheap belt-and-suspenders check). Then query
     ERPNext directly for an existing Sales Invoice with a custom field
     `website_transaction_id = tx.reference` — if found, adopt its name
     onto the local row instead of creating a duplicate (covers a crash
     between "ERPNext created the invoice" and "we recorded that locally").
   - Resolve `pkg = getPackage(tx.package_id)`. If `pkg` has no Item
     mapping (a legacy package id), mark `erpnext_sync_status='not_required'`
     and move on — never attempted, never retried.
   - Fetch the latest USD→ZWG rate from `Currency Exchange`.
   - Create the Sales Invoice: customer `CASH USD`, company `Africom
     Private Ltd ZiG`, currency `USD`, the fetched `conversion_rate`, one
     line item (the mapped Item Code, qty 1, rate = `pkg.price`), tax
     template `Zimbabwe Tax - APLG`, `is_pos: 1`, `pos_profile: "Contact
     Centre"`, `custom_fiscalise: 1`, plus custom fields
     `website_transaction_id` (= `tx.reference`), `website_package_id`
     (= `tx.package_id`), `payment_gateway` (= `"Paynow"`).
   - Submit it (`docstatus: 1`).
   - Create a Payment Entry against it: amount = `tx.amount`, mode of
     payment = `"Paynow EcoCash"` or `"Paynow OneMoney"` depending on
     `tx.method`, reference = `tx.reference`. Submit it too.
   - On success: store `erpnext_invoice_name`, `erpnext_payment_entry_name`,
     `erpnext_customer='CASH USD'`, `erpnext_sync_status='success'`,
     `erpnext_synced_at=now`.
   - On any failure at any step: store `erpnext_sync_status='failed'`,
     `erpnext_sync_error` (the specific error message — never the API
     secret, which can't appear in an ERPNext error body anyway since it's
     only ever sent as a request header), increment
     `erpnext_sync_attempts`, set `erpnext_last_sync_attempt=now`. Move to
     the next row — one transaction's failure never stops the sweep.
3. Log a one-line summary per run (attempted / succeeded / failed counts)
   to stdout, which PM2/cron capture the same way this project's other
   scripts already do — no new logging infrastructure.

**Custom fields on Sales Invoice** — `website_transaction_id`,
`website_package_id`, `payment_gateway` need to exist in ERPNext before the
first sync can set them. Created by the same one-time setup script as the
Items — the sync script does not create these on the fly.

## One-time ERPNext setup — `scripts/setup-erpnext.js`

A new script, run manually once (by whoever runs this project's other
one-time scripts, e.g. `npm run init-db` — same category of action),
before the recurring sync script's first real run. Idempotent — checks for
each thing's existence before creating it, so it's safe to re-run (e.g.
after adding a 6th package in the future). Creates, only if missing:

- The 5 Items from the mapping table above (non-stock, `is_sales_item: 1`,
  `is_stock_item: 0`, Item Group `Airtime`, `standard_rate` = the package
  price)
- The 3 Custom Fields on Sales Invoice (`website_transaction_id`,
  `website_package_id`, `payment_gateway` — all simple Data fields)
- The 2 Modes of Payment (`Paynow EcoCash`, `Paynow OneMoney`)

This script requires the integration user to actually have *write*
permission on Item, Custom Field, and Mode of Payment doctypes — which,
like Sales Invoice/Payment Entry write access, was not confirmed during
design (only read access was checked, per the brief's explicit
no-destructive-testing rule) and is confirmed by this script actually
running successfully as the first real write-permission test.

## ERPNext API client — `src/services/erpnext.js`

A dedicated module, following the exact shape `src/services/omada.js`
already established in this codebase (token-style auth header built once,
a small set of named async functions, mock-mode short-circuit at the top of
each exported function so `MOCK_MODE=true` needs no real ERPNext reachable):

```javascript
export async function getLatestExchangeRate(from, to) { ... }
export async function findInvoiceByTransactionRef(reference) { ... }
export async function createAndSubmitInvoice({ reference, packageId, amount, method }) { ... }
export async function createAndSubmitPaymentEntry({ invoiceName, amount, method, reference }) { ... }
```

Auth: `Authorization: token <ERPNEXT_API_KEY>:<ERPNEXT_API_SECRET>` header,
built once from `config.erpnext`, matching how `config.omada` already
centralizes Omada credentials. Uses the same `undici` `Agent`/`dispatcher`
pattern already fixed in `omada.js` for TLS — `erp.ai.co.zw` has a normal
public cert so `rejectUnauthorized` stays `true` here, unlike the
self-signed local Omada controller.

New `.env` keys (both local and production):

```
ERPNEXT_BASE_URL=https://erp.ai.co.zw
ERPNEXT_API_KEY=<the existing key>
ERPNEXT_API_SECRET=<the existing secret>
```

Never logged, never sent to the frontend, never committed — the secret is
handled exactly like `OMADA_OPERATOR_PASS`/`PAYNOW_INTEGRATION_KEY` already
are in this codebase.

## Admin dashboard

`views/admin/revenue.ejs`'s existing transaction tables (both the "recent
paid" and "recent failed" ones, per the file already read during the
quota-packages work) gain one more column: ERP Sync status
(`erpnext_sync_status`, defaulting to a dash for anything not yet
attempted/not-required), styled with the existing `.badge` classes
(`.badge.paid`-style green for success, `.badge.failed`-style red for
failed, neutral for pending). No retry-from-dashboard button in this pass
— out of scope, matches the brief's own permission ("if the existing
architecture supports manual retry, provide it" — it doesn't yet, and
adding one is a bigger UI/route change than this spec's scope).

## Failure independence (explicit)

- ERPNext down/slow: payment and WiFi access are entirely unaffected
  (already covered above — no synchronous call in the request path at
  all).
- A failed Paynow payment (`tx.status != 'paid'`) never reaches the sync
  query in the first place — `erpnext_sync_status` stays `NULL` for it
  forever, no invoice, matching the brief's explicit rule.
- A legacy-package transaction (pre-data-quota-packages) is marked
  `not_required` on first sync attempt and never retried.

## Out of scope (explicitly)

- Registering a dedicated ZIMRA fiscal device / POS Profile for the online
  channel — external compliance step, flagged as a follow-up.
- Manual "retry ERP sync" button in the admin dashboard.
- Per-buyer ERPNext Customer records.
- Any change to voucher redemption (`login.js`) — sync is purchase-time
  only.
- Creating the 5 ERPNext Items and 3 Custom Fields programmatically as part
  of the sync script — these are one-time setup, done once (by this
  project's implementation, or manually) before the sync script's first
  real run, not on every cron tick.

## Testing

Manual verification (this project has no automated test framework,
established throughout its history):

1. Mock mode (`MOCK_MODE=true`): confirm `erpnext.js`'s functions
   short-circuit with a `[MOCK]` log line and no real HTTP call, same
   pattern as `omada.js`/`paynow.js`.
2. Run `scripts/setup-erpnext.js` against the real instance — confirm the 5
   Items, 3 Custom Fields, and 2 Modes of Payment are created, and that
   this is the first real confirmation of write access (not just read).
   Run it a second time immediately after — confirm it's a no-op (nothing
   duplicated, no error).
3. Real credentials, a single controlled test purchase (small amount, e.g.
   the `1gb` $0.50 package): run the sync script once, confirm a real
   `SINV-RET-*` invoice appears in ERPNext with the right customer,
   company, item, amount, tax, and fiscal fields, and a matching submitted
   Payment Entry — this is also the first real confirmation that the
   integration user actually has *write* access (only read was confirmed
   during design), per the brief's own Test 1.
4. Duplicate-webhook simulation: mark the same transaction pending twice
   in a row (simulating Paynow's callback firing twice) and run the sync
   script twice — confirm exactly one invoice, no duplicate.
5. A transaction with a legacy `package_id` — confirm it's marked
   `not_required`, not retried, no invoice.
6. Simulate ERPNext unreachable (wrong `ERPNEXT_BASE_URL` temporarily) —
   confirm the transaction is marked `failed` with a real error message,
   `erpnext_sync_attempts` increments, and — critically — the customer's
   WiFi access and voucher were already granted before this, unaffected.
7. Confirm the admin Revenue page's new ERP Sync column renders correctly
   for success/failed/pending/not_required/never-attempted states.
