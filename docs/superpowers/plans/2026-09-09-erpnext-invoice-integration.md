# ERPNext Invoice Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every successful hotspot purchase creates a real, submitted, paid Sales Invoice (+ Payment Entry) in ERPNext, without ever delaying or risking a customer's actual WiFi access.

**Architecture:** A new `src/services/erpnext.js` client (same shape as the existing `omada.js`/`paynow.js` services) provides the ERPNext operations. `finalizePaidTransaction()` in `pay.js` only marks a transaction `erpnext_sync_status='pending'` — no synchronous ERPNext call in the request path at all. A new recurring script, `scripts/sync-erpnext-invoices.js` (same pattern as the existing `scripts/check-connected-clients.js`), run via cron, does the actual invoice/payment creation with retry/backoff, reusing 5 existing ERPNext Items (never creating Items). The 2 Modes of Payment the sync script depends on are created once, manually, via the ERPNext UI — there is no setup script, because the integration user has no Create permission on Item, Custom Field, or Mode of Payment (confirmed 403 on all three; least-privilege scoping, not a gap to work around). The 3 custom fields originally planned on Sales Invoice are dropped from this integration for now — see spec for the schema-sync blocker.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, `undici` (already a dependency, used for the same TLS/dispatcher pattern as `omada.js`). No test framework — manual verification, matching this project's established convention.

**Spec:** `docs/superpowers/specs/2026-09-09-erpnext-invoice-integration-design.md`

## Global Constraints

- ERPNext base: `https://erp.ai.co.zw`, Frappe 16.32.0 / ERPNext 16.32.3. Auth header: `Authorization: token <ERPNEXT_API_KEY>:<ERPNEXT_API_SECRET>`.
- Company: `Africom Private Ltd ZiG`. Customer: `CASH USD`. Currency: `USD`, `conversion_rate` fetched live from the `Currency Exchange` doctype (latest USD→ZWG rate) — never hardcoded.
- Tax template: `Zimbabwe Tax - APLG` (not the flagged-default `vat output - APLG` — verified against real retail invoices).
- POS Profile: `Contact Centre`, with `custom_fiscalise: 1` (ZIMRA fiscal stand-in, per spec).
- Naming series: `SINV-RET-.YYYY.-`.
- Package → Item mapping (exact, do not reinterpret — all 5 Items already exist in ERPNext; NONE are ever created by this integration): `1gb`→`electroair0.5` ($0.50), `2gb`→`electroair1` ($1.00), `3gb`→`$2 Hotspot Voucher` ($2.00), `5gb`→`$3 Hotspot Voucher` ($3.00), `10gb`→`electroair5` ($5.00). The invoice line `rate` always comes from the package's own price (`pkg.price`), never from the Item's stored `standard_rate`.
- Modes of Payment: `Paynow Ecocash`, `Paynow OneMoney` — created once, manually, via the ERPNext UI by a human with access. Not created by any script or by the integration user (no permission).
- No Custom Fields on Sales Invoice in this integration. The originally-planned `website_transaction_id`/`website_package_id`/`payment_gateway` fields are dropped: the integration user cannot create Custom Fields (403), and even after a human created them via the ERPNext UI, the underlying DB column never synced (needs a server-side `bench migrate` nobody currently has access to run) — writing to them 500s the entire invoice create. Idempotency is local-only (`transactions.erpnext_invoice_name`).
- Legacy package ids (`quick`/`day`/`week`/`month`) are never synced — marked `not_required` on first attempt.
- ERP sync is NEVER synchronous in the payment/WiFi-activation request path. It only ever happens in the recurring sync script.
- Credentials (`ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`) never logged, never sent to the frontend, never committed to git.
- No Item, Custom Field, or Mode of Payment creation anywhere in this codebase's code — confirmed via real API tests that the integration user gets 403 on Create for all three; this is intentional least-privilege scoping to preserve. Never request broader permissions or use Administrator credentials to work around it.

---

### Task 1: ERPNext client foundation — config, auth, generic request helper, exchange rate

**Files:**
- Modify: `src/config.js` (add an `erpnext` block, same shape as the existing `omada`/`paynow` blocks)
- Create: `src/services/erpnext.js`

**Interfaces:**
- Produces: `config.erpnext = { baseUrl, apiKey, apiSecret }` (from `ERPNEXT_BASE_URL`/`ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET`)
- Produces (in `erpnext.js`): `erpRequest(method, path, body?)` → parsed JSON response body (throws with the real ERPNext error message on any non-2xx or `exception` in the response). `getLatestExchangeRate(from, to)` → `{ rate: number, date: string }`.

- [ ] **Step 1: Add the `erpnext` block to `src/config.js`**

Add this to the `config` object, alongside the existing `paynow`/`omada`/`admin` blocks (same file, same pattern — string envs default to `''`):

```javascript
  erpnext: {
    baseUrl: (process.env.ERPNEXT_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.ERPNEXT_API_KEY || '',
    apiSecret: process.env.ERPNEXT_API_SECRET || '',
  },
```

- [ ] **Step 2: Add the 3 new keys to `.env.example`**, in a new section after the existing `## ── Admin dashboard` section:

```
# ── ERPNext (Africom accounting integration) ──
# Existing integration user: hotspot.integration@afri-com.net
# Get these from whoever manages that user in ERPNext — do not create a new user.
ERPNEXT_BASE_URL=https://erp.ai.co.zw
ERPNEXT_API_KEY=your_api_key
ERPNEXT_API_SECRET=your_api_secret
```

- [ ] **Step 3: Create `src/services/erpnext.js`**

```javascript
import { Agent } from 'undici';
import { config } from '../config.js';

// erp.ai.co.zw has a normal public TLS cert (unlike the self-signed local
// Omada controller), so this dispatcher does not need to relax TLS — it
// exists only because Node's built-in fetch() is undici-based and needs an
// explicit dispatcher for consistency with how omada.js already works.
const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });

function authHeader() {
  return { Authorization: `token ${config.erpnext.apiKey}:${config.erpnext.apiSecret}` };
}

/**
 * Low-level ERPNext REST call. All ERPNext HTTP interaction in this project
 * goes through this one function — never scatter raw fetch() calls to
 * erp.ai.co.zw elsewhere in the codebase.
 */
export async function erpRequest(method, path, body) {
  const res = await fetch(`${config.erpnext.baseUrl}${path}`, {
    method,
    dispatcher,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || (data && data.exception)) {
    const message = data?.exception || data?.message || `HTTP ${res.status}`;
    throw new Error(`ERPNext request failed [${method} ${path}]: ${message}`);
  }

  return data;
}

/**
 * Fetches the most recent stored exchange rate between two currencies from
 * ERPNext's own Currency Exchange doctype — this project never computes or
 * caches its own rate.
 */
export async function getLatestExchangeRate(from, to) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext exchange rate ${from}->${to}: 1.0 (mock)`);
    return { rate: 1, date: new Date().toISOString().slice(0, 10) };
  }

  const filters = encodeURIComponent(JSON.stringify([
    ['from_currency', '=', from],
    ['to_currency', '=', to],
  ]));
  const fields = encodeURIComponent(JSON.stringify(['name', 'date', 'exchange_rate']));
  const data = await erpRequest(
    'GET',
    `/api/resource/Currency Exchange?filters=${filters}&fields=${fields}&order_by=date desc&limit_page_length=1`
  );

  const row = data?.data?.[0];
  if (!row) {
    throw new Error(`No Currency Exchange rate found for ${from}->${to}`);
  }
  return { rate: row.exchange_rate, date: row.date };
}
```

- [ ] **Step 4: Verify manually**

Run: `node -e "
import('./src/config.js').then(({config}) => console.log('erpnext config keys:', Object.keys(config.erpnext)));
"` — expect `['baseUrl', 'apiKey', 'apiSecret']`.

Run (mock mode): `MOCK_MODE=true node -e "
import('./src/services/erpnext.js').then(async ({getLatestExchangeRate}) => {
  console.log(await getLatestExchangeRate('USD', 'ZWG'));
});
"` — expect a `[MOCK]` log line and `{ rate: 1, date: '...' }`, no real HTTP call.

Real credentials (this project already has `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` values from the design phase — put them in `.env` now if not already there): `MOCK_MODE=false node -e "
import('./src/services/erpnext.js').then(async ({getLatestExchangeRate}) => {
  console.log(await getLatestExchangeRate('USD', 'ZWG'));
});
"` — expect a real `{ rate: <number close to 26>, date: '<today or recent>' }`. Do NOT print the API secret anywhere in your report — only the function's return value.

- [ ] **Step 5: Commit**

```bash
git add src/config.js .env.example src/services/erpnext.js
git commit -m "feat: add ERPNext API client foundation and exchange rate lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: ERPNext client — invoice lookup and item validation

> **Correction (post-implementation, architecture ruling):** this task's
> code was implemented and committed as originally written, including
> `findInvoiceByTransactionRef`. That function is now dropped — see the
> Global Constraints and the spec's "Custom fields dropped" section. The
> function queried the `website_transaction_id` custom field, which never
> got a real database column (confirmed via direct testing); the
> ERPNext-side idempotency cross-check it existed for is retired along
> with it. `getItemByCode` is unaffected and remains in use (Task 7 uses
> it as a pre-flight existence check on the mapped Item Code, never to
> create one). The removal of `findInvoiceByTransactionRef` is folded into
> Task 4's corrective edit below rather than given its own task.

**Files:**
- Modify: `src/services/erpnext.js`

**Interfaces:**
- Consumes: `erpRequest` (Task 1)
- Produces: `findInvoiceByTransactionRef(reference)` → the invoice `name` string if found, else `null`. `getItemByCode(itemCode)` → `true`/`false` (does this Item exist).

- [ ] **Step 1: Add these two functions to `src/services/erpnext.js`** (after `getLatestExchangeRate`)

```javascript
/**
 * Idempotency safety net: looks up an existing Sales Invoice by the
 * website_transaction_id custom field (created by scripts/setup-erpnext.js).
 * Returns the invoice name if one already exists for this transaction
 * reference, or null. Used before creating a new invoice so a crash between
 * "ERPNext created it" and "we recorded that locally" can't double-invoice.
 */
export async function findInvoiceByTransactionRef(reference) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext lookup invoice for transaction: ${reference}`);
    return null;
  }

  const filters = encodeURIComponent(JSON.stringify([
    ['website_transaction_id', '=', reference],
  ]));
  const data = await erpRequest(
    'GET',
    `/api/resource/Sales Invoice?filters=${filters}&fields=["name"]&limit_page_length=1`
  );
  return data?.data?.[0]?.name || null;
}

/**
 * Confirms a mapped Item Code actually exists in ERPNext before the sync
 * script attempts to invoice against it — a missing Item should fail
 * clearly, not silently create a broken invoice line.
 */
export async function getItemByCode(itemCode) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext lookup item: ${itemCode}`);
    return true;
  }

  const data = await erpRequest('GET', `/api/resource/Item/${encodeURIComponent(itemCode)}`).catch((err) => {
    if (String(err.message).includes('404')) return null;
    throw err;
  });
  return !!data?.data;
}
```

- [ ] **Step 2: Verify manually**

Mock mode: `MOCK_MODE=true node -e "
import('./src/services/erpnext.js').then(async (m) => {
  console.log(await m.findInvoiceByTransactionRef('FSW-test-123'));
  console.log(await m.getItemByCode('HOTSPOT-1GB-1D'));
});
"` — expect `null` then `true`, with `[MOCK]` log lines.

Real credentials: `MOCK_MODE=false node -e "
import('./src/services/erpnext.js').then(async (m) => {
  console.log('invoice lookup (should be null, no such transaction yet):', await m.findInvoiceByTransactionRef('FSW-nonexistent-ref-xyz'));
  console.log('item lookup (should be false, not created until Task 6):', await m.getItemByCode('HOTSPOT-1GB-1D'));
});
"` — the invoice lookup should return `null` cleanly (not an error — the custom field doesn't exist in ERPNext yet at this point in the plan, so if this errors instead of returning null/empty, note that in your report as a concern rather than silently treating it as pass, since it means the filter query needs different handling for a not-yet-existing custom field).

- [ ] **Step 3: Commit**

```bash
git add src/services/erpnext.js
git commit -m "feat: add ERPNext invoice lookup and item validation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Database migration — ERP sync columns on `transactions`

**Files:**
- Modify: `src/db/index.js` (`initSchema()`)

**Interfaces:**
- Produces: 8 new nullable columns on `transactions`: `erpnext_customer`, `erpnext_invoice_name`, `erpnext_payment_entry_name`, `erpnext_sync_status`, `erpnext_sync_attempts` (INTEGER DEFAULT 0), `erpnext_last_sync_attempt`, `erpnext_synced_at`, `erpnext_sync_error`.

- [ ] **Step 1: Add a guarded migration block**, following the exact same pattern as the existing `vouchers.data_bytes` migration already in this function — add this right after that existing block:

```javascript
  const txCols = db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name);
  const newTxCols = {
    erpnext_customer: 'TEXT',
    erpnext_invoice_name: 'TEXT',
    erpnext_payment_entry_name: 'TEXT',
    erpnext_sync_status: 'TEXT',
    erpnext_sync_attempts: 'INTEGER DEFAULT 0',
    erpnext_last_sync_attempt: 'TEXT',
    erpnext_synced_at: 'TEXT',
    erpnext_sync_error: 'TEXT',
  };
  for (const [col, type] of Object.entries(newTxCols)) {
    if (!txCols.includes(col)) {
      db.exec(`ALTER TABLE transactions ADD COLUMN ${col} ${type}`);
    }
  }
```

- [ ] **Step 2: Verify manually**

```bash
npm run init-db
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
  console.log(cols);
});
"
npm run init-db
```

Expected: the printed column list includes all 8 new columns. The second `npm run init-db` run must not error (idempotency).

- [ ] **Step 3: Commit**

```bash
git add src/db/index.js
git commit -m "feat: add ERP sync tracking columns to transactions table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: ERPNext client — create and submit a Sales Invoice

> **Correction (post-implementation, architecture ruling):** this task
> was originally implemented with 3 extra fields on the create payload —
> `website_transaction_id`, `website_package_id`, `payment_gateway` — for
> the custom fields Task 6 was going to create. Those custom fields are
> now dropped from this integration entirely (see Global Constraints):
> the underlying DB columns never got created even after a human made the
> Custom Field records via the ERPNext UI (confirmed 500
> `Unknown column` on write), and the integration user can't create
> Custom Fields itself (403) to try again a different way. **Corrective
> edit required on the already-committed code:** remove those 3 fields
> from the request body below — this is the one code change this
> correction requires; nothing else in this task changes.

**Files:**
- Modify: `src/services/erpnext.js`

**Interfaces:**
- Consumes: `erpRequest`, `getLatestExchangeRate` (Task 1)
- Produces: `createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB })` → the invoice `name` string.

- [ ] **Step 1: Add this function to `src/services/erpnext.js`** (shown here in corrected form — no `website_transaction_id`/`website_package_id`/`payment_gateway` fields)

```javascript
const COMPANY = 'Africom Private Ltd ZiG';
const CUSTOMER = 'CASH USD';
const TAX_TEMPLATE = 'Zimbabwe Tax - APLG';
const POS_PROFILE = 'Contact Centre';

/**
 * Creates a Sales Invoice for one hotspot package purchase and submits it.
 * Frappe's REST API creates a document as a draft (docstatus 0); submission
 * is a separate PUT setting docstatus to 1, which is what actually triggers
 * ERPNext's submit-time validation/side-effects (including, per the real
 * invoices inspected during design, ZIMRA fiscalisation).
 *
 * `packageId` and `dataGB` are accepted but currently unused in the request
 * body — they were going to populate `website_package_id` and a data-size
 * note on the custom fields dropped from this integration (see Global
 * Constraints). Kept in the signature/call site so Task 7 doesn't need to
 * change again when the custom-field follow-up lands.
 */
export async function createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB }) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext create+submit invoice: ref=${reference} item=${itemCode} amount=${amount}`);
    return `MOCK-SINV-${reference}`;
  }

  const { rate } = await getLatestExchangeRate('USD', 'ZWG');

  const draft = await erpRequest('POST', '/api/resource/Sales Invoice', {
    naming_series: 'SINV-RET-.YYYY.-',
    customer: CUSTOMER,
    company: COMPANY,
    currency: 'USD',
    conversion_rate: rate,
    is_pos: 1,
    pos_profile: POS_PROFILE,
    custom_fiscalise: 1,
    taxes_and_charges: TAX_TEMPLATE,
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: amount,
      },
    ],
  });

  const invoiceName = draft?.data?.name;
  if (!invoiceName) {
    throw new Error(`ERPNext invoice creation returned no name for reference ${reference}`);
  }

  await erpRequest('PUT', `/api/resource/Sales Invoice/${encodeURIComponent(invoiceName)}`, {
    docstatus: 1,
  });

  return invoiceName;
}
```

- [ ] **Step 2: Verify manually — mock mode only for this step**

`MOCK_MODE=true node -e "
import('./src/services/erpnext.js').then(async (m) => {
  console.log(await m.createAndSubmitInvoice({ reference: 'FSW-test-1', packageId: '1gb', itemCode: 'HOTSPOT-1GB-1D', amount: 0.5, dataGB: 1 }));
});
"` — expect a `[MOCK]` log line and a `MOCK-SINV-FSW-test-1` return value, no real HTTP call.

Do not run this against real credentials as part of this task — a real call creates a real draft/submitted Sales Invoice in the live company books, which should happen deliberately, once, as part of Task 7's end-to-end verification (now that the mapped Items — `electroair0.5` etc. — already exist and need no setup step), not as a side effect of testing this function in isolation.

- [ ] **Step 3: Commit**

```bash
git add src/services/erpnext.js
git commit -m "feat: add ERPNext Sales Invoice creation and submission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: ERPNext client — create and submit a Payment Entry

**Files:**
- Modify: `src/services/erpnext.js`

**Interfaces:**
- Consumes: `erpRequest` (Task 1)
- Produces: `createAndSubmitPaymentEntry({ invoiceName, amount, method, reference })` → the Payment Entry `name` string. `method` is `'ecocash'` or `'onemoney'` (matches this project's existing `transactions.method` values).

- [ ] **Step 1: Add this function to `src/services/erpnext.js`**

```javascript
const MODE_OF_PAYMENT = {
  ecocash: 'Paynow Ecocash',
  onemoney: 'Paynow OneMoney',
};

/**
 * Creates and submits a Payment Entry against an already-submitted Sales
 * Invoice, marking it paid. `paid_to` (which GL account the money lands in)
 * is intentionally NOT hardcoded here — it's read from the Mode of
 * Payment's own account mapping for this company, which Finance configures
 * directly in ERPNext (Mode of Payment is created manually via the ERPNext
 * UI — see the spec's "One-time ERPNext setup" section; there is no setup
 * script). If that mapping is missing, this throws a clear, actionable
 * error rather than guessing an account.
 */
export async function createAndSubmitPaymentEntry({ invoiceName, amount, method, reference }) {
  const modeOfPayment = MODE_OF_PAYMENT[method] || MODE_OF_PAYMENT.ecocash;

  if (config.mockMode) {
    console.log(`[MOCK] ERPNext create+submit payment entry: invoice=${invoiceName} mode=${modeOfPayment} amount=${amount}`);
    return `MOCK-PE-${reference}`;
  }

  const modeDoc = await erpRequest('GET', `/api/resource/Mode of Payment/${encodeURIComponent(modeOfPayment)}?fields=["name","accounts"]`);
  const accountRow = (modeDoc?.data?.accounts || []).find((a) => a.company === COMPANY);
  if (!accountRow || !accountRow.default_account) {
    throw new Error(
      `Mode of Payment "${modeOfPayment}" has no default account configured for company "${COMPANY}" — ` +
      `configure this in ERPNext (Mode of Payment > Accounts) before Payment Entries can be created.`
    );
  }

  const invoiceDoc = await erpRequest('GET', `/api/resource/Sales Invoice/${encodeURIComponent(invoiceName)}?fields=["debit_to"]`);
  const receivableAccount = invoiceDoc?.data?.debit_to;
  if (!receivableAccount) {
    throw new Error(`Could not read receivable account (debit_to) from invoice ${invoiceName}`);
  }

  const draft = await erpRequest('POST', '/api/resource/Payment Entry', {
    payment_type: 'Receive',
    party_type: 'Customer',
    party: CUSTOMER,
    company: COMPANY,
    mode_of_payment: modeOfPayment,
    paid_from: receivableAccount,
    paid_to: accountRow.default_account,
    paid_amount: amount,
    received_amount: amount,
    reference_no: reference,
    reference_date: new Date().toISOString().slice(0, 10),
    references: [
      {
        reference_doctype: 'Sales Invoice',
        reference_name: invoiceName,
        allocated_amount: amount,
      },
    ],
  });

  const peName = draft?.data?.name;
  if (!peName) {
    throw new Error(`ERPNext Payment Entry creation returned no name for invoice ${invoiceName}`);
  }

  await erpRequest('PUT', `/api/resource/Payment Entry/${encodeURIComponent(peName)}`, {
    docstatus: 1,
  });

  return peName;
}
```

Note: `COMPANY` and `CUSTOMER` are already defined as module-level constants in Task 4 — do not redeclare them.

- [ ] **Step 2: Verify manually — mock mode only**

`MOCK_MODE=true node -e "
import('./src/services/erpnext.js').then(async (m) => {
  console.log(await m.createAndSubmitPaymentEntry({ invoiceName: 'MOCK-SINV-test', amount: 0.5, method: 'ecocash', reference: 'FSW-test-1' }));
});
"` — expect a `[MOCK]` log line and a `MOCK-PE-FSW-test-1` return value.

Real-credential testing happens in Task 7, after the 2 Modes of Payment exist (created manually via the ERPNext UI — see Task 6) and have their account mapping configured (which requires Finance's input — flag this explicitly if you reach Task 7 and the account mapping isn't set yet; don't guess an account).

- [ ] **Step 3: Commit**

```bash
git add src/services/erpnext.js
git commit -m "feat: add ERPNext Payment Entry creation and submission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: One-time ERPNext setup — verify, don't create

> **Correction (post-implementation, architecture ruling):** this task was
> originally a setup *script* that created 5 Items, 3 Custom Fields, and 2
> Modes of Payment via the integration user's credentials. Real testing
> found the integration user gets 403 (Create) on all three doctypes —
> confirmed, not assumed, and confirmed as intentional least-privilege
> scoping by Africom's ERPNext admin, not a gap to patch by requesting
> more access. The corrected task has no script and no code to write:
> Items already exist and are reused as-is (no creation, ever); Custom
> Fields are dropped from this integration entirely (see Global
> Constraints); Modes of Payment are created once, manually, by a human
> with ERPNext UI access. This task is now a verification checklist plus
> one human action outside this codebase.

**Files:** none (no code changes in this task).

**Interfaces:**
- Consumes: `getItemByCode` (Task 2) for the verification step below.
- Produces: nothing new — confirms the preconditions Task 7 depends on.

- [ ] **Step 1: Confirm the 5 mapped Items are readable with real credentials**

```bash
MOCK_MODE=false node -e "
import('./src/services/erpnext.js').then(async (m) => {
  for (const code of ['electroair0.5', 'electroair1', '\$2 Hotspot Voucher', '\$3 Hotspot Voucher', 'electroair5']) {
    console.log(code, '→', await m.getItemByCode(code));
  }
});
"
```

Expected: `true` for all 5. If any come back `false`, stop — report the
missing Item Code rather than creating one (this integration has no Item
Create permission, and creating one is a decision for whoever owns the
ERPNext chart of items, not this integration).

- [ ] **Step 2: Human action (outside this codebase) — create the 2 Modes of Payment**

Someone with ERPNext UI write access (not the integration user) opens
ERPNext, searches **"Mode of Payment"**, and creates two records via
**New**:
1. **Mode of Payment:** `Paynow Ecocash`, **Type:** `General`
2. **Mode of Payment:** `Paynow OneMoney`, **Type:** `General`

This is a plain record insert — unlike Custom Field, Mode of Payment has
no schema-sync complication; the record is immediately usable.

- [ ] **Step 3: Confirm both Modes of Payment are readable with real credentials**

```bash
MOCK_MODE=false node -e "
import('./src/services/erpnext.js').then(async (m) => {
  const r1 = await m.erpRequest('GET', '/api/resource/Mode of Payment/Paynow Ecocash').catch(e => e.message);
  const r2 = await m.erpRequest('GET', '/api/resource/Mode of Payment/Paynow OneMoney').catch(e => e.message);
  console.log('Paynow Ecocash:', r1?.data ? 'exists' : r1);
  console.log('Paynow OneMoney:', r2?.data ? 'exists' : r2);
});
"
```

(`erpRequest` needs to be exported from `src/services/erpnext.js` for this
one-off check — if it isn't already, export it; it's the same generic
helper every other function in the module already uses internally.)

Expected: both `exists`. Their account mapping (which GL account money
lands in) does not need to be configured yet for this step — only for
Task 7's real Payment Entry test — but flag to Finance if it's still
missing when you reach that point.

- [ ] **Step 4: No commit** — this task changes no files. Record in the
  SDD ledger that Task 6 completed as a verification-only task, with the
  real output of Steps 1 and 3.

---

### Task 7: The recurring sync script

**Files:**
- Create: `scripts/sync-erpnext-invoices.js`

**Interfaces:**
- Consumes: `getItemByCode`, `createAndSubmitInvoice`, `createAndSubmitPaymentEntry` (Tasks 2, 4, 5); `getPackage` (`src/packages.js`, already exists); `db` (`src/db/index.js`, already exists)

- [ ] **Step 1: Create `scripts/sync-erpnext-invoices.js`**

```javascript
import { db } from '../src/db/index.js';
import { getPackage } from '../src/packages.js';
import {
  getItemByCode,
  createAndSubmitInvoice,
  createAndSubmitPaymentEntry,
} from '../src/services/erpnext.js';

// Backoff schedule by attempt count (minutes before the next retry is eligible).
const BACKOFF_MINUTES = [1, 5, 15, 15, 15]; // index = erpnext_sync_attempts (0-based)
const MAX_ATTEMPTS = 5;
// A row stuck in 'processing' longer than this was claimed by a run that
// crashed/died without finishing — safe to reclaim rather than orphan it
// forever (the candidates query below includes this case explicitly).
const STALE_PROCESSING_MINUTES = 10;

function isEligibleForRetry(tx) {
  if (!tx.erpnext_last_sync_attempt) return true;
  const attempts = tx.erpnext_sync_attempts || 0;
  const waitMinutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
  const nextEligible = new Date(tx.erpnext_last_sync_attempt).getTime() + waitMinutes * 60 * 1000;
  return Date.now() >= nextEligible;
}

/**
 * Atomically claims a transaction for this run by flipping its status to
 * 'processing' — an UPDATE ... WHERE guarded on the status it expects to
 * find, so two overlapping sync script runs (e.g. cron firing again while a
 * prior run is still active because ERPNext was slow) can't both claim the
 * same row and create two invoices for one payment. Returns true if this
 * call actually claimed it, false if something else already did.
 */
function claim(tx) {
  const result = db
    .prepare(
      `UPDATE transactions SET erpnext_sync_status='processing', erpnext_last_sync_attempt=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND erpnext_sync_status=?`
    )
    .run(tx.id, tx.erpnext_sync_status);
  return result.changes === 1;
}

async function syncOne(tx) {
  // Idempotency: already has an invoice recorded locally. This is the ONLY
  // idempotency check in this design — the original plan also cross-checked
  // ERPNext directly via a website_transaction_id custom field, but that
  // field is dropped from this integration (see Global Constraints; the DB
  // column never synced even after a human created the Custom Field record
  // via the ERPNext UI). The accepted gap: a crash between "ERPNext created
  // the invoice" and "we recorded that locally" could produce a duplicate
  // invoice on retry. Given this business's transaction volume and the
  // atomic claim below (which already prevents the much more likely
  // double-processing case — two overlapping cron runs), this is a
  // documented, accepted risk, not a silent one.
  if (tx.erpnext_invoice_name) return 'already-synced';

  if (!claim(tx)) return 'claimed-by-another-run';

  const pkg = getPackage(tx.package_id);
  if (!pkg || !pkg.dataGB) {
    // No Item mapping exists for a legacy (pre-data-quota) package — never
    // synced, never retried.
    db.prepare(
      `UPDATE transactions SET erpnext_sync_status='not_required', updated_at=datetime('now') WHERE id=?`
    ).run(tx.id);
    return 'not-required';
  }

  const itemCode = {
    '1gb': 'electroair0.5',
    '2gb': 'electroair1',
    '3gb': '$2 Hotspot Voucher',
    '5gb': '$3 Hotspot Voucher',
    '10gb': 'electroair5',
  }[tx.package_id];

  try {
    const exists = await getItemByCode(itemCode);
    if (!exists) {
      throw new Error(`Item ${itemCode} does not exist in ERPNext — this integration never creates Items, so this means the Item was renamed or removed on the ERPNext side; fix the mapping or the Item, don't create a replacement here`);
    }

    const invoiceName = await createAndSubmitInvoice({
      reference: tx.reference,
      packageId: tx.package_id,
      itemCode,
      amount: tx.amount,
      dataGB: pkg.dataGB,
    });

    const paymentEntryName = await createAndSubmitPaymentEntry({
      invoiceName,
      amount: tx.amount,
      method: tx.method,
      reference: tx.reference,
    });

    db.prepare(
      `UPDATE transactions SET
         erpnext_customer='CASH USD',
         erpnext_invoice_name=?,
         erpnext_payment_entry_name=?,
         erpnext_sync_status='success',
         erpnext_synced_at=datetime('now'),
         updated_at=datetime('now')
       WHERE id=?`
    ).run(invoiceName, paymentEntryName, tx.id);
    return 'success';
  } catch (err) {
    db.prepare(
      `UPDATE transactions SET
         erpnext_sync_status='failed',
         erpnext_sync_attempts=COALESCE(erpnext_sync_attempts,0)+1,
         erpnext_last_sync_attempt=datetime('now'),
         erpnext_sync_error=?,
         updated_at=datetime('now')
       WHERE id=?`
    ).run(String(err.message).slice(0, 500), tx.id);
    return 'failed';
  }
}

async function main() {
  const candidates = db
    .prepare(
      `SELECT * FROM transactions
       WHERE (erpnext_sync_status IN ('pending','failed')
              AND COALESCE(erpnext_sync_attempts,0) < ?)
          OR (erpnext_sync_status='processing'
              AND erpnext_last_sync_attempt < datetime('now', ?))
       ORDER BY created_at ASC`
    )
    .all(MAX_ATTEMPTS, `-${STALE_PROCESSING_MINUTES} minutes`);

  const counts = { attempted: 0, success: 0, failed: 0, skipped: 0, other: 0 };

  for (const tx of candidates) {
    if (tx.erpnext_sync_status === 'failed' && !isEligibleForRetry(tx)) {
      counts.skipped++;
      continue;
    }
    counts.attempted++;
    const result = await syncOne(tx);
    if (result === 'success') counts.success++;
    else if (result === 'failed') counts.failed++;
    else if (result === 'claimed-by-another-run') counts.skipped++;
    else counts.other++;
  }

  console.log(
    `[erpnext-sync] candidates=${candidates.length} attempted=${counts.attempted} success=${counts.success} failed=${counts.failed} skipped=${counts.skipped} other=${counts.other}`
  );
}

main().catch((err) => {
  console.error('[erpnext-sync] fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script entry to `package.json`**

```json
    "sync-erpnext": "node scripts/sync-erpnext-invoices.js",
```

- [ ] **Step 3: Verify manually — mock mode, synthetic transaction**

```bash
MOCK_MODE=true node -e "
import('./src/db/index.js').then(({db}) => {
  db.prepare(\`INSERT INTO transactions (reference, package_id, amount, phone, method, status, erpnext_sync_status)
    VALUES ('FSW-plan-test-1', '1gb', 0.50, '0771234567', 'ecocash', 'paid', 'pending')\`).run();
  console.log('inserted');
});
"
MOCK_MODE=true npm run sync-erpnext
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  console.log(db.prepare(\"SELECT reference, erpnext_sync_status, erpnext_invoice_name, erpnext_payment_entry_name FROM transactions WHERE reference='FSW-plan-test-1'\").get());
});
"
```

Expected: the sync run logs `[MOCK]` lines for the invoice/payment creation, the summary line shows `success=1`, and the final query shows `erpnext_sync_status: 'success'` with mock invoice/payment-entry names (`MOCK-SINV-...`/`MOCK-PE-...`).

- [ ] **Step 4: Verify manually — a legacy package_id is marked not_required**

```bash
MOCK_MODE=true node -e "
import('./src/db/index.js').then(({db}) => {
  db.prepare(\`INSERT INTO transactions (reference, package_id, amount, phone, method, status, erpnext_sync_status)
    VALUES ('FSW-plan-test-legacy', 'day', 2.00, '0771234567', 'ecocash', 'paid', 'pending')\`).run();
});
"
MOCK_MODE=true npm run sync-erpnext
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  console.log(db.prepare(\"SELECT reference, erpnext_sync_status FROM transactions WHERE reference='FSW-plan-test-legacy'\").get());
});
"
```

Expected: `erpnext_sync_status: 'not_required'`, and it does NOT appear as a candidate on a subsequent run (only `pending`/`failed` are queried).

- [ ] **Step 5: Verify manually — duplicate-run idempotency**

Run `MOCK_MODE=true npm run sync-erpnext` a second time right after Step 3 (with the `FSW-plan-test-1` row now `success`). Expected: the candidates query returns 0 rows for that reference (it's no longer `pending`/`failed`), confirming it won't be re-processed.

- [ ] **Step 6: Verify manually — concurrent-claim protection (the fix from self-review)**

Insert a transaction stuck mid-way, simulating a crashed prior run:

```bash
node -e "
import('./src/db/index.js').then(({db}) => {
  db.prepare(\`INSERT INTO transactions (reference, package_id, amount, phone, method, status, erpnext_sync_status, erpnext_last_sync_attempt)
    VALUES ('FSW-plan-test-stuck', '1gb', 0.50, '0771234567', 'ecocash', 'paid', 'processing', datetime('now'))\`).run();
});
"
MOCK_MODE=true npm run sync-erpnext
```

Expected: the summary line shows this row was skipped (not reclaimed — its `erpnext_last_sync_attempt` is recent, under the 10-minute staleness threshold). Now backdate it to simulate a genuinely stuck row:

```bash
node -e "
import('./src/db/index.js').then(({db}) => {
  db.prepare(\`UPDATE transactions SET erpnext_last_sync_attempt=datetime('now','-15 minutes') WHERE reference='FSW-plan-test-stuck'\`).run();
});
"
MOCK_MODE=true npm run sync-erpnext
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  console.log(db.prepare(\"SELECT reference, erpnext_sync_status FROM transactions WHERE reference='FSW-plan-test-stuck'\").get());
});
"
```

Expected: this run reclaims and successfully syncs it (`erpnext_sync_status: 'success'`), confirming stale `processing` rows aren't orphaned forever.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-erpnext-invoices.js package.json
git commit -m "feat: add recurring ERPNext invoice sync script with retry/backoff and atomic claiming

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire the trigger point — mark transactions pending after payment

**Files:**
- Modify: `src/routes/pay.js` (`finalizePaidTransaction`)

**Interfaces:**
- Consumes: nothing new (pure DB write)

- [ ] **Step 1: Add the pending-marking call**

In `finalizePaidTransaction(tx)`, after the existing `authorizeClient`/`markVoucherUsed` try/catch block (i.e., regardless of whether the Omada authorize call succeeded — a customer who paid should get an invoice even if the WiFi authorization step had trouble), add:

```javascript
  db.prepare(
    `UPDATE transactions SET erpnext_sync_status='pending', updated_at=datetime('now') WHERE id=?`
  ).run(tx.id);

  return voucherCode;
```

This replaces the existing bare `return voucherCode;` at the end of the function — the new line goes immediately before it, not as a separate change elsewhere. Read the current end of `finalizePaidTransaction` in `src/routes/pay.js` before editing to place this correctly (it currently ends with the closing brace of the `if (clientInfo.clientMac)` block, then `return voucherCode;` on its own line).

- [ ] **Step 2: Verify manually**

Start the app in mock mode, go through a real purchase in the browser (or replay the curl-based flow from the earlier data-quota-packages plan's Task 5 verification, adapted to a fresh reference), then check:

```bash
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  const row = db.prepare('SELECT reference, status, erpnext_sync_status FROM transactions ORDER BY id DESC LIMIT 1').get();
  console.log(row);
});
"
```

Expected: the most recent transaction shows `status: 'paid'` and `erpnext_sync_status: 'pending'`.

Also confirm the existing purchase flow's response time/behavior is completely unaffected — this one UPDATE statement is synchronous SQLite (already fast, same as every other write in this codebase) and makes no network call, so there should be no observable difference in how quickly the customer sees their voucher.

- [ ] **Step 3: Commit**

```bash
git add src/routes/pay.js
git commit -m "feat: mark transactions pending for ERP sync after payment

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Admin dashboard — ERP sync status column

**Files:**
- Modify: `views/admin/revenue.ejs`
- Modify: `src/services/analytics/revenue.js` (whatever query backs the transaction table(s) on this page — read the file first to find the exact `SELECT` and add `erpnext_sync_status` to its column list; do not guess the function name, read it)

**Interfaces:**
- Consumes: `transactions.erpnext_sync_status` (Task 3)

- [ ] **Step 1: Read `src/services/analytics/revenue.js` and `views/admin/revenue.ejs` in full first**

Identify the exact query (or queries) that produce the rows rendered in the transaction table(s) on this page, and the exact EJS loop that renders each row. Do not proceed to Step 2 until you can point to the specific `SELECT` column list and the specific `<tr>`/`<td>` block.

- [ ] **Step 2: Add `erpnext_sync_status` to the relevant query's column list**

Add `t.erpnext_sync_status` (or `erpnext_sync_status`, matching whatever alias convention the existing query already uses for other `transactions` columns like `status`) to the `SELECT` list you identified in Step 1. Do not change any other column, join, or filter in that query.

- [ ] **Step 3: Add a new "ERP Sync" column to the table**

In `views/admin/revenue.ejs`, add a new `<th>ERP Sync</th>` to the relevant table's header row (immediately after the existing `<th>Status</th>` column, if one exists in that table — if not, after the last existing column), and a matching `<td>` in the row loop:

```html
<td>
  <% if (t.erpnext_sync_status === 'success') { %>
    <span class="badge paid">Synced</span>
  <% } else if (t.erpnext_sync_status === 'failed') { %>
    <span class="badge failed">Failed</span>
  <% } else if (t.erpnext_sync_status === 'pending') { %>
    <span class="badge created">Pending</span>
  <% } else if (t.erpnext_sync_status === 'not_required') { %>
    <span style="color:var(--ink-muted)">—</span>
  <% } else { %>
    <span style="color:var(--ink-muted)">—</span>
  <% } %>
</td>
```

This reuses the existing `.badge`/`.badge.paid`/`.badge.failed`/`.badge.created` CSS classes already defined in `public/style.css` (or `public/dashboard.css` — check which stylesheet this specific admin page actually loads, via its `admin-head.ejs` include, and use whichever classes that stylesheet actually defines; if the admin dashboard's classes differ in name from the guest-portal ones, match what's already used elsewhere on this same page for the existing `Status` column, not what's described above verbatim).

- [ ] **Step 4: Verify manually**

Start the app, log into `/admin`, view the Revenue page. With the two synthetic test transactions still in `data.sqlite` from Task 7's verification (one `success`, one `not_required`), confirm the new column renders "Synced" and "—" respectively, without breaking the rest of the table's layout or any other column's values.

- [ ] **Step 5: Commit**

```bash
git add views/admin/revenue.ejs src/services/analytics/revenue.js
git commit -m "feat: show ERP sync status on the admin Revenue page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Production deployment, cron setup, and end-to-end verification

**Files:** none (deployment/verification only — no code changes expected unless verification surfaces a bug)

This task is not dispatched to a subagent — it needs live SSH access to the production server and the real ERPNext credentials, both already established in this project's session history. Execute it directly.

- [ ] **Step 1: Add the 3 ERPNext env vars to production `.env`**

SSH to the production server, add `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` to `~/firststreetwifi/.env` with the real values. Do not print the secret to any log or terminal output that gets captured in a report.

- [ ] **Step 2: Sync the 8 changed/new files to production** (same `scp` approach used for the data-quota-packages deployment): `src/config.js`, `src/services/erpnext.js`, `src/db/index.js`, `src/routes/pay.js`, `scripts/sync-erpnext-invoices.js`, `package.json`, `views/admin/revenue.ejs`, `src/services/analytics/revenue.js`. There is no `scripts/setup-erpnext.js` in this design — Task 6 creates no code (see its rewritten scope: Items already exist, Custom Fields are dropped, Modes of Payment are a manual ERPNext UI step).

- [ ] **Step 3: On production, run `npm install` if `package.json` changed dependencies** (it doesn't in this plan — `undici` is already a dependency — but confirm `node_modules` doesn't need updating before proceeding), then `npm run init-db` (applies Task 3's migration to the real database). Confirm the 2 Modes of Payment (`Paynow Ecocash`, `Paynow OneMoney`) already exist in ERPNext from Task 6's manual step — if not done yet, do it now before proceeding (ERPNext UI, not a script).

- [ ] **Step 4: Confirm each Mode of Payment's account mapping is configured in ERPNext** (per `createAndSubmitPaymentEntry`'s `paid_to` design in Task 5) — this is a manual step in the ERPNext UI (Mode of Payment > Accounts) that Finance needs to do, not something scriptable without knowing which account they want. Real Payment Entries fail with a clear error until this is done; confirm it before Step 7's real test.

- [ ] **Step 5: Set up the cron job** for `scripts/sync-erpnext-invoices.js`, e.g. every 3 minutes:

```
*/3 * * * * cd /home/tanaka/firststreetwifi && /usr/bin/node scripts/sync-erpnext-invoices.js >> /home/tanaka/firststreetwifi/erpnext-sync.log 2>&1
```

Add via `crontab -e` on the production server (or `crontab -l | { cat; echo "..."; } | crontab -` non-interactively). Confirm it's present with `crontab -l` afterward.

- [ ] **Step 6: Restart the PM2 process** (`pm2 restart africom-hotspot`) to pick up the `pay.js` change, and check logs for a clean startup (same check as the data-quota-packages deployment).

- [ ] **Step 7: Real end-to-end test** — once the Mode of Payment account mapping (Step 4) is confirmed done, do one real controlled purchase (the `1gb` $0.50 package) on the live site, wait for the next cron tick (or run `npm run sync-erpnext` manually on the server to trigger it immediately), and confirm in ERPNext: a real `SINV-RET-*` invoice exists with the right customer/company/item/amount/tax/fiscal fields, and a submitted Payment Entry against it. This is the actual real-money version of Task 7's synthetic mock test, and the first true end-to-end confirmation this whole integration works.

- [ ] **Step 8: Confirm failure independence for real** — temporarily point `ERPNEXT_BASE_URL` at an unreachable address, restart, do another real test purchase, confirm the customer still gets their voucher and WiFi access normally, then check `erpnext_sync_status='failed'` on that transaction with a real error in `erpnext_sync_error`. Restore the correct `ERPNEXT_BASE_URL` and restart again afterward, then confirm the next cron tick picks that failed transaction up and successfully syncs it.
