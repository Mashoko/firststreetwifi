# ERPNext Invoice Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every successful hotspot purchase creates a real, submitted, paid Sales Invoice (+ Payment Entry) in ERPNext, without ever delaying or risking a customer's actual WiFi access.

**Architecture:** A new `src/services/erpnext.js` client (same shape as the existing `omada.js`/`paynow.js` services) provides the ERPNext operations. `finalizePaidTransaction()` in `pay.js` only marks a transaction `erpnext_sync_status='pending'` — no synchronous ERPNext call in the request path at all. A new recurring script, `scripts/sync-erpnext-invoices.js` (same pattern as the existing `scripts/check-connected-clients.js`), run via cron, does the actual invoice/payment creation with retry/backoff. A separate one-time script, `scripts/setup-erpnext.js`, creates the 5 Items/3 Custom Fields/2 Payment Modes the sync script depends on.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, `undici` (already a dependency, used for the same TLS/dispatcher pattern as `omada.js`). No test framework — manual verification, matching this project's established convention.

**Spec:** `docs/superpowers/specs/2026-09-09-erpnext-invoice-integration-design.md`

## Global Constraints

- ERPNext base: `https://erp.ai.co.zw`, Frappe 16.32.0 / ERPNext 16.32.3. Auth header: `Authorization: token <ERPNEXT_API_KEY>:<ERPNEXT_API_SECRET>`.
- Company: `Africom Private Ltd ZiG`. Customer: `CASH USD`. Currency: `USD`, `conversion_rate` fetched live from the `Currency Exchange` doctype (latest USD→ZWG rate) — never hardcoded.
- Tax template: `Zimbabwe Tax - APLG` (not the flagged-default `vat output - APLG` — verified against real retail invoices).
- POS Profile: `Contact Centre`, with `custom_fiscalise: 1` (ZIMRA fiscal stand-in, per spec).
- Naming series: `SINV-RET-.YYYY.-`.
- Package → Item mapping (exact, do not reinterpret): `1gb`→`HOTSPOT-1GB-1D` ($0.50), `2gb`→`HOTSPOT-2GB-1D` ($1.00), `3gb`→`HOTSPOT-3GB-7D` ($2.00), `5gb`→`HOTSPOT-5GB-14D` ($3.00), `10gb`→`HOTSPOT-10GB-30D` ($5.00). All Item Group `Airtime`, non-stock.
- Modes of Payment: `Paynow EcoCash`, `Paynow OneMoney` (new).
- Legacy package ids (`quick`/`day`/`week`/`month`) are never synced — marked `not_required` on first attempt.
- ERP sync is NEVER synchronous in the payment/WiFi-activation request path. It only ever happens in the recurring sync script.
- Credentials (`ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`) never logged, never sent to the frontend, never committed to git.
- Item/Custom Field/Mode of Payment creation happens ONLY in the one-time setup script, never in the recurring sync script.

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

**Files:**
- Modify: `src/services/erpnext.js`

**Interfaces:**
- Consumes: `erpRequest`, `getLatestExchangeRate` (Task 1)
- Produces: `createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB })` → the invoice `name` string.

- [ ] **Step 1: Add this function to `src/services/erpnext.js`**

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
    website_transaction_id: reference,
    website_package_id: packageId,
    payment_gateway: 'Paynow',
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

Do not run this against real credentials yet — the `HOTSPOT-1GB-1D` Item doesn't exist in ERPNext until Task 6's setup script runs, and creating a real invoice against a missing Item would fail (or worse, if this instance's validation is lax, could create a malformed one). Real-credential testing of this function happens in Task 7's verification, after Task 6.

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
  ecocash: 'Paynow EcoCash',
  onemoney: 'Paynow OneMoney',
};

/**
 * Creates and submits a Payment Entry against an already-submitted Sales
 * Invoice, marking it paid. `paid_to` (which GL account the money lands in)
 * is intentionally NOT hardcoded here — it's read from the Mode of
 * Payment's own account mapping for this company, which Finance configures
 * directly in ERPNext (see scripts/setup-erpnext.js). If that mapping is
 * missing, this throws a clear, actionable error rather than guessing an
 * account.
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

Real-credential testing happens in Task 7, after the Modes of Payment exist (Task 6) and have their account mapping configured (which requires Finance's input — flag this explicitly if you reach Task 7 and the account mapping isn't set yet; don't guess an account).

- [ ] **Step 3: Commit**

```bash
git add src/services/erpnext.js
git commit -m "feat: add ERPNext Payment Entry creation and submission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: One-time ERPNext setup script

**Files:**
- Create: `scripts/setup-erpnext.js`
- Modify: `src/services/erpnext.js` (add 3 small `ensure*` helper functions this script uses)
- Modify: `package.json` (add an `setup-erpnext` script entry, same pattern as the existing `check-clients` entry)

**Interfaces:**
- Consumes: `erpRequest` (Task 1)
- Produces: `ensureItem({itemCode, itemName, rate})`, `ensureCustomField({doctype, fieldname, label})`, `ensureModeOfPayment(name)` — each idempotent (checks existence first), each returning `{created: boolean, name: string}`.

- [ ] **Step 1: Add the 3 `ensure*` functions to `src/services/erpnext.js`**

```javascript
/** Idempotent: creates the Item only if it doesn't already exist. */
export async function ensureItem({ itemCode, itemName, rate }) {
  const exists = await getItemByCode(itemCode);
  if (exists) return { created: false, name: itemCode };

  await erpRequest('POST', '/api/resource/Item', {
    item_code: itemCode,
    item_name: itemName,
    item_group: 'Airtime',
    stock_uom: 'Nos',
    is_stock_item: 0,
    is_sales_item: 1,
    is_purchase_item: 0,
    standard_rate: rate,
  });
  return { created: true, name: itemCode };
}

/** Idempotent: creates a simple Data-type Custom Field on a doctype if missing. */
export async function ensureCustomField({ doctype, fieldname, label }) {
  const existing = await erpRequest(
    'GET',
    `/api/resource/Custom Field?filters=${encodeURIComponent(JSON.stringify([['dt', '=', doctype], ['fieldname', '=', fieldname]]))}&limit_page_length=1`
  );
  if (existing?.data?.[0]) return { created: false, name: existing.data[0].name };

  const created = await erpRequest('POST', '/api/resource/Custom Field', {
    dt: doctype,
    fieldname,
    label,
    fieldtype: 'Data',
  });
  return { created: true, name: created?.data?.name };
}

/** Idempotent: creates a Mode of Payment if missing. Does NOT configure its
 * account mapping — that's a Finance decision, done manually in ERPNext
 * after this script creates the bare record (see createAndSubmitPaymentEntry,
 * which fails clearly if the mapping is still missing when a real payment
 * needs it). */
export async function ensureModeOfPayment(name) {
  const existing = await erpRequest('GET', `/api/resource/Mode of Payment/${encodeURIComponent(name)}`).catch((err) => {
    if (String(err.message).includes('404')) return null;
    throw err;
  });
  if (existing?.data) return { created: false, name };

  await erpRequest('POST', '/api/resource/Mode of Payment', {
    mode_of_payment: name,
    type: 'General',
  });
  return { created: true, name };
}
```

- [ ] **Step 2: Create `scripts/setup-erpnext.js`**

```javascript
import { config } from '../src/config.js';
import { ensureItem, ensureCustomField, ensureModeOfPayment } from '../src/services/erpnext.js';

console.error(config.mockMode ? '[MOCK MODE] no real ERPNext calls will be made' : `[LIVE] ${config.erpnext.baseUrl}`);

const ITEMS = [
  { itemCode: 'HOTSPOT-1GB-1D', itemName: 'Hotspot 1GB Data (1 Day)', rate: 0.50 },
  { itemCode: 'HOTSPOT-2GB-1D', itemName: 'Hotspot 2GB Data (1 Day)', rate: 1.00 },
  { itemCode: 'HOTSPOT-3GB-7D', itemName: 'Hotspot 3GB Data (7 Days)', rate: 2.00 },
  { itemCode: 'HOTSPOT-5GB-14D', itemName: 'Hotspot 5GB Data (14 Days)', rate: 3.00 },
  { itemCode: 'HOTSPOT-10GB-30D', itemName: 'Hotspot 10GB Data (30 Days)', rate: 5.00 },
];

const CUSTOM_FIELDS = [
  { doctype: 'Sales Invoice', fieldname: 'website_transaction_id', label: 'Website Transaction ID' },
  { doctype: 'Sales Invoice', fieldname: 'website_package_id', label: 'Website Package ID' },
  { doctype: 'Sales Invoice', fieldname: 'payment_gateway', label: 'Payment Gateway' },
];

const MODES_OF_PAYMENT = ['Paynow EcoCash', 'Paynow OneMoney'];

for (const item of ITEMS) {
  const result = await ensureItem(item);
  console.log(`Item ${item.itemCode}: ${result.created ? 'created' : 'already exists'}`);
}

for (const field of CUSTOM_FIELDS) {
  const result = await ensureCustomField(field);
  console.log(`Custom Field ${field.doctype}.${field.fieldname}: ${result.created ? 'created' : 'already exists'}`);
}

for (const mode of MODES_OF_PAYMENT) {
  const result = await ensureModeOfPayment(mode);
  console.log(`Mode of Payment ${mode}: ${result.created ? 'created' : 'already exists'}`);
}

console.log('\nDone. If any Modes of Payment were just created, Finance still needs to');
console.log('configure their default account (Mode of Payment > Accounts) in ERPNext');
console.log('before real Payment Entries can be created against them.');
```

- [ ] **Step 3: Add the npm script entry to `package.json`**, in the `"scripts"` block, alongside the existing `"check-clients"` entry:

```json
    "setup-erpnext": "node scripts/setup-erpnext.js",
```

- [ ] **Step 4: Verify manually — mock mode**

`MOCK_MODE=true npm run setup-erpnext` — expect `[MOCK MODE]` header, then `[MOCK] ...` lines for each of the 10 operations (5 items + 3 fields + 2 modes), completing without error.

- [ ] **Step 5: Verify manually — real credentials**

`MOCK_MODE=false npm run setup-erpnext` — expect `[LIVE] https://erp.ai.co.zw`, then real "created" lines for everything (first run) — this is the first real confirmation that the integration user has *write* access to Item, Custom Field, and Mode of Payment, not just read (which is all that was confirmed during design). If any step fails with a permission error, report that clearly — do not attempt to work around it by switching credentials or guessing at different field names.

Run it a **second time** immediately after: `MOCK_MODE=false npm run setup-erpnext` — expect every line to now say "already exists", confirming idempotency (nothing duplicated).

- [ ] **Step 6: Commit**

```bash
git add src/services/erpnext.js scripts/setup-erpnext.js package.json
git commit -m "feat: add one-time ERPNext setup script for items, fields, payment modes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: The recurring sync script

**Files:**
- Create: `scripts/sync-erpnext-invoices.js`

**Interfaces:**
- Consumes: `findInvoiceByTransactionRef`, `getItemByCode`, `createAndSubmitInvoice`, `createAndSubmitPaymentEntry` (Tasks 2, 4, 5); `getPackage` (`src/packages.js`, already exists); `db` (`src/db/index.js`, already exists)

- [ ] **Step 1: Create `scripts/sync-erpnext-invoices.js`**

```javascript
import { db } from '../src/db/index.js';
import { getPackage } from '../src/packages.js';
import {
  findInvoiceByTransactionRef,
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
  // Idempotency: already has an invoice recorded locally.
  if (tx.erpnext_invoice_name) return 'already-synced';

  if (!claim(tx)) return 'claimed-by-another-run';

  // Idempotency: check ERPNext directly in case a prior run created the
  // invoice but crashed before recording it locally.
  const existingInvoice = await findInvoiceByTransactionRef(tx.reference);
  if (existingInvoice) {
    db.prepare(
      `UPDATE transactions SET erpnext_invoice_name=?, erpnext_sync_status='success', erpnext_synced_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(existingInvoice, tx.id);
    return 'adopted-existing';
  }

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
    '1gb': 'HOTSPOT-1GB-1D',
    '2gb': 'HOTSPOT-2GB-1D',
    '3gb': 'HOTSPOT-3GB-7D',
    '5gb': 'HOTSPOT-5GB-14D',
    '10gb': 'HOTSPOT-10GB-30D',
  }[tx.package_id];

  try {
    const exists = await getItemByCode(itemCode);
    if (!exists) {
      throw new Error(`Item ${itemCode} does not exist in ERPNext — run scripts/setup-erpnext.js first`);
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
    if (result === 'success' || result === 'adopted-existing') counts.success++;
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

- [ ] **Step 2: Sync the 9 changed/new files to production** (same `scp` approach used for the data-quota-packages deployment): `src/config.js`, `src/services/erpnext.js`, `src/db/index.js`, `src/routes/pay.js`, `scripts/setup-erpnext.js`, `scripts/sync-erpnext-invoices.js`, `package.json`, `views/admin/revenue.ejs`, `src/services/analytics/revenue.js`.

- [ ] **Step 3: On production, run `npm install` if `package.json` changed dependencies** (it doesn't in this plan — `undici` is already a dependency — but confirm `node_modules` doesn't need updating before proceeding), then `npm run init-db` (applies Task 3's migration to the real database), then `npm run setup-erpnext` (creates the real Items/Custom Fields/Modes of Payment — this is the actual production run of Task 6's script, not a repeat of the design-phase read-only checks).

- [ ] **Step 4: Tell the user which Modes of Payment need their account mapping configured in ERPNext** (per Task 5's `paid_to` design) before real Payment Entries can succeed — this is a manual step in the ERPNext UI that Finance needs to do, not something scriptable without knowing which account they want.

- [ ] **Step 5: Set up the cron job** for `scripts/sync-erpnext-invoices.js`, e.g. every 3 minutes:

```
*/3 * * * * cd /home/tanaka/firststreetwifi && /usr/bin/node scripts/sync-erpnext-invoices.js >> /home/tanaka/firststreetwifi/erpnext-sync.log 2>&1
```

Add via `crontab -e` on the production server (or `crontab -l | { cat; echo "..."; } | crontab -` non-interactively). Confirm it's present with `crontab -l` afterward.

- [ ] **Step 6: Restart the PM2 process** (`pm2 restart africom-hotspot`) to pick up the `pay.js` change, and check logs for a clean startup (same check as the data-quota-packages deployment).

- [ ] **Step 7: Real end-to-end test** — once the Mode of Payment account mapping (Step 4) is confirmed done, do one real controlled purchase (the `1gb` $0.50 package) on the live site, wait for the next cron tick (or run `npm run sync-erpnext` manually on the server to trigger it immediately), and confirm in ERPNext: a real `SINV-RET-*` invoice exists with the right customer/company/item/amount/tax/fiscal fields, and a submitted Payment Entry against it. This is the actual real-money version of Task 7's synthetic mock test, and the first true end-to-end confirmation this whole integration works.

- [ ] **Step 8: Confirm failure independence for real** — temporarily point `ERPNEXT_BASE_URL` at an unreachable address, restart, do another real test purchase, confirm the customer still gets their voucher and WiFi access normally, then check `erpnext_sync_status='failed'` on that transaction with a real error in `erpnext_sync_error`. Restore the correct `ERPNEXT_BASE_URL` and restart again afterward, then confirm the next cron tick picks that failed transaction up and successfully syncs it.
