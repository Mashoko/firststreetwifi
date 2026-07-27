# Omada Physical Controller Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `getConnectedClients()` capability to the Omada integration so a later dashboard can show live connected users, once the "Africom Hotspot" site is migrated from Omada Cloud Essentials to a physical hardware controller.

**Architecture:** `src/services/omada.js` already implements the local-controller auth flow (`omadaLogin()`, `authorizeClient()`) for `OMADA_CONTROLLER_TYPE=software`, which a physical hardware controller (OC200/OC300-class) uses identically — no changes needed there. This plan adds a sibling function, `getConnectedClients()`, that reuses the same login/cookie/CSRF pattern, resolves the site's internal key (cached in memory, not a config value), and calls the controller's clients-list endpoint.

**Tech Stack:** Node.js (ESM), native `fetch`, `https.Agent` (already present in `omada.js`). No new dependencies.

## Global Constraints

- No Open API / OAuth2 / cloud code — ruled out in the spec (Cloud Essentials doesn't support it; moot once the site is on a physical controller). Do not add any cloud-auth code path.
- No new required `.env` vars — the site key is resolved dynamically via the API and cached in a module-level variable, per the spec's Design section.
- This repo has no automated test framework (no test script in `package.json`, no test files anywhere) — matching `docs/superpowers/plans/2026-07-09-admin-auth.md`. Verification here is manual: run scripts/curl with `MOCK_MODE=true` and inspect output. Do not introduce a test framework.
- `authorizeClient()` and `omadaLogin()` in `src/services/omada.js` are not to be modified — the spec explicitly treats them as already-correct for a physical controller (Non-goals).
- Real-hardware verification (buying a real voucher, migrating the site, calling the real clients endpoint) cannot be executed in this environment — there is no physical controller reachable here. Those steps are documented for the site owner to run themselves once the hardware migration happens; do not mark them as verified in this plan.
- Dev/test commands use the local `.env`'s `PORT=3100` where a running server is needed, matching `docs/superpowers/plans/2026-07-09-admin-auth.md`.

---

### Task 1: `getConnectedClients()` and site-key resolution in `omada.js`

**Files:**
- Modify: `src/services/omada.js`

**Interfaces:**
- Consumes: existing `agent` (module-level `https.Agent`), `omadaLogin()` (returns `{ token, cookie }`), `config.omada.*`, `config.mockMode` — all already defined in this file.
- Produces: `export async function getConnectedClients()` → `Promise<{ total: number, clients: Array<{ mac: string, name: string, ip: string, ssid: string, apName: string, connectedAt: string|null }> }>`. This is the function a later dashboard route will call.

- [ ] **Step 1: Add `resolveSiteKey()` and `getConnectedClients()` to the end of `src/services/omada.js`**

The file currently ends with the `parseClientInfo` export (last line is the closing `}` of that function). Append this after it:

```js

// Resolved once per process from the site *name* (config.omada.site) to the
// internal site key the clients-list endpoint requires. Not persisted; a
// process restart re-resolves it, which also picks up a site rename in Omada.
let cachedSiteKey = null;

async function resolveSiteKey(cookie, token) {
  if (cachedSiteKey) return cachedSiteKey;

  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/current/sites?currentPage=1&currentPageSize=100`;
  const res = await fetch(url, {
    agent,
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

  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/sites/${siteKey}/clients?currentPage=1&currentPageSize=100&filters.active=true`;
  const res = await fetch(url, {
    agent,
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
  const clients = rows.map((c) => ({
    mac: c.mac || c.clientMac || '',
    name: c.name || c.hostName || 'Unknown device',
    ip: c.ip || c.wirelessClient?.ip || '',
    ssid: c.ssid || c.wirelessClient?.ssid || '',
    apName: c.apName || '',
    connectedAt: c.connectAt || c.lastSeen || null,
  }));

  return { total: data.result?.totalRows ?? clients.length, clients };
}
```

**Field-mapping note (do not "fix" this without a real controller):** the `||` fallbacks in the `.map()` above (e.g. `c.mac || c.clientMac`) exist because TP-Link's exact JSON field names can't be confirmed without a live call. Leave them as-is; Task 2's smoke-test script is how the site owner corrects them later against real data.

- [ ] **Step 2: Verify mock mode returns the fixture, with no network activity**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi" && node -e "
import('./src/services/omada.js').then(async (m) => {
  const result = await m.getConnectedClients();
  console.log(JSON.stringify(result, null, 2));
});
"
```

Expected: prints a JSON object with `"total": 3` and a `clients` array of 3 fixture entries (`Guest-Phone-1`, `Guest-Phone-2`, `Guest-Laptop`). This must return instantly with no network delay — confirms mock mode short-circuits before any `fetch()` call.

- [ ] **Step 3: Commit**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi"
git add src/services/omada.js
git commit -m "Add getConnectedClients() to Omada service"
```

---

### Task 2: Manual smoke-test script and README verification steps

**Files:**
- Create: `scripts/check-connected-clients.js`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `getConnectedClients()` from Task 1 (`src/services/omada.js`).
- Produces: `npm run check-clients` — a manual command the site owner runs (in mock mode now, against the real controller later) to inspect the raw output.

- [ ] **Step 1: Create the smoke-test script**

Create `scripts/check-connected-clients.js`:

```js
import { getConnectedClients } from '../src/services/omada.js';

const result = await getConnectedClients();
console.log(JSON.stringify(result, null, 2));
```

- [ ] **Step 2: Add the npm script**

In `package.json`, the `scripts` block currently reads:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "init-db": "node src/db/init.js"
  },
```

Replace it with:

```json
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "init-db": "node src/db/init.js",
    "check-clients": "node scripts/check-connected-clients.js"
  },
```

- [ ] **Step 3: Verify the script runs in mock mode**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi" && npm run check-clients
```

Expected: same 3-client fixture JSON as Task 1 Step 2, this time via the npm script.

- [ ] **Step 4: Add a "Connected clients" section to `README.md`**

In `README.md`, find the `## Files` section (it starts with `- \`src/services/omada.js\` — Omada hotspot login...`). Add a new section immediately after the `## Files` section and before `## Switching to PostgreSQL later`:

```markdown
## Connected clients (live users)

`getConnectedClients()` in `src/services/omada.js` fetches currently-active
clients on the configured site — used by the admin dashboard to show who's
online right now. In `MOCK_MODE`, it returns fixture data with no network
calls; run `npm run check-clients` to see the shape.

**Before relying on this against a real controller**, confirm it end-to-end:

1. Migrate the "Africom Hotspot" site from Omada Cloud (Cloud Essentials
   doesn't support external API access at all) onto a physical hardware
   controller (OC200/OC300-class), following TP-Link's site-migration flow
   in the Omada app.
2. Set up the Hotspot Operator account and External Portal exactly as
   described above, pointing `OMADA_BASE_URL` / `OMADA_CONTROLLER_ID` at the
   physical controller's local address, and set `MOCK_MODE=false`.
3. Buy a voucher through the real portal end-to-end and confirm the paying
   client actually gets network access (this is the first real-hardware use
   of the existing `authorizeClient()` flow — no code change is expected,
   but it hasn't been tested against real hardware before).
4. Run `npm run check-clients` again (now hitting the real controller).
   Compare the printed JSON field names against what
   `src/services/omada.js`'s `getConnectedClients()` assumes (`mac`, `name`,
   `ip`, `ssid`, `apName`, `connectAt` — see the `.map()` call). If the real
   controller uses different field names, update that `.map()` to match.
5. Connect/disconnect a test device on the hotspot Wi-Fi and re-run
   `npm run check-clients` to confirm the list actually changes (i.e. it's
   reading live state, not a cached/stale result).
```

- [ ] **Step 5: Commit**

```bash
cd "/home/user/Documents/Hotspot Billing/firststreetwifi"
git add scripts/check-connected-clients.js package.json README.md
git commit -m "Add connected-clients smoke-test script and verification docs"
```

---

## Post-plan note

Once the site owner completes the real-hardware verification steps in
`README.md`'s new "Connected clients" section (physical migration, live
`npm run check-clients` run, field-mapping correction if needed), this
sub-project is fully done. The dashboard sub-project (subscriber trends,
revenue trends, most-purchased, live connected-users widget) is separate
follow-up work, tracked as its own spec/plan per the brainstorming session
that produced `docs/superpowers/specs/2026-07-27-omada-physical-controller-design.md`.
