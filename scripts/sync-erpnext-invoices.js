import { db } from '../src/db/index.js';
import { getPackage } from '../src/packages.js';
import {
  getItemByCode,
  createAndSubmitInvoice,
  createAndSubmitPaymentEntry,
} from '../src/services/erpnext.js';

// Backoff schedule by attempt count (minutes before the next retry is eligible).
const BACKOFF_MINUTES = [1, 5, 15, 15, 15]; // index = erpnext_sync_attempts (0-based)
const MAX_ATTEMPTS = 5;
// A row stuck in 'processing' longer than this was claimed by a run that
// crashed/died without finishing — safe to reclaim rather than orphan it
// forever (the candidates query below includes this case explicitly).
const STALE_PROCESSING_MINUTES = 10;

function isEligibleForRetry(tx) {
  if (!tx.erpnext_last_sync_attempt) return true;
  const attempts = tx.erpnext_sync_attempts || 0;
  const waitMinutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
  const nextEligible = new Date(tx.erpnext_last_sync_attempt).getTime() + waitMinutes * 60 * 1000;
  return Date.now() >= nextEligible;
}

/**
 * Atomically claims a transaction for this run by flipping its status to
 * 'processing' — an UPDATE ... WHERE guarded on the row's real-time state
 * (not the caller's possibly-stale in-memory copy of it), so two overlapping
 * sync script runs (e.g. cron firing again while a prior run is still active
 * because ERPNext was slow) can't both claim the same row and create two
 * invoices for one payment. Returns true if this call actually claimed it,
 * false if something else already did.
 *
 * The WHERE clause re-checks staleness itself rather than trusting
 * `tx.erpnext_sync_status`/`tx.erpnext_last_sync_attempt` as read by the
 * SELECT in main() — an earlier version guarded only on
 * `erpnext_sync_status=?` (the value read at SELECT time), which is a no-op
 * guard for the stale-'processing'-reclaim case: the SET clause writes the
 * SAME status value ('processing') the WHERE clause checks for, so the
 * comparison never actually excludes a second claimant — real testing
 * during Task 7's review confirmed two concurrent calls against the same
 * stale row both succeeded. Because SQLite serializes writes, re-checking
 * staleness in the WHERE clause fixes it: whichever UPDATE commits first
 * advances erpnext_last_sync_attempt to "now", so a second concurrent
 * UPDATE's WHERE re-evaluation sees the row as no-longer-stale and gets
 * changes=0.
 */
function claim(tx) {
  const result = db
    .prepare(
      `UPDATE transactions SET erpnext_sync_status='processing', erpnext_last_sync_attempt=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND (
         erpnext_sync_status IN ('pending','failed')
         OR (erpnext_sync_status='processing' AND erpnext_last_sync_attempt < datetime('now', ?))
       )`
    )
    .run(tx.id, `-${STALE_PROCESSING_MINUTES} minutes`);
  return result.changes === 1;
}

async function syncOne(tx) {
  // Idempotency: already has an invoice recorded locally. This is the ONLY
  // idempotency check in this design — the original plan also cross-checked
  // ERPNext directly via a website_transaction_id custom field, but that
  // field is dropped from this integration (see Global Constraints; the DB
  // column never synced even after a human created the Custom Field record
  // via the ERPNext UI). The accepted gap: a crash between "ERPNext created
  // the invoice" and "we recorded that locally" could produce a duplicate
  // invoice on retry. Given this business's transaction volume and the
  // atomic claim below (which already prevents the much more likely
  // double-processing case — two overlapping cron runs), this is a
  // documented, accepted risk, not a silent one.
  if (tx.erpnext_invoice_name) return 'already-synced';

  if (!claim(tx)) return 'claimed-by-another-run';

  const pkg = getPackage(tx.package_id);
  if (!pkg || !pkg.dataGB) {
    // No Item mapping exists for a legacy (pre-data-quota) package — never
    // synced, never retried.
    db.prepare(
      `UPDATE transactions SET erpnext_sync_status='not_required', updated_at=datetime('now') WHERE id=?`
    ).run(tx.id);
    return 'not-required';
  }

  const itemCode = {
    '1gb': 'electroair0.5',
    '2gb': 'electroair1',
    '3gb': '$2 Hotspot Voucher',
    '5gb': '$3 Hotspot Voucher',
    '10gb': 'electroair5',
  }[tx.package_id];

  try {
    const exists = await getItemByCode(itemCode);
    if (!exists) {
      throw new Error(`Item ${itemCode} does not exist in ERPNext — this integration never creates Items, so this means the Item was renamed or removed on the ERPNext side; fix the mapping or the Item, don't create a replacement here`);
    }

    const invoiceName = await createAndSubmitInvoice({
      reference: tx.reference,
      packageId: tx.package_id,
      itemCode,
      amount: tx.amount,
      dataGB: pkg.dataGB,
      method: tx.method,
    });

    const paymentEntryName = await createAndSubmitPaymentEntry({
      invoiceName,
      amount: tx.amount,
      method: tx.method,
      reference: tx.reference,
    });

    db.prepare(
      `UPDATE transactions SET
         erpnext_customer='CASH USD',
         erpnext_invoice_name=?,
         erpnext_payment_entry_name=?,
         erpnext_sync_status='success',
         erpnext_synced_at=datetime('now'),
         updated_at=datetime('now')
       WHERE id=?`
    ).run(invoiceName, paymentEntryName, tx.id);
    return 'success';
  } catch (err) {
    db.prepare(
      `UPDATE transactions SET
         erpnext_sync_status='failed',
         erpnext_sync_attempts=COALESCE(erpnext_sync_attempts,0)+1,
         erpnext_last_sync_attempt=datetime('now'),
         erpnext_sync_error=?,
         updated_at=datetime('now')
       WHERE id=?`
    ).run(String(err.message).slice(0, 500), tx.id);
    return 'failed';
  }
}

async function main() {
  const candidates = db
    .prepare(
      `SELECT * FROM transactions
       WHERE (erpnext_sync_status IN ('pending','failed')
              AND COALESCE(erpnext_sync_attempts,0) < ?)
          OR (erpnext_sync_status='processing'
              AND erpnext_last_sync_attempt < datetime('now', ?))
       ORDER BY created_at ASC`
    )
    .all(MAX_ATTEMPTS, `-${STALE_PROCESSING_MINUTES} minutes`);

  const counts = { attempted: 0, success: 0, failed: 0, skipped: 0, other: 0 };

  for (const tx of candidates) {
    if (tx.erpnext_sync_status === 'failed' && !isEligibleForRetry(tx)) {
      counts.skipped++;
      continue;
    }
    counts.attempted++;
    const result = await syncOne(tx);
    if (result === 'success') counts.success++;
    else if (result === 'failed') counts.failed++;
    else if (result === 'claimed-by-another-run') counts.skipped++;
    else counts.other++;
  }

  console.log(
    `[erpnext-sync] candidates=${candidates.length} attempted=${counts.attempted} success=${counts.success} failed=${counts.failed} skipped=${counts.skipped} other=${counts.other}`
  );
}

main().catch((err) => {
  console.error('[erpnext-sync] fatal error:', err);
  process.exit(1);
});
