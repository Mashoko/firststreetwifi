// ─── WiFi Packages / Pricing ──────────────────────────────
// Edit freely. `minutes` = how long the voucher grants internet access.
// `price` is in USD (Paynow settles in the currency your account is set to).
export const PACKAGES = [
  { id: 'quick',   name: 'Quick Browse',  minutes: 60,      price: 0.50, blurb: '1 hour · light browsing & chat' },
  { id: 'day',     name: 'Day Pass',      minutes: 60 * 24, price: 2.00, blurb: '24 hours · streaming & work' },
  { id: 'week',    name: 'Week Pass',     minutes: 60 * 24 * 7,  price: 8.00,  blurb: '7 days · unlimited-time access' },
  { id: 'month',   name: 'Month Pass',    minutes: 60 * 24 * 30, price: 25.00, blurb: '30 days · best value' },
];

export const getPackage = (id) => PACKAGES.find((p) => p.id === id);
