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
 * of payment was used at point of sale — this is separate from, and in
 * addition to, the Payment Entry created afterward by
 * `createAndSubmitPaymentEntry()`. Found via a real submit failure:
 * "At least one mode of payment is required for POS invoice." Uses the
 * same `MODE_OF_PAYMENT` mapping as the Payment Entry step, so the mode
 * named on the invoice always matches the mode used for the actual
 * payment.
 */
export async function createAndSubmitInvoice({ reference, packageId, itemCode, amount, dataGB, method }) {
  if (config.mockMode) {
    console.log(`[MOCK] ERPNext create+submit invoice: ref=${reference} item=${itemCode} amount=${amount} method=${method}`);
    return `MOCK-SINV-${reference}`;
  }

  const { rate } = await getLatestExchangeRate('USD', 'ZWG');
  const modeOfPayment = MODE_OF_PAYMENT[method] || MODE_OF_PAYMENT.ecocash;

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

/**
 * Creates and submits a Payment Entry against an already-submitted Sales
 * Invoice, marking it paid. `paid_to` (which GL account the money lands in)
 * is intentionally NOT hardcoded here — it's read from the Mode of
 * Payment's own account mapping for this company, which Finance configures
 * directly in ERPNext (Mode of Payment is created manually, once, via the
 * ERPNext UI — the integration user has no Create permission on it and
 * there is no setup script). If that mapping is missing, this throws a
 * clear, actionable error rather than guessing an account.
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
