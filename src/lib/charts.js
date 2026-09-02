function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

/**
 * Single-series line chart. Renders as inline SVG with a hit-rect and a
 * hidden crosshair line that public/chart-tooltip.js drives on pointer move.
 */
const chartEmptyState = `<div class="chart-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-3 2.5 2.5L18 9"/></svg>No data for this range.</div>`;

export function lineChart(points, { width = 560, height = 160, padding = 10, color = '#34d876' } = {}) {
  if (!points.length) {
    return chartEmptyState;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;

  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: padding + step * i,
    y: padding + innerHeight - ((p.value - min) / range) * innerHeight,
    label: p.label,
    value: p.value,
    displayValue: p.displayValue ?? p.value,
  }));

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];
  const dataForJs = JSON.stringify(coords.map((c) => ({ x: c.x, label: c.label, displayValue: c.displayValue })));

  return `
<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" data-points='${escapeAttr(dataForJs)}'>
  <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border-hairline)" stroke-width="1" />
  <polyline points="${polylinePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="${color}" />
  <line class="chart-crosshair" x1="0" y1="${padding}" x2="0" y2="${height - padding}" stroke="rgba(255,255,255,0.2)" style="display:none" />
  <rect class="chart-hitrect" x="0" y="0" width="${width}" height="${height}" fill="transparent" />
</svg>`;
}

/**
 * Horizontal bar ranking, plain HTML/CSS (not SVG) — each row is its own
 * hover/focus target for the shared tooltip script.
 */
export function horizontalBarChart(items) {
  if (!items.length) {
    return chartEmptyState;
  }

  const max = Math.max(...items.map((i) => i.value), 1);

  return items
    .map((item) => {
      const pct = Math.max(Math.round((item.value / max) * 100), 2);
      const display = item.displayValue ?? item.value;
      return `<div class="bar-row" tabindex="0" data-tt-value="${escapeAttr(display)}" data-tt-label="${escapeAttr(item.label)}">
  <span class="bar-label">${escapeHtml(item.label)}</span>
  <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
  <span class="bar-value">${escapeHtml(String(display))}</span>
</div>`;
    })
    .join('\n');
}

/** Small single-series sparkline — no axes, no interaction. */
export function sparkline(values, { width = 100, height = 30, color = '#3987e5' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" /></svg>`;
}
