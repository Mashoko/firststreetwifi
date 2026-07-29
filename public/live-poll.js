(function () {
  const tbody = document.getElementById('live-tbody');
  const totalEl = document.getElementById('live-total');
  const emptyEl = document.getElementById('live-empty');
  const searchInput = document.getElementById('live-search');
  if (!tbody) return;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function applyFilter() {
    const q = (searchInput.value || '').toLowerCase();
    Array.from(tbody.rows).forEach((row) => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }

  function render(clients) {
    tbody.innerHTML = clients
      .map(
        (c) => `<tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.mac)}</td>
      <td>${escapeHtml(c.ip)}</td>
      <td>${escapeHtml(c.ssid)}</td>
      <td>${escapeHtml(c.apName)}</td>
      <td>${escapeHtml(c.connectedAt)}</td>
    </tr>`
      )
      .join('');
    emptyEl.style.display = clients.length ? 'none' : '';
    applyFilter();
  }

  searchInput.addEventListener('input', applyFilter);

  async function poll() {
    try {
      const res = await fetch('/admin/live/data');
      if (!res.ok) return;
      const data = await res.json();
      totalEl.textContent = data.total;
      render(data.clients);
    } catch (e) {
      // Network hiccup — keep showing the last known state, retry next tick.
    }
  }

  setInterval(poll, 10000);
})();
