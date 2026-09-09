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
