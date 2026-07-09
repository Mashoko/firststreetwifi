import https from 'https';
import { config } from '../config.js';

// Allow self-signed controller certs when verifyTls is false.
const agent = new https.Agent({ rejectUnauthorized: config.omada.verifyTls });

/**
 * Omada External-Portal authorization (Controller v5.0.15+ flow):
 *   1. POST /{controllerId}/api/v2/hotspot/login   -> returns CSRF token + session cookie
 *   2. POST /{controllerId}/api/v2/hotspot/extPortal/auth  (with token header + cookie)
 *
 * Docs: TP-Link FAQ 3231 (v5.0.15+) / FAQ 2907 (v4.x).
 */

async function omadaLogin() {
  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/hotspot/login`;
  const res = await fetch(url, {
    method: 'POST',
    agent,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: config.omada.operatorUser,
      password: config.omada.operatorPass,
    }),
  });

  const setCookie = res.headers.get('set-cookie') || '';
  const data = await res.json();
  if (!data || data.errorCode !== 0) {
    throw new Error(`Omada login failed: ${JSON.stringify(data)}`);
  }
  // CSRF token lives in result.token
  const token = data.result?.token;
  // Session cookie: TPOMADA_SESSIONID (v5.11+) or TPEAP_SESSIONID (older)
  const cookie = setCookie.split(';')[0];
  return { token, cookie };
}

/**
 * Authorize a client so it gets internet access.
 * clientInfo comes from the captive-portal redirect query string.
 * durationMinutes is converted to milliseconds for the `time` field.
 */
export async function authorizeClient(clientInfo, durationMinutes) {
  const timeMs = durationMinutes * 60 * 1000;

  if (config.mockMode) {
    console.log(`[MOCK] Omada authorize: client=${clientInfo.clientMac} for ${durationMinutes}min`);
    return { success: true, mock: true };
  }

  const { token, cookie } = await omadaLogin();

  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/hotspot/extPortal/auth`;

  // Wireless (EAP) auth payload. authType 4 = external portal.
  const body = {
    clientMac: clientInfo.clientMac,
    apMac: clientInfo.apMac,
    ssidName: clientInfo.ssidName,
    radioId: clientInfo.radioId,
    site: clientInfo.site || config.omada.site,
    time: timeMs,
    authType: 4,
  };

  const res = await fetch(url, {
    method: 'POST',
    agent,
    headers: {
      'Content-Type': 'application/json',
      'Csrf-Token': token,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data || data.errorCode !== 0) {
    throw new Error(`Omada authorize failed: ${JSON.stringify(data)}`);
  }
  return { success: true };
}

/**
 * Parse the captive-portal redirect query params into a normalized object.
 * Omada fills these automatically when it redirects the client to your portal.
 */
export function parseClientInfo(query) {
  return {
    clientMac: query.clientMac || query.cid || '',
    apMac: query.apMac || query.ap || '',
    ssidName: query.ssidName || query.ssid || '',
    radioId: query.radioId || query.rid || '',
    site: query.site || '',
    gatewayMac: query.gatewayMac || query.gw || '',
    vid: query.vid || '',
  };
}
