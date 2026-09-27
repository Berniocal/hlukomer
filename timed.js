(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const timedMode = $('timedMode');
  const timedOptions = $('timedOptions');
  const timedSeconds = $('timedSeconds');
  const timedCountdown = $('timedCountdown');
  const timedSeriesDetails = $('timedSeriesDetails');
  const timedMeasurementsEl = $('timedMeasurements');
  const exportTimedBtn = $('exportTimedBtn');
  const clearTimedBtn = $('clearTimedBtn');
  const statusPill = $('statusPill');
  const measureAvgOut = $('measureAvgOut');
  const minOut = $('minOut');
  const maxOut = $('maxOut');
  const unitOut = $('unitOut');
  const weighting = $('weighting');

  const LS_MODE = 'hlukomer.timedMode.v1';
  const LS_SECONDS = 'hlukomer.timedSeconds.v1';
  const LS_RESULTS = 'hlukomer.timedResults.v1';

  let results = loadResults();
  let pendingTimedStart = false;
  let timedActive = false;
  let timedStartPerf = 0;
  let timedStartedAt = null;
  let targetSeconds = 5;
  let stopTimer = 0;
  let countdownTimer = 0;

  timedMode.checked = localStorage.getItem(LS_MODE) === '1';
  timedSeconds.value = clampSeconds(Number(localStorage.getItem(LS_SECONDS)) || 5);
  targetSeconds = Number(timedSeconds.value);

  function clampSeconds(v) {
    if (!Number.isFinite(v)) return 5;
    return Math.max(1, Math.min(3600, Math.round(v)));
  }

  function loadResults() {
    try {
      const x = JSON.parse(localStorage.getItem(LS_RESULTS) || '[]');
      return Array.isArray(x) ? x : [];
    } catch (_) {
      return [];
    }
  }

  function persistResults() {
    localStorage.setItem(LS_RESULTS, JSON.stringify(results));
  }

  function updateTimedVisibility() {
    timedOptions.hidden = !timedMode.checked;
    timedSeriesDetails.style.display = (timedMode.checked || results.length) ? '' : 'none';
    localStorage.setItem(LS_MODE, timedMode.checked ? '1' : '0');
  }

  function updatePresetState() {
    document.querySelectorAll('.preset').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.sec) === Number(timedSeconds.value));
    });
  }

  function setControlsDisabled(disabled) {
    timedMode.disabled = disabled;
    timedSeconds.disabled = disabled;
    document.querySelectorAll('.preset').forEach(btn => btn.disabled = disabled);
  }

  function startTimedCountdown() {
    if (!pendingTimedStart || !timedMode.checked || timedActive) return;
    pendingTimedStart = false;
    timedActive = true;
    targetSeconds = clampSeconds(Number(timedSeconds.value));
    timedStartPerf = performance.now();
    timedStartedAt = new Date();
    setControlsDisabled(true);
    updateCountdown();
    clearInterval(countdownTimer);
    clearTimeout(stopTimer);
    countdownTimer = setInterval(updateCountdown, 100);
    stopTimer = setTimeout(() => {
      if (timedActive && !stopBtn.disabled) stopBtn.click();
    }, targetSeconds * 1000);
  }

  function updateCountdown() {
    if (!timedActive) {
      timedCountdown.textContent = '';
      return;
    }
    const elapsed = (performance.now() - timedStartPerf) / 1000;
    const remain = Math.max(0, targetSeconds - elapsed);
    timedCountdown.textContent = `${remain.toFixed(remain < 10 ? 1 : 0)} s`;
  }

  function numberFrom(el) {
    const n = Number(String(el?.textContent || '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  function finalizeTimedMeasurement() {
    if (!timedActive) return;
    timedActive = false;
    pendingTimedStart = false;
    clearInterval(countdownTimer);
    clearTimeout(stopTimer);
    timedCountdown.textContent = '';
    setControlsDisabled(false);

    const leq = numberFrom(measureAvgOut);
    if (!Number.isFinite(leq)) return;

    const durationSec = Math.max(0.1, (performance.now() - timedStartPerf) / 1000);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      name: `Měření ${results.length + 1}`,
      startedAt: timedStartedAt ? timedStartedAt.toISOString() : new Date().toISOString(),
      durationSec: Number(durationSec.toFixed(2)),
      targetSec: targetSeconds,
      leq: Number(leq.toFixed(2)),
      min: numberFrom(minOut),
      max: numberFrom(maxOut),
      unit: unitOut.textContent || 'dB',
      weighting: weighting?.value || ''
    };
    results.push(item);
    persistResults();
    renderResults();
    updateTimedVisibility();
  }

  function renderResults() {
    timedMeasurementsEl.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Žádná časovaná měření';
      timedMeasurementsEl.appendChild(empty);
      return;
    }

    results.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'timedItem';

      const left = document.createElement('div');
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'timedName';
      name.value = item.name || `Měření ${index + 1}`;
      name.setAttribute('aria-label', `Název měření ${index + 1}`);
      name.addEventListener('change', () => {
        item.name = name.value.trim() || `Měření ${index + 1}`;
        name.value = item.name;
        persistResults();
      });
      const meta = document.createElement('div');
      meta.className = 'timedMeta';
      const d = new Date(item.startedAt);
      meta.textContent = `${item.durationSec.toFixed(1)} s · ${d.toLocaleTimeString('cs-CZ', {hour:'2-digit', minute:'2-digit', second:'2-digit'})}`;
      left.append(name, meta);

      const value = document.createElement('div');
      value.className = 'timedValue';
      value.textContent = `${item.leq.toFixed(1)} ${item.unit}`;
      row.append(left, value);
      timedMeasurementsEl.appendChild(row);
    });
  }

  function csvCell(v) {
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
  }

  function numCs(v, digits = 2) {
    return Number.isFinite(Number(v)) ? Number(v).toFixed(digits).replace('.', ',') : '';
  }

  function exportResults() {
    if (!results.length) {
      alert('Nejsou žádná časovaná měření.');
      return;
    }
    const rows = [['Název','Datum','Čas','Délka [s]','Vážení','Jednotka','Leq [dB]','Minimum [dB]','Maximum [dB]']];
    results.forEach(item => {
      const d = new Date(item.startedAt);
      rows.push([
        item.name,
        d.toLocaleDateString('cs-CZ'),
        d.toLocaleTimeString('cs-CZ'),
        numCs(item.durationSec),
        item.weighting,
        item.unit,
        numCs(item.leq),
        numCs(item.min),
        numCs(item.max)
      ]);
    });
    const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hlukomer-mereni-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  timedMode.addEventListener('change', () => {
    updateTimedVisibility();
    if (!timedMode.checked) {
      pendingTimedStart = false;
      timedCountdown.textContent = '';
    }
  });

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      timedSeconds.value = btn.dataset.sec;
      targetSeconds = Number(btn.dataset.sec);
      localStorage.setItem(LS_SECONDS, String(targetSeconds));
      updatePresetState();
    });
  });

  timedSeconds.addEventListener('change', () => {
    const value = clampSeconds(Number(timedSeconds.value));
    timedSeconds.value = value;
    targetSeconds = value;
    localStorage.setItem(LS_SECONDS, String(value));
    updatePresetState();
  });

  startBtn.addEventListener('click', () => {
    if (!timedMode.checked) return;
    pendingTimedStart = true;
  });

  stopBtn.addEventListener('click', () => {
    if (!timedActive) return;
    setTimeout(finalizeTimedMeasurement, 60);
  });

  const statusObserver = new MutationObserver(() => {
    const text = statusPill.textContent.trim();
    if (pendingTimedStart && text.startsWith('měřím')) startTimedCountdown();
    if (pendingTimedStart && text.includes('nepovolen')) {
      pendingTimedStart = false;
      setControlsDisabled(false);
    }
  });
  statusObserver.observe(statusPill, {childList:true, characterData:true, subtree:true});

  exportTimedBtn.addEventListener('click', exportResults);
  clearTimedBtn.addEventListener('click', () => {
    if (!results.length) return;
    if (!confirm('Smazat všechna časovaná měření?')) return;
    results = [];
    persistResults();
    renderResults();
    updateTimedVisibility();
  });

  updatePresetState();
  updateTimedVisibility();
  renderResults();
})();