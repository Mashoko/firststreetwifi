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

  const response = await paynow.sendMobile(payment, phone, method);
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
