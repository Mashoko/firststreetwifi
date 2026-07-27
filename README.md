# First Street WiFi — Hotspot Billing Portal

Self-hosted captive-portal billing for a TP-Link **Omada** hotspot, with **Paynow**
(EcoCash / OneMoney) payments. Customers buy a WiFi pass, pay by mobile money, and
get authorized onto the network automatically. Existing voucher holders log in directly.

You control: login page, branding, pricing, packages, payments, user database, and
reports. Omada is just the network controller.

---

## Quick start (local dev)

```bash
npm install
cp .env.example .env        # then edit .env (see below)
npm run init-db             # creates data.sqlite
npm start                   # http://localhost:3000
```

Open:
- Portal: http://localhost:3000/
- Admin/reports: http://localhost:3000/admin

By default `MOCK_MODE=true`, so **no real Omada or Paynow calls are made** — payments
auto-succeed and vouchers generate, so you can click through the whole flow safely.

To simulate the captive-portal redirect that Omada would send, open:
```
http://localhost:3000/?clientMac=AA-BB-CC-DD-EE-FF&apMac=11-22-33-44-55-66&ssidName=FirstStreet&radioId=0&site=Default
```

---

## Configuration (`.env`)

### Paynow (you already have these)
```
PAYNOW_INTEGRATION_ID=...
PAYNOW_INTEGRATION_KEY=...
PAYNOW_AUTH_EMAIL=you@example.com   # in test mode, must match a merchant login email
```

### Omada — two things you still need to confirm

**1. Controller type.** Log into your Omada dashboard:
   - If the address looks like `https://<some-ip>:8043/...` → **software/hardware** controller.
     Set `OMADA_CONTROLLER_TYPE=software` and `OMADA_BASE_URL=https://<ip>:8043`.
   - If it's `https://omada.tplinkcloud.com/...` (TP-Link hosted) → **cloud** controller.
     Set `OMADA_CONTROLLER_TYPE=cloud`. Cloud controllers use a region base URL and the
     Open API; tell me which region and I'll wire the exact endpoint.

**2. Controller ID.** After logging in, look at the browser URL:
   `https://CONTROLLER:PORT/<THIS_LONG_ID>/...` — copy that segment into
   `OMADA_CONTROLLER_ID`. (Required for controller v5.0.15+.)

**3. Hotspot operator account.** In Omada go to **Hotspot Manager → Operators** and
   create an operator login. Put it in `OMADA_OPERATOR_USER` / `OMADA_OPERATOR_PASS`.
   ⚠️ This is NOT your admin account — it's a separate operator used by the portal API.

Then in Omada: **Settings → Authentication → Portal**, create a portal, set
authentication type to **External Portal Server**, and point it at your server's URL
(`BASE_URL`). Bind it to your hotspot SSID.

Finally set `MOCK_MODE=false` to go live.

---

## How it works

```
Customer connects to WiFi
   → Omada intercepts, redirects to  BASE_URL/?clientMac=...&apMac=...&ssidName=...
   → Portal page: pick package + enter phone
   → POST /buy  → Paynow EcoCash/OneMoney push  → waiting page polls /pay/status/:ref
   → On "Paid": voucher generated + Omada extPortal/auth authorizes the client
   → Customer is online
```

Existing voucher: `POST /login` with the code → Omada authorizes the client directly.

---

## Files

- `src/services/omada.js` — Omada hotspot login + client authorization (v5.0.15+ flow)
- `src/services/paynow.js` — Paynow mobile (EcoCash/OneMoney) express checkout
- `src/services/vouchers.js` — voucher generation & validation
- `src/routes/` — portal, pay, login, admin
- `src/packages.js` — **edit this to change pricing/packages**
- `views/` — EJS templates (branding lives here + `public/style.css`)

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
   ⚠️ **`OMADA_VERIFY_TLS=false` does not currently work.** Node's native
   `fetch` (undici) silently ignores the `https.Agent` option
   `src/services/omada.js` passes to it, so every call to a controller with
   a self-signed cert (the default on an OC200/OC300) will throw
   `DEPTH_ZERO_SELF_SIGNED_CERT` regardless of that setting. Workaround for
   local testing only: prefix the command with
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, e.g.
   `NODE_TLS_REJECT_UNAUTHORIZED=0 npm run check-clients` (same prefix for
   `npm start` when going live). This disables TLS verification for the
   *entire* Node process, not just Omada calls — insecure, fine for a quick
   local check, not something to run in production. A real fix (switching
   to undici's `dispatcher` option, or importing the controller's cert into
   the OS trust store) is out of scope for this branch and should be
   tracked separately before relying on this against a live controller.
3. Buy a voucher through the real portal end-to-end and confirm the paying
   client actually gets network access (this is the first real-hardware use
   of the existing `authorizeClient()` flow — no code change is expected,
   but it hasn't been tested against real hardware before).
4. Run `npm run check-clients` again (now hitting the real controller).
   The printed output uses normalized field names: `mac`, `name`, `ip`,
   `ssid`, `apName`, `connectedAt`. If any of those are empty or `null`,
   the raw API field names didn't match `getConnectedClients()`'s `.map()`
   guesses — inspect the real response and update those fallback guesses
   in `src/services/omada.js` accordingly.
5. Connect/disconnect a test device on the hotspot Wi-Fi and re-run
   `npm run check-clients` to confirm the list actually changes (i.e. it's
   reading live state, not a cached/stale result).

## Switching to PostgreSQL later

Only `src/db/index.js` and the query calls need changing. The schema is standard SQL.

## Notes / next steps

- Card payments (Stripe/Paystack) can be added as another method alongside mobile money.
- SMS/email receipts: hook into `finalizePaidTransaction()` in `src/routes/pay.js`.
- `/admin` now requires login (`ADMIN_USER`/`ADMIN_PASSWORD` in `.env`). Before
  a public deploy: serve over HTTPS and set `cookie.secure: true` in
  `src/server.js` so the admin session cookie isn't sent in cleartext.
