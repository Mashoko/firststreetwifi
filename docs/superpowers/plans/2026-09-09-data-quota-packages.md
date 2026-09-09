# Data-quota Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 4 time-based packages with 5 data-quota packages (1GB–10GB), enforced by Omada's own `totalTrafficLimitBytes` API param, while keeping already-sold legacy vouchers redeemable.

**Architecture:** `packages.js` becomes the single source of truth for the 5 new packages (plus a private legacy-lookup fallback for 4 retired ids). `authorizeClient()` gains an optional `dataBytes` arg forwarded to Omada's existing authorization call — no new enforcement loop, no polling, no new tables beyond one nullable column. Two purchase paths (Paynow buy, voucher redemption) both thread the package's `dataBytes`/`dataGB` through to Omada and to the customer-facing confirmation.

**Tech Stack:** Node.js (ESM), Express, EJS views, better-sqlite3. No test framework — this project verifies manually (curl / `node -e` probes), matching its existing convention throughout.

**Spec:** `docs/superpowers/specs/2026-09-09-data-quota-packages-design.md`

## Global Constraints

- The 5 packages, exact values (id / dataGB / price USD / minutes): `1gb`/1/0.50/1440, `2gb`/2/1.00/1440, `3gb`/3/2.00/10080, `5gb`/5/3.00/20160, `10gb`/10/5.00/43200. Do not round or reinterpret.
- `dataBytes = dataGB * 1024 * 1024 * 1024` exactly, no rounding.
- The old `quick`/`day`/`week`/`month` ids must not appear in anything purchasable or displayed as an offering, but must still resolve (time-only, no data cap) for redeeming an already-issued voucher or finalizing an in-flight transaction.
- The backend is the sole source of truth for price/data/duration — the client only ever sends a `packageId` string, never a price or byte count. This already holds; don't break it.
- No customer accounts, no live used/remaining meter, no stacking of active packages. Out of scope — do not add.

---

### Task 1: Package definitions with legacy fallback

**Files:**
- Modify: `src/packages.js` (entire file — currently 12 lines)

**Interfaces:**
- Produces: `PACKAGES` (array of `{id, name, dataGB, dataBytes, price, minutes}`), `getPackage(id)` → same shape for a current package, or `{id, name, minutes, price}` (no `dataGB`/`dataBytes`) for one of the 4 legacy ids, or `undefined` for anything else.

- [ ] **Step 1: Rewrite `src/packages.js`**

```javascript
// ─── WiFi Packages / Pricing ──────────────────────────────
// Edit freely. `dataGB` = data allowance; `minutes` = hard time-based
// safety-net expiry (a package that's barely used still expires on
// schedule). Omada enforces whichever of time / data is hit first.
// `price` is in USD (Paynow settles in the currency your account is set to).
const GB = 1024 * 1024 * 1024;

export const PACKAGES = [
  { id: '1gb',  name: '1GB',  dataGB: 1,  price: 0.50, minutes: 1440 },
  { id: '2gb',  name: '2GB',  dataGB: 2,  price: 1.00, minutes: 1440 },
  { id: '3gb',  name: '3GB',  dataGB: 3,  price: 2.00, minutes: 10080 },
  { id: '5gb',  name: '5GB',  dataGB: 5,  price: 3.00, minutes: 20160 },
  { id: '10gb', name: '10GB', dataGB: 10, price: 5.00, minutes: 43200 },
].map((p) => ({ ...p, dataBytes: p.dataGB * GB }));

// Retired ids — never offered/sold/displayed, but must still resolve so an
// already-issued voucher (or an in-flight transaction spanning a deploy)
// can be redeemed/finalized for what was actually sold. Time-only: these
// never had a data cap, so they get none now (see getPackage below).
const LEGACY_PACKAGES = [
  { id: 'quick', name: 'Quick Browse', price: 0.50, minutes: 60 },
  { id: 'day',   name: 'Day Pass',     price: 2.00, minutes: 60 * 24 },
  { id: 'week',  name: 'Week Pass',    price: 8.00, minutes: 60 * 24 * 7 },
  { id: 'month', name: 'Month Pass',   price: 25.00, minutes: 60 * 24 * 30 },
];

export const getPackage = (id) =>
  PACKAGES.find((p) => p.id === id) || LEGACY_PACKAGES.find((p) => p.id === id);
```

- [ ] **Step 2: Verify manually**

Run: `node -e "import('./src/packages.js').then(m => { console.log(JSON.stringify(m.PACKAGES, null, 2)); console.log('legacy day:', JSON.stringify(m.getPackage('day'))); console.log('unknown:', m.getPackage('nope')); })"`

Expected: 5 packages printed, each with `dataBytes` equal to `dataGB * 1073741824` (e.g. `1gb` → `dataBytes: 1073741824`, `10gb` → `10737418240`). `legacy day:` prints `{"id":"day","name":"Day Pass","price":2,"minutes":1440}` (no `dataGB`/`dataBytes` keys). `unknown:` prints `undefined`.

- [ ] **Step 3: Commit**

```bash
git add src/packages.js
git commit -m "feat: replace time-based packages with data-quota packages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `data_bytes` column on the vouchers table

**Files:**
- Modify: `src/db/index.js:11-49` (`initSchema()`)

**Interfaces:**
- Consumes: nothing new
- Produces: `vouchers.data_bytes` column (INTEGER, nullable) — Task 3 writes to it, Task 6 reads it.

- [ ] **Step 1: Add a guarded `ALTER TABLE` after the existing `CREATE TABLE`/`CREATE INDEX` block**

In `initSchema()`, after the existing `db.exec(...)` call (which ends with the two `CREATE INDEX IF NOT EXISTS` lines), add:

```javascript
  // SQLite's CREATE TABLE IF NOT EXISTS doesn't retroactively add columns
  // to an already-existing table, so new columns need their own guarded
  // ALTER TABLE. This one only fires once per (existing) DB file — silently
  // fine to re-run since we check for the column first.
  const voucherCols = db.prepare(`PRAGMA table_info(vouchers)`).all().map((c) => c.name);
  if (!voucherCols.includes('data_bytes')) {
    db.exec(`ALTER TABLE vouchers ADD COLUMN data_bytes INTEGER`);
  }
```

- [ ] **Step 2: Verify manually — fresh DB**

Run: `rm -f /tmp/test-quota.sqlite && DB_TEST=1 node -e "
process.env.SQLITE_TEST_PATH = '/tmp/test-quota.sqlite';
" 2>/dev/null; node -e "
import('better-sqlite3').then(async ({default: Database}) => {
  const db = new Database('/tmp/test-quota.sqlite');
  const { initSchema } = await import('./src/db/index.js');
})"

(Simpler: since `src/db/index.js` hardcodes its path to `data.sqlite` in the project root, just run the project's own init script against a scratch copy.) Run instead:

```bash
cp data.sqlite /tmp/data.sqlite.bak 2>/dev/null || true
npm run init-db
node -e "
import('better-sqlite3').then(({default: Database}) => {
  const db = new Database('data.sqlite');
  const cols = db.prepare('PRAGMA table_info(vouchers)').all().map(c => c.name);
  console.log(cols);
});
"
```

Expected: the printed column list includes `data_bytes`. Run `npm run init-db` a second time immediately after — must not error (idempotency check for the guard).

- [ ] **Step 3: Commit**

```bash
git add src/db/index.js
git commit -m "feat: add data_bytes column to vouchers table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `createVoucher()` stores the data allocation

**Files:**
- Modify: `src/services/vouchers.js:14-29`

**Interfaces:**
- Consumes: `vouchers.data_bytes` column (Task 2)
- Produces: `createVoucher({packageId, minutes, dataBytes, transactionId})` → `{id, code, minutes, dataBytes, packageId}` (added `dataBytes` to both the param object and the return value)

- [ ] **Step 1: Update `createVoucher`**

Replace:
```javascript
export function createVoucher({ packageId, minutes, transactionId }) {
  let code;
  // Ensure uniqueness
  for (let attempt = 0; attempt < 10; attempt++) {
    code = randomCode();
    const exists = db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code);
    if (!exists) break;
  }
  const info = db
    .prepare(
      `INSERT INTO vouchers (code, package_id, minutes, transaction_id, status)
       VALUES (?, ?, ?, ?, 'unused')`
    )
    .run(code, packageId, minutes, transactionId);
  return { id: info.lastInsertRowid, code, minutes, packageId };
}
```

With:
```javascript
export function createVoucher({ packageId, minutes, dataBytes, transactionId }) {
  let code;
  // Ensure uniqueness
  for (let attempt = 0; attempt < 10; attempt++) {
    code = randomCode();
    const exists = db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code);
    if (!exists) break;
  }
  const info = db
    .prepare(
      `INSERT INTO vouchers (code, package_id, minutes, data_bytes, transaction_id, status)
       VALUES (?, ?, ?, ?, ?, 'unused')`
    )
    .run(code, packageId, minutes, dataBytes ?? null, transactionId);
  return { id: info.lastInsertRowid, code, minutes, dataBytes, packageId };
}
```

- [ ] **Step 2: Verify manually**

Run:
```bash
node -e "
import('./src/services/vouchers.js').then(({ createVoucher, findVoucher }) => {
  const v = createVoucher({ packageId: '5gb', minutes: 20160, dataBytes: 5368709120, transactionId: null });
  console.log('created:', JSON.stringify(v));
  console.log('read back:', JSON.stringify(findVoucher(v.code)));
});
"
```

Expected: `created:` shows `dataBytes:5368709120`. `read back:` (the raw DB row) shows `"data_bytes":5368709120`.

- [ ] **Step 3: Commit**

```bash
git add src/services/vouchers.js
git commit -m "feat: store data_bytes allocation on created vouchers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `authorizeClient()` accepts an optional data cap

**Files:**
- Modify: `src/services/omada.js:48-87` (`authorizeClient`)

**Interfaces:**
- Consumes: nothing new
- Produces: `authorizeClient(clientInfo, durationMinutes, dataBytes?)` → `{success: true}` (unchanged return shape). When `dataBytes` is a positive number, the outgoing `extPortal/auth` request body includes `totalTrafficLimitBytes: dataBytes`; when omitted/falsy, that field is left out of the body entirely (not sent as `0` or `null`).

- [ ] **Step 1: Update the function signature and body construction**

Replace:
```javascript
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
```

With:
```javascript
export async function authorizeClient(clientInfo, durationMinutes, dataBytes) {
  const timeMs = durationMinutes * 60 * 1000;

  if (config.mockMode) {
    const dataNote = dataBytes ? `, ${dataBytes} bytes` : '';
    console.log(`[MOCK] Omada authorize: client=${clientInfo.clientMac} for ${durationMinutes}min${dataNote}`);
    return { success: true, mock: true };
  }

  const { token, cookie } = await omadaLogin();

  const url = `${config.omada.baseUrl}/${config.omada.controllerId}/api/v2/hotspot/extPortal/auth`;

  // Wireless (EAP) auth payload. authType 4 = external portal.
  // totalTrafficLimitBytes is only set when dataBytes is provided — a
  // legacy (pre-data-quota) voucher redemption authorizes time-only,
  // exactly as it always has, rather than gaining an invented data cap.
  const body = {
    clientMac: clientInfo.clientMac,
    apMac: clientInfo.apMac,
    ssidName: clientInfo.ssidName,
    radioId: clientInfo.radioId,
    site: clientInfo.site || config.omada.site,
    time: timeMs,
    authType: 4,
  };
  if (dataBytes) {
    body.totalTrafficLimitBytes = dataBytes;
  }
```

(The rest of the function — the `fetch(url, {...})` call using `body` and everything after — is unchanged.)

- [ ] **Step 2: Verify manually — mock mode**

Run: `MOCK_MODE=true node -e "
import('./src/services/omada.js').then(async ({ authorizeClient }) => {
  const r1 = await authorizeClient({ clientMac: 'AA:BB:CC:00:00:01' }, 1440, 1073741824);
  console.log('with data:', r1);
  const r2 = await authorizeClient({ clientMac: 'AA:BB:CC:00:00:02' }, 60);
  console.log('without data:', r2);
});
"`

Expected: two `[MOCK] Omada authorize:` lines print, the first including `, 1073741824 bytes`, the second without it. Both calls resolve `{success: true, mock: true}`.

- [ ] **Step 3: Verify manually — real controller (skip if not reachable right now; confirm before merging)**

Using the project's established manual-probe pattern (see the `node -e` probes used earlier in this project against `src/services/omada.js`), call `authorizeClient` with `MOCK_MODE=false` and real `.env` credentials, once with a `dataBytes` value and once without, against a currently-connected test client's real MAC. Confirm both calls return `{success: true}` (or the same "Failed to authenticate" error as before for a MAC that isn't actually on the portal-pending SSID — that's expected, not a regression). This can't be scripted here since it depends on a live device being on the guest SSID at test time.

- [ ] **Step 4: Commit**

```bash
git add src/services/omada.js
git commit -m "feat: authorizeClient supports optional data-volume cap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the Paynow purchase flow through

**Files:**
- Modify: `src/routes/pay.js:12-41` (`finalizePaidTransaction`) and `:45-64` (`/status/:reference`)

**Interfaces:**
- Consumes: `createVoucher({packageId, minutes, dataBytes, transactionId})` (Task 3), `authorizeClient(clientInfo, minutes, dataBytes)` (Task 4), `getPackage(id)` (Task 1, already imported)
- Produces: `GET /pay/status/:reference` JSON now includes `dataGB` and `name` alongside `status`/`voucher` when `status === 'paid'`.

- [ ] **Step 1: Update `finalizePaidTransaction` to pass `dataBytes` through**

Replace:
```javascript
  // Generate voucher if not already done.
  let voucherCode = tx.voucher_code;
  if (!voucherCode) {
    const v = createVoucher({ packageId: pkg.id, minutes: pkg.minutes, transactionId: tx.id });
    voucherCode = v.code;
```

With:
```javascript
  // Generate voucher if not already done.
  let voucherCode = tx.voucher_code;
  if (!voucherCode) {
    const v = createVoucher({ packageId: pkg.id, minutes: pkg.minutes, dataBytes: pkg.dataBytes, transactionId: tx.id });
    voucherCode = v.code;
```

And replace:
```javascript
    try {
      await authorizeClient(clientInfo, pkg.minutes);
      markVoucherUsed(voucherCode, pkg.minutes);
```

With:
```javascript
    try {
      await authorizeClient(clientInfo, pkg.minutes, pkg.dataBytes);
      markVoucherUsed(voucherCode, pkg.minutes);
```

- [ ] **Step 2: Extend `/status/:reference` to return package info alongside the voucher**

Replace:
```javascript
  if (tx.status === 'paid' && tx.voucher_code) {
    return res.json({ status: 'paid', voucher: tx.voucher_code });
  }

  try {
    const result = await pollPayment(tx.poll_url);
    if (result.paid) {
      const voucher = await finalizePaidTransaction(tx);
      return res.json({ status: 'paid', voucher });
    }
```

With:
```javascript
  if (tx.status === 'paid' && tx.voucher_code) {
    const paidPkg = getPackage(tx.package_id);
    return res.json({ status: 'paid', voucher: tx.voucher_code, dataGB: paidPkg?.dataGB, name: paidPkg?.name });
  }

  try {
    const result = await pollPayment(tx.poll_url);
    if (result.paid) {
      const voucher = await finalizePaidTransaction(tx);
      const paidPkg = getPackage(tx.package_id);
      return res.json({ status: 'paid', voucher, dataGB: paidPkg?.dataGB, name: paidPkg?.name });
    }
```

- [ ] **Step 3: Verify manually**

With the app running in mock mode (`MOCK_MODE=true npm start` or equivalent), go through a full purchase in the browser for the `5gb` package. Confirm the browser network tab shows `/pay/status/:reference`'s final response includes `"dataGB":5,"name":"5GB"` alongside the voucher code. (Task 9 wires this into the visible UI — this step only confirms the JSON contract Task 9 depends on.)

- [ ] **Step 4: Commit**

```bash
git add src/routes/pay.js
git commit -m "feat: thread data allocation through the Paynow purchase flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the voucher-redemption flow through

**Files:**
- Modify: `src/routes/login.js:28-31`

**Interfaces:**
- Consumes: `authorizeClient(clientInfo, minutes, dataBytes)` (Task 4), `voucher.data_bytes` (Task 2's column, read via the existing `SELECT *` in `findVoucher`)

- [ ] **Step 1: Pass `voucher.data_bytes` through**

Replace:
```javascript
  try {
    await authorizeClient(clientInfo, voucher.minutes);
    if (voucher.status === 'unused') markVoucherUsed(code, voucher.minutes);
    return res.render('success', { minutes: voucher.minutes, pkg });
```

With:
```javascript
  try {
    await authorizeClient(clientInfo, voucher.minutes, voucher.data_bytes);
    if (voucher.status === 'unused') markVoucherUsed(code, voucher.minutes);
    return res.render('success', { minutes: voucher.minutes, pkg });
```

(`voucher.data_bytes` is `null` for a legacy voucher, which `authorizeClient`'s `if (dataBytes)` check in Task 4 correctly treats as "no cap" — no special-casing needed here.)

- [ ] **Step 2: Verify manually**

Run the DB probe from Task 3 to create a `5gb` voucher with a real `data_bytes` value, then redeem it through the running app's `/login` route (mock mode) with a test `clientMac` in the session/query — confirm no error, and check the mock-mode console log line from Task 4's Step 2 shows the byte count for this redemption. Then repeat with a voucher seeded with `package_id='day'` and `data_bytes=NULL` (a stand-in for a legacy voucher) — confirm it still authorizes successfully with no byte count in the mock log line.

- [ ] **Step 3: Commit**

```bash
git add src/routes/login.js
git commit -m "feat: thread data allocation through voucher redemption

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Package cards show data + duration

**Files:**
- Modify: `views/portal.ejs:27-37` (the `.packages` block)

**Interfaces:**
- Consumes: `PACKAGES` entries now have `dataGB` (Task 1); `p.blurb` no longer exists (removed in Task 1's rewrite) — this task must not reference it.

- [ ] **Step 1: Add a duration-label helper and update the card markup**

Replace:
```html
      <div class="packages">
        <% packages.forEach(function(p){ %>
          <div class="pkg" data-id="<%= p.id %>" onclick="selectPkg(this)">
            <div>
              <div class="name"><%= p.name %></div>
              <div class="blurb"><%= p.blurb %></div>
            </div>
            <div class="price">$<%= p.price.toFixed(2) %></div>
          </div>
        <% }); %>
      </div>
```

With:
```html
      <div class="packages">
        <% packages.forEach(function(p){
          var days = Math.round(p.minutes / 1440);
          var durationLabel = days >= 1 ? (days + ' Day' + (days > 1 ? 's' : '')) : Math.round(p.minutes / 60) + ' Hours';
        %>
          <div class="pkg" data-id="<%= p.id %>" onclick="selectPkg(this)">
            <div>
              <div class="name"><%= p.name %></div>
              <div class="blurb"><%= p.dataGB %>GB · <%= durationLabel %></div>
            </div>
            <div class="price">$<%= p.price.toFixed(2) %></div>
          </div>
        <% }); %>
      </div>
```

(The `.blurb` CSS class is reused as-is — only the text content changes, no style change needed since it's still one short line of muted secondary text.)

- [ ] **Step 2: Verify manually**

Start the app (mock mode) and load `/`. Confirm all 5 cards render: "1GB · 1 Day — $0.50", "2GB · 1 Day — $1.00", "3GB · 7 Days — $2.00", "5GB · 14 Days — $3.00", "10GB · 30 Days — $5.00". Confirm clicking a card still selects it (existing `selectPkg` JS is untouched, so this is a smoke check, not a new behavior).

- [ ] **Step 3: Commit**

```bash
git add views/portal.ejs
git commit -m "feat: show data allowance and duration on package cards

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Voucher-redemption confirmation shows the GB amount

**Files:**
- Modify: `views/success.ejs:17-25`

**Interfaces:**
- Consumes: `pkg` (already passed by `login.js`'s render call, Task 6 unchanged this) — `pkg.dataGB` is present for a current package, `undefined` for a legacy one.

- [ ] **Step 1: Add a guarded GB line**

Replace:
```html
    <div class="card center">
      <div class="big-icon">✅</div>
      <h2>Connected!</h2>
      <p class="lead"><%= pkg ? pkg.name : 'Access' %> active for
        <% var h = Math.floor(minutes/60); var d = Math.floor(h/24); %>
        <strong><%= d >= 1 ? d + ' day' + (d>1?'s':'') : h + ' hour' + (h>1?'s':'') %></strong>.
      </p>
      <p class="note">Enjoy your internet. This tab can be closed.</p>
    </div>
```

With:
```html
    <div class="card center">
      <div class="big-icon">✅</div>
      <h2>Connected!</h2>
      <p class="lead"><%= pkg ? pkg.name : 'Access' %><% if (pkg && pkg.dataGB) { %> — <strong><%= pkg.dataGB %>GB</strong><% } %> active for
        <% var h = Math.floor(minutes/60); var d = Math.floor(h/24); %>
        <strong><%= d >= 1 ? d + ' day' + (d>1?'s':'') : h + ' hour' + (h>1?'s':'') %></strong>.
      </p>
      <p class="note">Enjoy your internet. This tab can be closed.</p>
    </div>
```

- [ ] **Step 2: Verify manually**

Redeem a `5gb` voucher through `/login` (mock mode) and confirm the success page reads "5GB — **5GB** active for **14 days**." (the package name happens to equal "5GB" here, so this looks slightly redundant only for this specific package's `name`/`dataGB` combination — that's a copy quirk inherent to the package naming already locked in the spec, not a bug in this task). Then redeem a legacy-style voucher (`package_id='day'`, no `data_bytes`) and confirm the page reads "Day Pass active for **1 day**." with no dangling "— GB" text.

- [ ] **Step 3: Commit**

```bash
git add views/success.ejs
git commit -m "feat: show data allowance on voucher redemption confirmation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Paynow purchase confirmation shows the GB amount

**Files:**
- Modify: `views/waiting.ejs:25-31` (the `#done` card) and `:46-56` (the `poll()` function)

**Interfaces:**
- Consumes: `/pay/status/:reference` JSON now includes `dataGB`/`name` when paid (Task 5).

- [ ] **Step 1: Add a data-amount element to the `#done` card**

Replace:
```html
    <div class="card center" id="done" style="display:none">
      <div class="big-icon">🎉</div>
      <h2>You're connected!</h2>
      <p class="lead">Your voucher code (save it):</p>
      <div class="voucher-code" id="voucherCode">—</div>
      <p class="note">You now have internet access. Enjoy!</p>
    </div>
```

With:
```html
    <div class="card center" id="done" style="display:none">
      <div class="big-icon">🎉</div>
      <h2>You're connected!</h2>
      <p class="lead" id="doneAllowance"></p>
      <p class="lead">Your voucher code (save it):</p>
      <div class="voucher-code" id="voucherCode">—</div>
      <p class="note">You now have internet access. Enjoy!</p>
    </div>
```

- [ ] **Step 2: Populate it from the poll response**

Replace:
```javascript
        if (data.status === 'paid') {
          document.getElementById('pending').style.display = 'none';
          document.getElementById('voucherCode').textContent = data.voucher || '—';
          document.getElementById('done').style.display = 'block';
          return;
        }
```

With:
```javascript
        if (data.status === 'paid') {
          document.getElementById('pending').style.display = 'none';
          document.getElementById('voucherCode').textContent = data.voucher || '—';
          const allowanceEl = document.getElementById('doneAllowance');
          allowanceEl.textContent = data.dataGB ? (data.name + ' — ' + data.dataGB + 'GB') : '';
          document.getElementById('done').style.display = 'block';
          return;
        }
```

- [ ] **Step 3: Verify manually**

Go through a full purchase in the browser (mock mode) for the `3gb` package. Confirm the `#done` card shows "3GB — 3GB" above the voucher code (same naming-overlap copy quirk noted in Task 8, not a bug), and that the voucher code still displays correctly. Confirm the previous behavior (voucher code shown, page transitions from spinner to done state) is otherwise unchanged.

- [ ] **Step 4: Commit**

```bash
git add views/waiting.ejs
git commit -m "feat: show data allowance on Paynow purchase confirmation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification against the real controller

**Files:** none (verification-only task)

- [ ] **Step 1: Restore/confirm production `.env` is untouched**

This plan makes no `.env` changes. Confirm `MOCK_MODE`, `OMADA_*`, and `PAYNOW_*` values in the deployed `.env` are exactly what they were before this work (`git diff` touches no env file, so this is a sanity check, not an expected change).

- [ ] **Step 2: Full real-hardware purchase test**

Using a real device on the `Africom Hotspot` SSID (same manual process used earlier in this project to validate the original captive-portal integration): pick one package (e.g. `1gb`), go through the real portal, complete a real Paynow payment, and confirm on the OC200's own client view (or `npm run check-clients` if the operator-scope limitation noted earlier doesn't block it) that the client was authorized. Full byte-level enforcement can't be verified without actually consuming 1GB — treat "the authorize call succeeded with the right `totalTrafficLimitBytes`" (confirmed already in Task 4/5's manual checks) as sufficient evidence Omada received the correct cap.

- [ ] **Step 3: Confirm a second purchase replaces the first (spec's "no stacking" decision)**

With one test device: redeem/purchase a small package (e.g. `1gb`) and confirm it authorizes. Without waiting for it to expire, purchase a different package (e.g. `5gb`) for the *same device* and confirm the second `authorizeClient()` call succeeds — Omada's existing per-MAC re-authorization behavior means this needs no new code (per the spec's "New purchase replaces the old one" decision), but confirm it in practice: the device should end up with the second package's limits in effect, not an error from calling authorize twice for one MAC.

- [ ] **Step 4: Legacy voucher regression check on the real DB**

Before deploying, run: `sqlite3 data.sqlite "SELECT code, package_id, status, expires_at FROM vouchers WHERE status='unused' AND package_id IN ('quick','day','week','month')"` (or the `better-sqlite3` `node -e` equivalent, since `sqlite3` CLI isn't installed on the production server per earlier findings in this project — use `node -e "import('better-sqlite3').then(({default:D})=>{const db=new D('data.sqlite');console.log(db.prepare(\"SELECT code, package_id, status FROM vouchers WHERE status='unused' AND package_id IN ('quick','day','week','month')\").all())})"` instead). If any rows come back, redeem one for real through `/login` post-deploy and confirm it still works (Task 6's fallback path, now exercised for real instead of a seeded test row).

- [ ] **Step 5: Commit (if Steps 2-4 turned up nothing to fix)**

No code change expected from this task; nothing to commit unless verification surfaces a bug, in which case fix it as its own follow-up task before considering this plan complete.
