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

## Switching to PostgreSQL later

Only `src/db/index.js` and the query calls need changing. The schema is standard SQL.

## Notes / next steps

- Card payments (Stripe/Paystack) can be added as another method alongside mobile money.
- SMS/email receipts: hook into `finalizePaidTransaction()` in `src/routes/pay.js`.
- `/admin` now requires login (`ADMIN_USER`/`ADMIN_PASSWORD` in `.env`). Before
  a public deploy: serve over HTTPS and set `cookie.secure: true` in
  `src/server.js` so the admin session cookie isn't sent in cleartext.
