import { Agent } from 'undici';
import { config } from '../config.js';

// Allow self-signed controller certs when verifyTls is false.
// Node's built-in fetch() is undici-based and does NOT honor a plain
// https.Agent passed as `agent` — it silently ignores it, so TLS
// verification stayed on even with OMADA_VERIFY_TLS=false. An undici
// Agent passed as `dispatcher` is the option fetch() actually reads.
const dispatcher = new Agent({ connect: { rejectUnauthorized: config.omada.verifyTls } });

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
    dispatcher,
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
    dispatcher,
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

// Resolved once per process from the site *name* (config.omada.site) to the
// internal site key the clients-list endpoint requires. Not persisted; a
// process restart re-resolves it, which also picks up a site rename in Omada.
let cachedSiteKey = null;

async function resolveSiteKey(cookie, token) {
  if (cachedSiteKey) return cachedSiteKey;

  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/current/sites?currentPage=1&currentPageSize=100`;
  const res = await fetch(url, {
    dispatcher,
    headers: {
      'Content-Type': 'application/json',
      'Csrf-Token': token,
      Cookie: cookie,
    },
  });

  const data = await res.json();
  if (!data || data.errorCode !== 0) {
    throw new Error(`Omada site list failed: ${JSON.stringify(data)}`);
  }

  const list = data.result?.data || [];
  const match = list.find((s) => s.name === config.omada.site);
  if (!match) {
    throw new Error(`Omada site not found: "${config.omada.site}"`);
  }

  cachedSiteKey = match.id;
  return cachedSiteKey;
}

/**
 * Fetches currently-active clients on the configured site.
 * In MOCK_MODE, returns fixture data with no network calls.
 */
export async function getConnectedClients() {
  if (config.mockMode) {
    const now = Date.now();
    return {
      total: 3,
      clients: [
        { mac: 'AA:BB:CC:00:00:01', name: 'Guest-Phone-1', ip: '192.168.1.101', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(now - 15 * 60000).toISOString() },
        { mac: 'AA:BB:CC:00:00:02', name: 'Guest-Phone-2', ip: '192.168.1.102', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(now - 42 * 60000).toISOString() },
        { mac: 'AA:BB:CC:00:00:03', name: 'Guest-Laptop', ip: '192.168.1.103', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(now - 3 * 60000).toISOString() },
      ],
    };
  }

  const { token, cookie } = await omadaLogin();
  const siteKey = await resolveSiteKey(cookie, token);

  const pageSize = 100;
  let currentPage = 1;
  let allClients = [];
  let totalRows = 0;

  while (true) {
    const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/sites/${siteKey}/clients?currentPage=${currentPage}&currentPageSize=${pageSize}&filters.active=true`;
    const res = await fetch(url, {
      dispatcher,
      headers: {
        'Content-Type': 'application/json',
        'Csrf-Token': token,
        Cookie: cookie,
      },
    });

    const data = await res.json();
    if (!data || data.errorCode !== 0) {
      throw new Error(`Omada client list failed: ${JSON.stringify(data)}`);
    }

    const rows = data.result?.data || [];
    const pageClients = rows.map((c) => ({
      mac: c.mac || c.clientMac || '',
      name: c.name || c.hostName || 'Unknown device',
      ip: c.ip || c.wirelessClient?.ip || '',
      ssid: c.ssid || c.wirelessClient?.ssid || '',
      apName: c.apName || '',
      connectedAt: c.connectAt || c.lastSeen || null,
    }));

    allClients = allClients.concat(pageClients);
    totalRows = data.result?.totalRows ?? 0;

    // Stop once a page comes back short (last page) or we hit the hard page
    // cap (infinite-loop safety net if the API keeps returning full pages).
    // Deliberately NOT comparing against totalRows here: that field name is
    // an unverified guess at the real controller's response shape, and if
    // it's wrong/missing it defaults to 0, which would make
    // `allClients.length >= totalRows` true on page 1 and silently truncate
    // results above one page again.
    if (rows.length < pageSize || currentPage >= 50) {
      break;
    }

    currentPage++;
  }

  return { total: allClients.length, clients: allClients };
}
