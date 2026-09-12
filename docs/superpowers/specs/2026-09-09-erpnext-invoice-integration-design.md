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
  Payment are needed: `Paynow Ecocash`, `Paynow OneMoney` — created directly
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
- **Invoice settles itself via its own `payments` row — no separate
  Payment Entry.** (Superseded from the original "Invoice + Payment Entry
  created together, always" decision — see "Sync flow" below.) By the
  time this integration ever sees a transaction, Paynow has already
  confirmed real payment, so the `is_pos: 1` invoice's own `payments`
  child-table row (required anyway — ERPNext rejects a POS invoice submit
  with no payment method declared) fully settles it in the same call that
  creates and submits it, exactly matching how the business's own real
  `SINV-RET-*` retail invoices work (checked directly: none of them have
  a Payment Entry either). A real end-to-end test with a separate Payment
  Entry on top of this row found it fighting the `payments` row for
  settlement — see "Sync flow" for the full story.
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
  `UPDATE transactions SET erpnext_sync_status='pending', updated_at=datetime('now')
   WHERE id=? AND erpnext_invoice_name IS NULL AND erpnext_sync_status IS NOT 'processing'`
).run(tx.id);
```

That's the entire change to the existing request path. Everything else
lives in the new sync script. Neither guard clause was in the original
design — both were added after real bugs surfaced from Paynow resending
its result callback for the same transaction (confirmed: Paynow does
this):
- `erpnext_invoice_name IS NULL` (whole-branch review): without it, a
  repeat callback arriving after a successful sync would reset an
  already-synced row back to `pending` forever (the sync script's own
  idempotency check would then skip it every run without ever correcting
  the status).
- `erpnext_sync_status IS NOT 'processing'` (that fix's own scoped
  re-review): the first guard alone left one window open — a repeat
  callback landing *while* a sync run currently holds the row (invoice
  name still `NULL` at that point) would still flip it back to `pending`,
  making it claimable again by the sync script's own atomic claim.

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
     Private Ltd ZiG`, currency `USD`, the fetched `conversion_rate`,
     `disable_rounded_total: 1`, one line item (the mapped Item Code, qty
     1, **rate = the net (pre-tax) amount** — see "Tax and settlement
     correction" below, not `pkg.price`/`tx.amount` directly), tax
     template `Zimbabwe Tax - APLG`, `is_pos: 1`, `pos_profile: "Contact
     Centre"`, `custom_fiscalise: 1`, and a `payments` row (mode of
     payment = `"Paynow Ecocash"` or `"Paynow OneMoney"` depending on
     `tx.method`, amount = `tx.amount`, the money actually collected). No
     `website_transaction_id`/`website_package_id`/`payment_gateway`
     fields are set — see below.
   - Submit it (`docstatus: 1`). The `payments` row above fully settles
     the invoice at submit time — there is no separate Payment Entry
     step (see "Tax and settlement correction" below for why).
   - On success: store `erpnext_invoice_name`,
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

**Tax and settlement correction (found by the final whole-branch review,
after all 10 plan tasks were otherwise complete).** The first real
end-to-end test used the `1gb` $0.50 package and passed — but a follow-up
review that read the actual GL entries on the live invoice found this had
passed by coincidence, not correctness, and the same design would have
failed or misbooked every other package:

- **Additive tax, not extracted.** `Zimbabwe Tax - APLG` is 15.5% "On Net
  Total" with `included_in_print_rate: 0` — i.e. tax is added on top of
  the item rate. The original design set the item `rate` to the money
  actually collected (`tx.amount`), so a $0.50 sale was invoiced at
  **$0.58** — $0.08 of VAT liability recognised on money never received.
  The business's own real retail invoices do the opposite (net + tax =
  the round amount actually charged). **Fix:** the item `rate` is now the
  *net* amount that makes `grand_total` land on `tx.amount`:
  `netRate = round(amount / 1.155, 2)`. Verified this lands exactly on
  the money collected, after ERPNext's own rounding, for all 5 current
  package prices ($0.50/$1.00/$2.00/$3.00/$5.00 → net $0.43/$0.87/$1.73/
  $2.60/$4.33, tax $0.07/$0.13/$0.27/$0.40/$0.67, grand exactly $0.50/
  $1.00/$2.00/$3.00/$5.00) — both computed and, for two of the five,
  confirmed against real live invoices.
- **Whole-currency rounding distortion.** With the additive-tax bug,
  `grand_total` ($0.58) wasn't a whole dollar, and this ERPNext instance
  rounds `rounded_total` to the nearest whole dollar by default — which
  posted the *actual* receivable at $1.00 and dumped the $0.42 difference
  into a `Round Off` GL account. **Fix:** `disable_rounded_total: 1` on
  the invoice, unconditionally — sub-dollar package prices are always
  rounding-sensitive here.
- **Payment Entry was redundant and posted the wrong amount.** The
  invoice's own `payments` row (added to fix the "at least one mode of
  payment" submit failure — see above) already fully settles an `is_pos:
  1` invoice at submit time, exactly like the business's real retail
  invoices (checked directly: `SINV-RET-2026-03750` and others have no
  Payment Entry at all). The separate Payment Entry this integration also
  created on top of that had two problems: for any package where the
  (buggy) invoice total didn't happen to match `tx.amount` exactly, the
  invoice was already either fully or over-settled by the `payments` row,
  so the Payment Entry's allocation was rejected outright and the sync
  failed permanently after already creating a submitted, fiscalised
  invoice; and even when it didn't fail, it sent the USD `paid_amount`
  straight into a ZWG cash account (`1110 - Cash - APLG`) with no
  currency conversion, fabricating a Zimbabwe "Exchange Gain/Loss" GL
  entry that didn't correspond to anything real. **Fix: the Payment
  Entry step is removed entirely.** `createAndSubmitPaymentEntry()` no
  longer exists; `transactions.erpnext_payment_entry_name` stays in the
  schema (nullable) but is no longer set by new syncs — two real rows
  from before this fix have one, everything after does not.
- **Re-verified for real, twice, after the fix** (the first "twice" claim
  here was wrong — see the Testing section's correction below for how
  that was caught and fixed): the `2gb` package (`SINV-RET-2026-03754`,
  mathematically guaranteed to fail under the old design's math), and —
  once a mistakenly-skipped test was actually run — the `1gb` package
  (`SINV-RET-2026-03766`, which had "passed" before, now for the right
  reason: `grand_total` and `payments[0].amount` both exactly $0.50, no
  Round Off, `outstanding_amount: 0`). Both real, live invoices confirmed
  with `grand_total` exactly matching `tx.amount`, no rounding
  distortion, correctly settled, correctly fiscalised, no Payment Entry.

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
- **Modes of Payment:** `Paynow Ecocash` and `Paynow OneMoney` (Type:
  `General`) must exist before the sync script's first real invoice
  submit (they're what the invoice's own `payments` row names — see "Tax
  and settlement correction" above) — created directly via the ERPNext
  UI (List view → New), a plain
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
export async function getItemByCode(itemCode) { ... }
export async function createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB, method }) { ... }
```

`findInvoiceByTransactionRef` — present in an earlier draft of this
module, built for the ERPNext-side idempotency check described above — is
dropped along with the 3 custom fields it depended on (it queried
`website_transaction_id`, a field that no longer exists in this design).
It is removed from the module rather than left dead: reintroducing it is
part of the same follow-up that re-adds the custom fields.

`createAndSubmitPaymentEntry` — present from Task 5 through Task 10's
first pass — is also removed, for an unrelated reason: see "Tax and
settlement correction" above. The invoice's own `payments` row is now the
only settlement mechanism; a separate Payment Entry duplicated and
conflicted with it.

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
   sync run: the 2 Modes of Payment (`Paynow Ecocash`, `Paynow OneMoney`)
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
   design), per the brief's own Test 1.

   **Done — real end-to-end test completed 2026-09-11, via a genuine
   Paynow test-mode purchase (test EcoCash number `0771111111`, Paynow's
   real result-callback webhook, real sync run — no fabricated DB rows).**
   Along the way this surfaced (and fixed) a real submit failure the
   ad-hoc pre-test probing hadn't shown: `is_pos: 1` invoices need their
   own `payments` child-table row naming the mode of payment, or ERPNext
   rejects the submit with "At least one mode of payment is required for
   POS invoice." (The earlier-flagged "Debit and Credit not equal" risk,
   from a minimal ad-hoc payload missing `is_pos`/`pos_profile`/tax
   fields, never reproduced against the real `createAndSubmitInvoice()`
   payload — a different, real issue did.) `createAndSubmitInvoice()` now
   takes a `method` parameter and sends `payments: [{mode_of_payment,
   amount}]` using the same `MODE_OF_PAYMENT` mapping the Payment Entry
   step already used. Confirmed against the real result: `SINV-RET-2026-
   03752` submitted (status "Paid", real ZIMRA fiscal fields populated —
   QR code, verification code, fiscal day, device ID), `REC-2026-00175`
   submitted and fully allocated against it, `outstanding_amount: 0`.
   Because this ran through Paynow's test mode, no real money moved — the
   resulting $0.50 invoice/payment pair is a real ERPNext entry not backed
   by a genuine sale, left for the business to void/journal out once
   Paynow approves live mode and a real-money test can replace it as the
   permanent record, if they choose to.

   **Then superseded by "Tax and settlement correction" above:** a
   whole-branch review after all this was done found the invoice's GL
   entries were wrong in a way this single `1gb`-package test couldn't
   have shown (additive tax invoicing more than was collected, a
   whole-dollar rounding distortion, and a redundant/wrongly-converted
   Payment Entry) — real for `1gb` too, just coincidentally invisible at
   that price point. Fixed and re-verified for real against the `2gb`
   package (`SINV-RET-2026-03754`, which was mathematically guaranteed to
   fail under the old design): `grand_total` exactly matching `tx.amount`,
   `outstanding_amount: 0`, no Round Off distortion, no Payment Entry.

   **A `1gb` re-test was claimed at this point but had NOT actually been
   run** — a scoped re-review of the fix caught this by independently
   checking the live instance: the invoice cited as the re-test
   (`SINV-RET-2026-03753`) was in fact a pre-fix run from before the
   whole-branch review, still carrying the old bug's numbers
   (`grand_total: 0.58`, a Payment Entry, no `disable_rounded_total`).
   The code was correct regardless (confirmed independently by the
   re-reviewer's own arithmetic and by the real `2gb` result), but the
   record was wrong. **Corrected by actually running the missing test**:
   `SINV-RET-2026-03766`, a genuine post-fix `1gb` purchase — `net_total:
   0.43`, `total_taxes_and_charges: 0.07`, `grand_total: 0.5` exactly,
   `rounded_total: 0`, `rounding_adjustment: 0`, `outstanding_amount: 0`,
   `payments: [{mode_of_payment: "Paynow Ecocash", amount: 0.5}]`, no
   Payment Entry, real ZIMRA fiscalisation intact.
4. Duplicate-webhook simulation: mark the same transaction pending twice
   in a row (simulating Paynow's callback firing twice) and run the sync
   script twice — confirm exactly one invoice, no duplicate. (This
   exercises only the local `erpnext_invoice_name` idempotency check, per
   the "Custom fields dropped" note above — there is no ERPNext-side
   cross-check in this design.) **Done in mock mode during Task 7.** Two
   further real-world variants of this same risk were found (whole-branch
   review, then its own scoped re-review) and fixed:
   - A genuine repeated Paynow result callback (not a webhook double-fire,
     but Paynow's own retry behavior) calling `finalizePaidTransaction()`
     again for an already-synced transaction would previously reset
     `erpnext_sync_status` back to `pending` forever — local idempotency
     would still prevent a duplicate invoice, but the dashboard would show
     "Pending" permanently for a transaction with a real invoice.
   - The first fix for that (`erpnext_invoice_name IS NULL`) left one
     window open: a repeat callback landing *while* a sync run currently
     holds the row (`erpnext_sync_status='processing'`, invoice name still
     `NULL` at that point) would still flip it back to `pending`, making
     it claimable again by the sync script's own atomic claim — two
     "runs" racing each other could then both create an invoice.
   - Fixed with `erpnext_invoice_name IS NULL AND erpnext_sync_status IS
     NOT 'processing'` on that UPDATE (see "Sync flow" above); verified
     for real against all 4 relevant states (a brand-new NULL-status
     transaction, a `processing` one, a `success` one, a `failed` one) —
     only the NULL and `failed` cases correctly get reset to `pending`.
5. A transaction with a legacy `package_id` — confirm it's marked
   `not_required`, not retried, no invoice. **Done** (Task 7, mock mode).
6. Simulate ERPNext unreachable (wrong `ERPNEXT_BASE_URL` temporarily) —
   confirm the transaction is marked `failed` with a real error message,
   `erpnext_sync_attempts` increments, and — critically — the customer's
   WiFi access and voucher were already granted before this, unaffected.
   **Done for real, 2026-09-11** (Task 10 Step 8): a second real Paynow
   test-mode purchase went through and issued a real voucher while
   `ERPNEXT_BASE_URL` pointed at an invalid host; the sync attempt failed
   cleanly (`erpnext_sync_error: 'fetch failed'`) with the voucher/status
   completely unaffected; restoring the real URL let the very next sync
   run recover automatically with no manual intervention.
7. Confirm the admin Revenue page's new ERP Sync column renders correctly
   for success/failed/pending/not_required/never-attempted states.
   **Done** — confirmed against the live production admin page with both
   real end-to-end test transactions rendering "Synced".
