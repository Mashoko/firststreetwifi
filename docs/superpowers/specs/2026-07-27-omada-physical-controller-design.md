# Omada physical controller integration — design

## Problem

The captive-portal authorization flow (`authorizeClient()` in `src/services/omada.js`)
was built for a self-hosted/software Omada controller. The site currently in use
("Africom Hotspot") is on TP-Link's Omada Cloud, on the free **Cloud Essentials**
tier, which does not support Open API access or External Portal Server integration
at all — so this portal cannot authorize customers against it in any form.

The owner has a physical hardware controller (OC200/OC300-class) available and will
migrate the site onto it. A hardware controller runs the same local Controller API
as the "software" controller type already coded here, so the existing authorization
flow needs no rework — but there is currently no way to read back which clients are
connected, which the analytics dashboard (a separate, later sub-project) needs.

## Goals

- Confirm the existing local-controller flow (`OMADA_CONTROLLER_TYPE=software`)
  works end-to-end once the site is migrated to the physical controller.
- Add a `getConnectedClients()` function so a later dashboard can show live
  connected users.
- Keep `MOCK_MODE` fully functional for this new capability, so dashboard work
  isn't blocked on the physical migration timeline.

## Non-goals (YAGNI)

- Any Omada Cloud / Open API / OAuth2 code — not usable on Cloud Essentials, and
  moot once the site is on a physical controller.
- Multi-site support — there is one site, "Africom Hotspot" (config already
  assumes a single `OMADA_SITE`).
- Changes to `authorizeClient()` itself — expected to keep working unchanged
  against a physical controller; only verified manually (see Testing).
- Historical/offline client data — the controller API only reliably reports
  currently-active clients.

## Design

### Config

No new required `.env` vars. `OMADA_BASE_URL` simply points at the physical
controller's LAN address (e.g. `https://192.168.0.10:8043`) instead of a cloud
proxy URL — already how `.env.example` documents the "software" controller type.

`OMADA_SITE` (the site *name*, e.g. `Default` or `Africom Hotspot`) continues to
be used as today. A site *key* (internal ID) is additionally required by the
clients-list endpoint, but is **not** added as a manual config value — see next
section.

### Site key resolution (`src/services/omada.js`)

```js
let cachedSiteKey = null;

async function resolveSiteKey(cookie, token) {
  if (cachedSiteKey) return cachedSiteKey;
  // GET {baseUrl}/{controllerId}/api/v2/current/sites  (auth via cookie+token,
  // same headers pattern as authorizeClient)
  // find entry where entry.name === config.omada.site
  // cache entry.id in cachedSiteKey and return it
  // throw a clear error if no matching site name is found
}
```

Resolved once per process and cached in memory (module-level variable) — not
persisted, not exposed as config. If the operator ever renames the site in Omada,
a process restart picks up the change.

### `getConnectedClients()`

```js
export async function getConnectedClients() {
  if (config.mockMode) {
    return {
      total: 3,
      clients: [
        { mac: 'AA:BB:CC:00:00:01', name: 'Guest-Phone-1', ip: '192.168.1.101', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(Date.now() - 15*60000).toISOString() },
        { mac: 'AA:BB:CC:00:00:02', name: 'Guest-Phone-2', ip: '192.168.1.102', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(Date.now() - 42*60000).toISOString() },
        { mac: 'AA:BB:CC:00:00:03', name: 'Guest-Laptop',  ip: '192.168.1.103', ssid: 'FirstStreet', apName: 'Lobby-AP', connectedAt: new Date(Date.now() - 3*60000).toISOString() },
      ],
    };
  }

  const { token, cookie } = await omadaLogin();
  const siteKey = await resolveSiteKey(cookie, token);

  // GET {baseUrl}/{controllerId}/api/v2/sites/{siteKey}/clients
  //   ?currentPage=1&currentPageSize=100&filters.active=true
  // normalize each row into { mac, name, ip, ssid, apName, connectedAt }
  return { total, clients };
}
```

Error handling matches `authorizeClient()`'s existing pattern: on login failure,
missing site, or a non-zero `errorCode`, throw an `Error` with a descriptive
message. Callers (the future dashboard route) catch this and render a
"connected users unavailable" state rather than failing the whole page.

**Field-mapping caveat:** TP-Link's exact JSON field names for the clients
endpoint (e.g. whether it's `mac` or `clientMac`, `name` or `hostName`) cannot be
confirmed without a live call against a real controller. The normalizer will be
written against the best available public documentation/examples, then corrected
against real response data in the verification step below — this is called out
explicitly rather than presented as confirmed behavior.

### Mock mode

`MOCK_MODE=true` (already the project default) returns the fixture data above
unconditionally — no network calls, no controller required. This lets the
dashboard sub-project proceed independently of the hardware migration timeline.

## Testing

Manual verification, no automated integration tests (no CI-accessible Omada
hardware):

1. `MOCK_MODE=true`: call `getConnectedClients()` (e.g. via a scratch script or
   temporary route) → returns the 3-client fixture without any network activity.
2. Migrate "Africom Hotspot" to the physical controller in the Omada app; create
   the Hotspot Operator account; set `MOCK_MODE=false` and point `OMADA_BASE_URL`
   /`OMADA_CONTROLLER_ID` at it per the existing README instructions.
3. Buy a voucher end-to-end through the real portal and confirm the client is
   actually authorized on the physical controller (`authorizeClient()` regression
   check — no code change expected here, but this is the first real-hardware use
   of that path).
4. Call `getConnectedClients()` against the real controller; compare the raw JSON
   response against the assumed field names in the normalizer; adjust field
   mapping in code if they differ.
5. Disconnect/connect a test device and re-call `getConnectedClients()` to
   confirm the active-clients filter reflects reality (not a cached/stale list).
