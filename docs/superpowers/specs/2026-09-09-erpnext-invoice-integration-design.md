# ERPNext invoice integration — design

## Problem

Every successful package purchase on the Africom Hotspot portal should create a
real, submitted, paid Sales Invoice in the business's existing ERPNext
instance (`https://erp.ai.co.zw`), so Finance can see and reconcile hotspot
revenue the same way they see any other retail sale — without changing how
the portal itself sells access or activates a customer's WiFi.

## Findings from the live ERPNext instance (not assumed — verified via API)

An integration user (`hotspot.integration@afri-com.net`) and its API
key/secret already exist. Frappe 16.32.0 / ERPNext 16.32.3.

**Real write-permission testing (superseding the original design-phase
read-only check) found this user has a deliberately narrow, already
least-privileged role:**

| Doctype | Create | Notes |
|---|---|---|
| Item | ❌ 403 | |
| Custom Field | ❌ 403 | |
| Mode of Payment | ❌ 403 | |
| Sales Invoice | ✅ Works | Draft created successfully; a later submit attempt hit a real accounting validation, not a permission error |
| Payment Entry | ✅ Works | A create attempt correctly failed only on "invoice must be submitted first" — a real dependency validation, not a permission error |

This is intentional scoping, not a gap to patch by requesting broader
access: someone at Africom already restricted this integration user to
exactly the transactional flow it needs (Sales Invoice + Payment Entry)
while withholding master-data creation. **The correct response is to work
within that boundary — reuse existing master data, never request Item/
Custom Field/Mode of Payment write access for this user.** This reverses
the original design's plan to have the integration create 5 new Items —
see the corrected Package → Item mapping below.

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
- **Existing `$1`–`$5 Hotspot Voucher` Items are stock-tracked physical
  vouchers at the wrong price points** — not used for this integration.
  Instead, a real, already-existing non-stock `electroair*` ("Electronic
  Airtime Voucher") family covers 3 of the 5 packages exactly by price
  (`electroair0.5`, `electroair1`, `electroair5`); the 3GB/5GB packages
  map to the `$2`/`$3 Hotspot Voucher` items instead (see the corrected
  mapping table below) — these are stock-tracked, but every invoice line's
  `rate` is always the actual transaction amount from our own database,
  never read from the Item's `standard_rate`, so the Item's odd stored
  rate (2.60/3.46, likely a cost-basis figure) never reaches a real
  invoice. No Items are created by this integration, at all, ever.
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
  Payment are needed: `Paynow EcoCash`, `Paynow OneMoney` — created directly
  in the ERPNext UI by a user with proper access (the integration user
  cannot create Mode of Payment records, confirmed above), not by this
  integration's code.
- **Naming series: `SINV-RET-.YYYY.-`** — the real retail series, reused as-is.
- **The `website_transaction_id`/`website_package_id`/`payment_gateway`
  Custom Fields on Sales Invoice are dropped from this integration
  entirely (for now).** A real attempt to create them hit the same 403 as
  Item/Mode of Payment. They were then created directly via the ERPNext UI
  (which a Custom Field record *can* be created through, unlike via the
  API user), but the underlying database column never actually got added —
  this specific ERPNext instance does not auto-migrate schema changes on
  Custom Field save (a real, and sensible, safety measure for a live
  financial system); it needs an explicit `bench migrate` (or equivalent)
  server-side, which needs someone with hosting/server access, not just
  ERPNext UI access. A real test confirmed that *writing* to one of these
  fields during invoice creation currently fails the entire create call
  (`MySQLdb.OperationalError: Unknown column`) — not a graceful "field
  ignored," a hard failure. **Decision: do not set these fields at all for
  now.** Idempotency relies solely on this app's own `transactions.
  erpnext_invoice_name` column (already reliable for the normal case);
  the ERPNext-side "search by transaction reference" secondary safety net
  is dropped along with the fields it depended on. Re-adding both is a
  small, self-contained follow-up once the schema migration runs.

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

All 5 Items already exist in ERPNext — none are created by this
integration, ever. The mapping below reuses the closest existing Item per
package; each Item's own stored `standard_rate` is irrelevant and never
read — the invoice line `rate` is always set explicitly from `pkg.price`
(the price this app actually charged), never from the Item.

| Package id | Item Code | Item's own list price | Price actually invoiced (USD) |
|---|---|---:|---:|
| `1gb` | `electroair0.5` | 0.50 | 0.50 |
| `2gb` | `electroair1` | 1.00 | 1.00 |
| `3gb` | `$2 Hotspot Voucher` | (odd/stale) | 2.00 |
| `5gb` | `$3 Hotspot Voucher` | (odd/stale) | 3.00 |
| `10gb` | `electroair5` | 5.00 | 5.00 |

The sync script must not assume a mapped Item Code exists and should fail
clearly (not silently) if ERPNext ever reports it missing — that's a
signal someone renamed/deleted an Item on the ERPNext side, not something
to paper over by creating a replacement (this integration has no Item
Create permission at all, so it couldn't even if it wanted to).

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
   - **Idempotency check:** if `tx.erpnext_invoice_name` is already set,
     skip — already done, shouldn't be in the pending/failed query result
     at all, but a cheap belt-and-suspenders check. This local check is
     the *only* idempotency mechanism (see "Custom fields dropped" note
     below for why there is no ERPNext-side cross-check).
   - Resolve `pkg = getPackage(tx.package_id)`. If `pkg` has no Item
     mapping (a legacy package id), mark `erpnext_sync_status='not_required'`
     and move on — never attempted, never retried.
   - Fetch the latest USD→ZWG rate from `Currency Exchange`.
   - Create the Sales Invoice: customer `CASH USD`, company `Africom
     Private Ltd ZiG`, currency `USD`, the fetched `conversion_rate`, one
     line item (the mapped Item Code, qty 1, rate = `pkg.price`), tax
     template `Zimbabwe Tax - APLG`, `is_pos: 1`, `pos_profile: "Contact
     Centre"`, `custom_fiscalise: 1`. No `website_transaction_id`/
     `website_package_id`/`payment_gateway` fields are set — see below.
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

**Custom fields dropped from this integration (for now).** The original
design put `website_transaction_id`, `website_package_id`, and
`payment_gateway` on Sales Invoice, both to carry useful cross-reference
data and to give the sync script a second, ERPNext-side idempotency check
(look up an existing invoice by `website_transaction_id` before creating a
new one). Real testing on the live instance found:

- The integration user cannot create Custom Fields (403, same as Item and
  Mode of Payment) — consistent with the least-privilege scoping described
  above.
- A user with ERPNext UI access created the 3 fields directly (the UI
  auto-prefixes fieldnames to `custom_website_transaction_id`, etc.), but
  the underlying database column was never actually added — this instance
  does not auto-migrate schema on Custom Field save, and needs a
  server-side `bench migrate` (or equivalent) that only someone with
  server/hosting access can run, not obtainable through the ERPNext UI or
  the API.
- Confirmed by direct testing: setting one of these fields on a Sales
  Invoice create call fails the *entire* create with a 500
  (`MySQLdb.OperationalError: Unknown column ...`) — not a graceful
  ignore.

**Decision: drop all 3 fields from this integration entirely, for now.**
Idempotency relies solely on the local `transactions.erpnext_invoice_name`
column (already reliable for the normal case: the sync script never
re-attempts a row once that column is set). The one edge case this gives
up is a crash between "ERPNext created the invoice" and "we recorded that
locally" — in that narrow window a retry could create a second invoice for
the same transaction. Given the cron interval and the low volume of this
business, this is an accepted, documented risk, not a silent gap — re-
adding the custom fields (and the ERPNext-side lookup) is a small,
self-contained follow-up once someone with server access runs the schema
migration.

## One-time ERPNext setup

Nothing in this integration's *code* creates ERPNext records as setup —
the integration user cannot create Item, Custom Field, or Mode of Payment
records, and the corrected design deliberately does not ask it to. All
one-time setup is done by a human with ERPNext UI access, before the
recurring sync script's first real run:

- **Items:** none created — all 5 already exist (see the mapping table
  above). Nothing to do.
- **Custom Fields:** dropped from this integration entirely (see "Custom
  fields dropped" above). Nothing to do until the schema-sync follow-up.
- **Modes of Payment:** `Paynow EcoCash` and `Paynow OneMoney` (Type:
  `General`) must exist before the sync script's first real Payment Entry
  create — created directly via the ERPNext UI (List view → New), a plain
  record insert with no schema-sync complication, unlike Custom Field.

There is no `scripts/setup-erpnext.js` in this design — there is nothing
left for a script to set up that the integration user is permitted to
create.

## ERPNext API client — `src/services/erpnext.js`

A dedicated module, following the exact shape `src/services/omada.js`
already established in this codebase (token-style auth header built once,
a small set of named async functions, mock-mode short-circuit at the top of
each exported function so `MOCK_MODE=true` needs no real ERPNext reachable):

```javascript
export async function getLatestExchangeRate(from, to) { ... }
export async function createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB }) { ... }
export async function createAndSubmitPaymentEntry({ invoiceName, amount, method, reference }) { ... }
```

`findInvoiceByTransactionRef` — present in an earlier draft of this
module, built for the ERPNext-side idempotency check described above — is
dropped along with the 3 custom fields it depended on (it queried
`website_transaction_id`, a field that no longer exists in this design).
It is removed from the module rather than left dead: reintroducing it is
part of the same follow-up that re-adds the custom fields.

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
- Creating ERPNext Items, Custom Fields, or Modes of Payment
  programmatically, at any time — the integration user has no Create
  permission on any of these doctypes (confirmed 403 on all three, real
  requests), and this is intentional least-privilege scoping to preserve,
  not a gap to work around. All 5 Items already exist and are reused
  as-is; Modes of Payment are created once, manually, via the ERPNext UI;
  the 3 originally-planned Custom Fields are dropped from this integration
  entirely pending a server-side schema migration (see "Custom fields
  dropped" above).
- Requesting broader ERPNext permissions for the integration user, or
  using Administrator credentials, to work around any of the above.

## Testing

Manual verification (this project has no automated test framework,
established throughout its history):

1. Mock mode (`MOCK_MODE=true`): confirm `erpnext.js`'s functions
   short-circuit with a `[MOCK]` log line and no real HTTP call, same
   pattern as `omada.js`/`paynow.js`.
2. Confirm the one-time manual setup is complete before the first real
   sync run: the 2 Modes of Payment (`Paynow EcoCash`, `Paynow OneMoney`)
   exist in ERPNext (created via the UI, per "One-time ERPNext setup"
   above) — there is no setup script to run, since Items already exist
   and Custom Fields are dropped from this integration.
3. Real credentials, a single controlled test purchase (small amount, e.g.
   the `1gb` $0.50 package): run the sync script once, confirm a real
   `SINV-RET-*` invoice appears in ERPNext with the right customer,
   company, mapped item (`electroair0.5`), amount, tax, and fiscal fields,
   and a matching submitted Payment Entry — this is also the first real
   confirmation that the integration user actually has *write* access on
   Sales Invoice and Payment Entry (only read was confirmed during
   design), per the brief's own Test 1. Watch specifically for a "Debit
   and Credit not equal" validation error on submit — seen once during
   ad-hoc testing with a minimal payload missing `is_pos`/`pos_profile`/
   tax fields; the real `createAndSubmitInvoice()` payload includes all of
   these, but this needs to be watched, not assumed fixed.
4. Duplicate-webhook simulation: mark the same transaction pending twice
   in a row (simulating Paynow's callback firing twice) and run the sync
   script twice — confirm exactly one invoice, no duplicate. (This
   exercises only the local `erpnext_invoice_name` idempotency check, per
   the "Custom fields dropped" note above — there is no ERPNext-side
   cross-check in this design.)
5. A transaction with a legacy `package_id` — confirm it's marked
   `not_required`, not retried, no invoice.
6. Simulate ERPNext unreachable (wrong `ERPNEXT_BASE_URL` temporarily) —
   confirm the transaction is marked `failed` with a real error message,
   `erpnext_sync_attempts` increments, and — critically — the customer's
   WiFi access and voucher were already granted before this, unaffected.
7. Confirm the admin Revenue page's new ERP Sync column renders correctly
   for success/failed/pending/not_required/never-attempted states.
