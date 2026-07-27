const PRESET_DAYS = {
  today: 0,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Reads `range` (and, for a custom range, `from`/`to`) off a request query
 * object and returns a normalized { from, to, preset } — always valid
 * (unrecognized or incomplete input falls back to the last 30 days).
 */
export function parseDateRange(query) {
  const requested = query.range || '30d';

  if (requested === 'custom' && query.from && query.to) {
    return { from: query.from, to: query.to, preset: 'custom' };
  }

  const days = PRESET_DAYS[requested] ?? PRESET_DAYS['30d'];
  const preset = PRESET_DAYS[requested] !== undefined ? requested : '30d';

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);

  return { from: toIsoDate(from), to: toIsoDate(to), preset };
}
