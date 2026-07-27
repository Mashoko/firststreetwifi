(function () {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  document.body.appendChild(tooltip);

  function showTooltip(clientX, clientY, label, value) {
    tooltip.textContent = '';
    const valueEl = document.createElement('div');
    valueEl.className = 'tt-value';
    valueEl.textContent = value;
    const labelEl = document.createElement('div');
    labelEl.className = 'tt-label';
    labelEl.textContent = label;
    tooltip.appendChild(valueEl);
    tooltip.appendChild(labelEl);
    tooltip.style.display = 'block';
    tooltip.style.left = clientX + 14 + 'px';
    tooltip.style.top = clientY + 14 + 'px';
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
  }

  // Line charts: crosshair + nearest-point tooltip driven by pointer position.
  document.querySelectorAll('.chart-svg[data-points]').forEach((svg) => {
    const points = JSON.parse(svg.getAttribute('data-points'));
    const crosshair = svg.querySelector('.chart-crosshair');
    const hitrect = svg.querySelector('.chart-hitrect');
    const viewBox = svg.viewBox.baseVal;

    function nearestPoint(localX, renderedWidth) {
      const scale = viewBox.width / renderedWidth;
      const x = localX * scale;
      let closest = points[0];
      let minDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p.x - x);
        if (d < minDist) {
          minDist = d;
          closest = p;
        }
      }
      return closest;
    }

    function onMove(e) {
      const rect = svg.getBoundingClientRect();
      const point = nearestPoint(e.clientX - rect.left, rect.width);
      if (crosshair) {
        crosshair.style.display = 'block';
        crosshair.setAttribute('x1', point.x);
        crosshair.setAttribute('x2', point.x);
      }
      showTooltip(e.clientX, e.clientY, point.label, point.displayValue);
    }

    function onLeave() {
      if (crosshair) crosshair.style.display = 'none';
      hideTooltip();
    }

    hitrect.addEventListener('pointermove', onMove);
    hitrect.addEventListener('pointerleave', onLeave);
  });

  // Bar charts: each row is its own hit target.
  document.querySelectorAll('[data-tt-value]').forEach((el) => {
    function onShow(e) {
      const rect = el.getBoundingClientRect();
      const clientX = e.clientX ?? rect.left;
      const clientY = e.clientY ?? rect.top;
      showTooltip(clientX, clientY, el.getAttribute('data-tt-label') || '', el.getAttribute('data-tt-value') || '');
    }
    el.addEventListener('pointerenter', onShow);
    el.addEventListener('pointermove', onShow);
    el.addEventListener('pointerleave', hideTooltip);
    el.addEventListener('focus', onShow);
    el.addEventListener('blur', hideTooltip);
  });
})();
