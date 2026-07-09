# Admin authentication — design

## Problem

`/admin` currently renders revenue and transaction data (phone numbers, voucher
codes, amounts) to anyone who requests it, with no login of any kind. This
must be closed before the portal is deployed publicly.

## Goals

- Require login to view `/admin`.
- Keep it consistent with the rest of the app: same session mechanism
  (`express-session`, already used to carry `clientInfo`), same visual style
  (`.wrap` / `.brand` / `.card` classes already in `views/admin.ejs`).
- Single operator account is sufficient — this is a one-person business.

## Non-goals (YAGNI)

- Multiple admin accounts / roles.
- Password reset flow.
- Rate limiting or lockout on failed login attempts.
- CSRF tokens — no other form in the app has them (`/buy`, `/login`), so
  adding them only to the admin form would be an inconsistent half-measure.

## Design

### Credentials

`ADMIN_USER` / `ADMIN_PASSWORD` added to `.env` / `.env.example`, read into
`config.admin = { user, password }` in `src/config.js` — same pattern as
`config.paynow` / `config.omada`. Plaintext, matching how the Paynow
integration key is already stored; `.env` is gitignored and never leaves the
server.

If either var is empty, admin routes must respond `503` with a message
telling the operator to configure `.env`, rather than allowing or silently
blocking access. Fail closed, not fail open.

### Session flag

On successful login, `req.session.isAdmin = true`. No new session store is
needed — the existing `express-session` middleware in `server.js` already
applies globally.

### Routes (`src/routes/admin.js`)

- `GET /admin/login` — renders `admin-login.ejs`. If `req.session.isAdmin` is
  already true, redirect straight to `/admin`.
- `POST /admin/login` — reads `username`/`password` from the form body.
  Compares against `config.admin.user`/`password` using
  `crypto.timingSafeEqual` on fixed-length buffers (constant-time compare,
  avoids leaking a match via response timing). On success, sets
  `req.session.isAdmin = true` and redirects to `/admin`. On failure,
  re-renders `admin-login.ejs` with an error message (HTTP 401).
- `GET /admin/logout` — clears `req.session.isAdmin` and redirects to
  `/admin/login`.
- `GET /admin` (existing reports route) — gated by a `requireAdminAuth`
  middleware applied only to this route. Unauthenticated requests redirect to
  `/admin/login`.

Route order in the router: `/login` and `/logout` are registered before the
middleware-guarded `/` route so they remain reachable without a session.

### View

- New `views/admin-login.ejs`: username + password fields, POSTs to
  `/admin/login`, reuses existing page chrome (`.wrap`, `.brand`, `.card`)
  and shows the error message inline when present.
- `views/admin.ejs` gets a small "Log out" link (`<a href="/admin/logout">`)
  next to the existing heading.

### Timing-safe comparison detail

Username and password are compared independently with
`crypto.timingSafeEqual`, after padding both sides to equal length (or
hashing both with the same fixed-length digest) so `timingSafeEqual` doesn't
throw on length mismatch. A wrong username and a wrong password both take the
same code path and return the same generic "Invalid username or password"
error — no distinction between "user not found" and "wrong password".

## Testing

Manual verification (mock mode, no external services needed):

1. `GET /admin` while logged out → redirects to `/admin/login`.
2. `POST /admin/login` with wrong credentials → 401, error shown, still on
   login page.
3. `POST /admin/login` with correct credentials → redirects to `/admin`,
   reports page renders.
4. `GET /admin/logout` → session cleared, subsequent `GET /admin` redirects
   to login again.
5. Unset `ADMIN_USER`/`ADMIN_PASSWORD` → `/admin` and `/admin/login` both
   respond 503 with a configuration-needed message.
