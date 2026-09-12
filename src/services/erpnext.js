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

const COMPANY = 'Africom Private Ltd ZiG';
const CUSTOMER = 'CASH USD';
const TAX_TEMPLATE = 'Zimbabwe Tax - APLG';
const POS_PROFILE = 'Contact Centre';
// 'Zimbabwe Tax - APLG' is 15.5%, "On Net Total", included_in_print_rate: 0
// — i.e. ADDITIVE, confirmed via a real GET against the live template.
// The item rate must therefore be the net (pre-tax) amount, not the amount
// the customer actually paid, or ERPNext invoices MORE than was collected
// (a real, confirmed bug: a $0.50 sale was invoiced at $0.58). See
// createAndSubmitInvoice's netRateForGrandTotal() below.
const TAX_RATE_PERCENT = 15.5;
// Exact ERPNext document names — Frappe's GET /api/resource/<doctype>/<name>
// is an exact-match lookup, so these must match the real records verbatim.
// The real record is "Paynow Ecocash" (lowercase after "Eco"), confirmed
// against the live instance after creation — not "Paynow EcoCash".
const MODE_OF_PAYMENT = {
  ecocash: 'Paynow Ecocash',
  onemoney: 'Paynow OneMoney',
};

/**
 * Creates a Sales Invoice for one hotspot package purchase and submits it.
 * Frappe's REST API creates a document as a draft (docstatus 0); submission
 * is a separate PUT setting docstatus to 1, which is what actually triggers
 * ERPNext's submit-time validation/side-effects (including, per the real
 * invoices inspected during design, ZIMRA fiscalisation).
 *
 * `packageId` and `dataGB` are accepted but currently unused in the request
 * body. An earlier version of this function also wrote
 * `website_transaction_id`/`website_package_id`/`payment_gateway` custom
 * fields — those are dropped: the integration user can't create Custom
 * Fields (403), and even after a human created them via the ERPNext UI,
 * the underlying DB column never got added (a real write attempt 500s with
 * `Unknown column`, confirmed by direct testing) — this instance needs a
 * server-side schema migration nobody currently has access to run.
 * Idempotency for this integration relies solely on the local
 * `transactions.erpnext_invoice_name` column. `packageId`/`dataGB` stay in
 * the signature so callers don't need to change again once that follow-up
 * lands.
 *
 * `method` (`'ecocash'`/`'onemoney'`) is required because `is_pos: 1`
 * invoices need their own `payments` child-table row declaring which mode
 * of payment was used at point of sale, found via a real submit failure:
 * "At least one mode of payment is required for POS invoice." This
 * `payments` row is now the ONLY settlement mechanism for these invoices
 * (an earlier version also created a separate Payment Entry — dropped,
 * see `createAndSubmitPaymentEntry`'s doc comment for why).
 *
 * The invoice is created with `disable_rounded_total: 1` and an item
 * `rate` computed so `grand_total` lands on the amount the customer
 * actually paid (`amount`), not on `amount` itself — see
 * `netRateForGrandTotal()`. Without this, the additive tax template
 * invoices MORE than was collected, and ERPNext's default whole-currency
 * rounding then distorts it further with a Round Off GL entry — both
 * confirmed as real bugs via a live GL inspection of the first real test
 * invoice (grand_total $0.58 and a $0.42 Round Off entry on a $0.50 sale).
 */
function netRateForGrandTotal(amount) {
  return Math.round((amount / (1 + TAX_RATE_PERCENT / 100)) * 100) / 100;
}

export async function createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB, method }) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext create+submit invoice: ref=${reference} item=${itemCode} amount=${amount} method=${method}`);
    return `MOCK-SINV-${reference}`;
  }

  const { rate } = await getLatestExchangeRate('USD', 'ZWG');
  const modeOfPayment = MODE_OF_PAYMENT[method] || MODE_OF_PAYMENT.ecocash;
  const netRate = netRateForGrandTotal(amount);

  const draft = await erpRequest('POST', '/api/resource/Sales Invoice', {
    naming_series: 'SINV-RET-.YYYY.-',
    customer: CUSTOMER,
    company: COMPANY,
    currency: 'USD',
    conversion_rate: rate,
    is_pos: 1,
    pos_profile: POS_PROFILE,
    custom_fiscalise: 1,
    disable_rounded_total: 1,
    taxes_and_charges: TAX_TEMPLATE,
    items: [
      {
        item_code: itemCode,
        qty: 1,
        rate: netRate,
      },
    ],
    payments: [
      {
        mode_of_payment: modeOfPayment,
        amount,
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

// createAndSubmitPaymentEntry() was removed here (post-Task-10 whole-branch
// review). It created a separate Payment Entry against the invoice on top
// of the `payments` row `createAndSubmitInvoice()` already declares — the
// two settlement mechanisms fought each other for anything but the `1gb`
// package's $0.50 (where the numbers happened to coincide): a real GL
// inspection found the PE posted the USD `amount` straight into a ZWG cash
// account with no currency conversion, fabricating an "Exchange Gain/Loss"
// entry, and for every other package the invoice was already fully settled
// by the `payments` row, so the PE's allocation was rejected outright,
// leaving the transaction permanently `failed` after invoice submission.
// This matches the business's own real retail invoices (e.g.
// SINV-RET-2026-03750), none of which have a Payment Entry — the POS
// `payments` row is ERPNext's own intended settlement path for is_pos:1
// invoices. `erpnext_payment_entry_name` stays in the transactions schema
// (nullable, unused going forward) rather than being migrated away, since
// the two real test transactions from before this fix genuinely have one.
