import { config } from '../config.js';

// The official Paynow Node SDK is CommonJS; import dynamically.
let PaynowLib = null;
async function getPaynow() {
  if (!PaynowLib) {
    const mod = await import('paynow');
    PaynowLib = mod.Paynow || mod.default?.Paynow || mod.default;
  }
  const resultUrl = `${config.baseUrl}/pay/callback`;
  const returnUrl = `${config.baseUrl}/pay/return`;
  const pn = new PaynowLib(
    config.paynow.integrationId,
    config.paynow.integrationKey,
    resultUrl,
    returnUrl
  );
  return pn;
}

/**
 * Initiate an EcoCash / OneMoney express-checkout (mobile) transaction.
 * Returns { success, pollUrl, instructions, error }.
 */
export async function initMobilePayment({ reference, amount, itemName, phone, email, method = 'ecocash' }) {
  if (config.mockMode) {
    console.log(`[MOCK] Paynow ${method} charge $${amount} to ${phone} (ref ${reference})`);
    return {
      success: true,
      mock: true,
      pollUrl: `mock://poll/${reference}`,
      instructions: `Dial *151# (simulated). Payment will auto-succeed in mock mode.`,
    };
  }

  const paynow = await getPaynow();
  const payment = paynow.createPayment(reference, email || config.paynow.authEmail);
  payment.add(itemName, amount);

  // The Paynow SDK can throw instead of resolving to a {success:false} result
  // (e.g. a response hash-validation failure) — catch that so callers always
  // get the documented {success, error} shape and can mark the transaction
  // failed, rather than the exception bypassing that and leaving the
  // transaction stuck at 'created' in the DB indefinitely.
  let response;
  try {
    response = await paynow.sendMobile(payment, phone, method);
  } catch (err) {
    console.error('Paynow sendMobile threw:', err);
    return { success: false, error: err.message || 'Payment initiation failed' };
  }
  // The SDK can also resolve to undefined instead of throwing or rejecting
  // (its own internal error handling logs the failure — e.g. a response
  // hash-validation mismatch — but doesn't surface it on the promise we
  // awaited), so a falsy response is a failure too, not just !response.success.
  if (!response) {
    return { success: false, error: 'No response from Paynow (payment gateway error)' };
  }
  if (response.success) {
    return {
      success: true,
      pollUrl: response.pollUrl,
      instructions: response.instructions,
    };
  }
  return { success: false, error: response.error || 'Payment initiation failed' };
}

/**
 * Poll a transaction's status.
 * Returns { paid, status }.
 */
export async function pollPayment(pollUrl) {
  if (config.mockMode) {
    // In mock mode, treat every poll as paid (after a short delay handled by caller).
    return { paid: true, status: 'Paid', mock: true };
  }
  const paynow = await getPaynow();
  const status = await paynow.pollTransaction(pollUrl);
  return { paid: status.paid(), status: status.status };
}
