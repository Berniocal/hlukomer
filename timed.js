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
  const unitOut = $('unitOut');
  const weighting = $('weighting');
  const showSPL = $('showSPL');
  const exportExcelBtn = $('exportExcelBtn');
  const normalSavedDetails = exportExcelBtn?.closest('details') || null;

  const LS_MODE = 'hlukomer.timedMode.v1';
  const LS_SECONDS = 'hlukomer.timedSeconds.v1';
  const LS_RESULTS = 'hlukomer.timedResults.v2';
  const LS_RESULTS_OLD = 'hlukomer.timedResults.v1';
  const OCTAVE_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const OCTAVE_FACTOR = Math.SQRT2;

  let results = loadResults();
  let pendingTimedStart = false;
  let timedActive = false;
  let timedStartPerf = 0;
  let timedStartedAt = null;
  let targetSeconds = 5;
  let stopTimer = 0;
  let countdownTimer = 0;
  let sampleTimer = 0;
  let captureEnabled = false;

  let capturedTime = null;
  let capturedFreq = null;
  let capturedSampleRate = 0;
  let capturedFftSize = 0;

  let measurementWeighting = 'A';
  let measurementSpl = true;
  let measurementOffset = 40;
  let measurementCalibration = {};

  let lastIntegrationPerf = 0;
  let integratedMs = 0;
  let totalEnergy = 0;
  let octaveEnergy = Object.fromEntries(OCTAVE_CENTERS.map(f => [f, 0]));
  let timedMin = Infinity;
  let timedMax = -Infinity;

  timedMode.checked = localStorage.getItem(LS_MODE) === '1';
  timedSeconds.value = clampSeconds(Number(localStorage.getItem(LS_SECONDS)) || 5);
  targetSeconds = Number(timedSeconds.value);

  patchAnalyserCapture();

  function patchAnalyserCapture() {
    const ctors = [window.AudioContext, window.webkitAudioContext].filter(Boolean);
    const done = new Set();
    ctors.forEach(Ctor => {
      if (!Ctor?.prototype || done.has(Ctor.prototype)) return;
      done.add(Ctor.prototype);
      const proto = Ctor.prototype;
      const originalCreateAnalyser = proto.createAnalyser;
      if (!originalCreateAnalyser || originalCreateAnalyser.__hlukomerTimedWrapped) return;

      function wrappedCreateAnalyser(...args) {
        const node = originalCreateAnalyser.apply(this, args);
        if (node.__hlukomerTimedCapture) return node;
        node.__hlukomerTimedCapture = true;

        const originalTime = node.getFloatTimeDomainData.bind(node);
        const originalFreq = node.getFloatFrequencyData.bind(node);

        node.getFloatTimeDomainData = array => {
          originalTime(array);
          if (captureEnabled) capturedTime = new Float32Array(array);
        };

        node.getFloatFrequencyData = array => {
          originalFreq(array);
          if (captureEnabled) {
            capturedFreq = new Float32Array(array);
            capturedSampleRate = node.context?.sampleRate || this.sampleRate || 0;
            capturedFftSize = node.fftSize || array.length * 2;
          }
        };
        return node;
      }

      wrappedCreateAnalyser.__hlukomerTimedWrapped = true;
      proto.createAnalyser = wrappedCreateAnalyser;
    });
  }

  function clampSeconds(v) {
    if (!Number.isFinite(v)) return 5;
    return Math.max(1, Math.min(3600, Math.round(v)));
  }

  function loadResults() {
    try {
      const newer = localStorage.getItem(LS_RESULTS);
      if (newer) {
        const parsed = JSON.parse(newer);
        return Array.isArray(parsed) ? parsed : [];
      }
      const old = JSON.parse(localStorage.getItem(LS_RESULTS_OLD) || '[]');
      return Array.isArray(old) ? old : [];
    } catch (_) {
      return [];
    }
  }

  function persistResults() {
    localStorage.setItem(LS_RESULTS, JSON.stringify(results));
  }

  function loadNumber(key, fallback) {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? n : fallback;
  }

  function loadCalibration() {
    try {
      const parsed = JSON.parse(localStorage.getItem('hlukomer.freqCalibration.v2') || '{}');
      return Object.fromEntries(OCTAVE_CENTERS.map(f => {
        const n = Number(parsed[f]);
        return [f, Number.isFinite(n) ? n : 0];
      }));
    } catch (_) {
      return Object.fromEntries(OCTAVE_CENTERS.map(f => [f, 0]));
    }
  }

  function updateTimedVisibility() {
    timedOptions.hidden = !timedMode.checked;
    timedSeriesDetails.style.display = (timedMode.checked || results.length) ? '' : 'none';
    if (normalSavedDetails) normalSavedDetails.style.display = timedMode.checked ? 'none' : '';
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

  function resetTimedAccumulator() {
    integratedMs = 0;
    totalEnergy = 0;
    octaveEnergy = Object.fromEntries(OCTAVE_CENTERS.map(f => [f, 0]));
    timedMin = Infinity;
    timedMax = -Infinity;
    capturedTime = null;
    capturedFreq = null;
    capturedSampleRate = 0;
    capturedFftSize = 0;
  }

  function startTimedCountdown() {
    if (!pendingTimedStart || !timedMode.checked || timedActive) return;
    pendingTimedStart = false;
    timedActive = true;
    targetSeconds = clampSeconds(Number(timedSeconds.value));
    timedStartPerf = performance.now();
    timedStartedAt = new Date();
    lastIntegrationPerf = timedStartPerf;

    measurementWeighting = weighting?.value || 'A';
    measurementSpl = !!showSPL?.checked;
    measurementOffset = loadNumber('hlukomer.offsetDB.v2', loadNumber('noiseMeterOffsetDB', 40));
    measurementCalibration = loadCalibration();

    resetTimedAccumulator();
    captureEnabled = true;
    setControlsDisabled(true);
    updateCountdown();

    clearInterval(countdownTimer);
    clearInterval(sampleTimer);
    clearTimeout(stopTimer);
    countdownTimer = setInterval(updateCountdown, 100);
    sampleTimer = setInterval(sampleTimedMeasurement, 80);
    stopTimer = setTimeout(() => {
      if (!timedActive) return;
      sampleTimedMeasurement();
      if (!stopBtn.disabled) stopBtn.click();
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

  function weightDb(freq, type) {
    if (!(freq > 0)) return -120;
    if (type === 'Z') return 0;
    const f2 = freq * freq;
    const c12200 = 12200 * 12200;
    if (type === 'C') {
      const rc = (c12200 * f2) / ((f2 + 20.6 * 20.6) * (f2 + c12200));
      return 20 * Math.log10(Math.max(rc, 1e-20)) + 0.06;
    }
    const num = c12200 * f2 * f2;
    const den = (f2 + 20.6 * 20.6)
      * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
      * (f2 + c12200);
    return 20 * Math.log10(Math.max(num / den, 1e-20)) + 2.0;
  }

  function calibrationDb(freq) {
    if (!(freq > 0)) return 0;
    if (freq <= OCTAVE_CENTERS[0]) return measurementCalibration[OCTAVE_CENTERS[0]] || 0;
    if (freq >= OCTAVE_CENTERS[OCTAVE_CENTERS.length - 1]) return measurementCalibration[OCTAVE_CENTERS[OCTAVE_CENTERS.length - 1]] || 0;
    const lf = Math.log(freq);
    for (let i = 0; i < OCTAVE_CENTERS.length - 1; i++) {
      const f1 = OCTAVE_CENTERS[i], f2 = OCTAVE_CENTERS[i + 1];
      if (freq >= f1 && freq <= f2) {
        const t = (lf - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
        return (measurementCalibration[f1] || 0) + ((measurementCalibration[f2] || 0) - (measurementCalibration[f1] || 0)) * t;
      }
    }
    return 0;
  }

  function currentSpectrumSnapshot() {
    if (!capturedTime || !capturedFreq || !capturedSampleRate || !capturedFftSize) return null;

    let sumSquares = 0;
    for (let i = 0; i < capturedTime.length; i++) sumSquares += capturedTime[i] * capturedTime[i];
    const rms = Math.sqrt(sumSquares / capturedTime.length);
    const rawDbfs = 20 * Math.log10(Math.max(rms, 1e-9));

    const binHz = capturedSampleRate / capturedFftSize;
    const maxHz = Math.min(20000, capturedSampleRate / 2);
    let rawPower = 0;
    let adjustedPower = 0;
    const bands = Object.fromEntries(OCTAVE_CENTERS.map(f => [f, 0]));

    for (let i = 1; i < capturedFreq.length; i++) {
      const freq = i * binHz;
      if (freq < 20 || freq > maxHz) continue;
      const db = capturedFreq[i];
      if (!Number.isFinite(db) || db < -150) continue;

      const p = Math.pow(10, db / 10);
      rawPower += p;
      const correction = calibrationDb(freq) + weightDb(freq, measurementWeighting);
      const adjusted = p * Math.pow(10, correction / 10);
      adjustedPower += adjusted;

      for (const center of OCTAVE_CENTERS) {
        const lo = center / OCTAVE_FACTOR;
        const hi = center * OCTAVE_FACTOR;
        if (freq >= lo && freq < hi) {
          bands[center] += adjusted;
          break;
        }
      }
    }

    if (!(rawPower > 0) || !(adjustedPower > 0)) return null;
    const delta = 10 * Math.log10(adjustedPower / rawPower);
    const totalDb = rawDbfs + delta + (measurementSpl ? measurementOffset : 0);
    const octaveDb = {};
    OCTAVE_CENTERS.forEach(center => {
      const bp = bands[center];
      octaveDb[center] = bp > 0 ? totalDb + 10 * Math.log10(bp / adjustedPower) : NaN;
    });

    return { totalDb, octaveDb };
  }

  function sampleTimedMeasurement() {
    if (!timedActive) return;
    const now = performance.now();
    const endPerf = timedStartPerf + targetSeconds * 1000;
    const effectiveNow = Math.min(now, endPerf);
    const dt = effectiveNow - lastIntegrationPerf;
    if (!(dt > 0)) return;

    const snapshot = currentSpectrumSnapshot();
    if (!snapshot) return;

    totalEnergy += Math.pow(10, snapshot.totalDb / 10) * dt;
    OCTAVE_CENTERS.forEach(center => {
      const db = snapshot.octaveDb[center];
      if (Number.isFinite(db)) octaveEnergy[center] += Math.pow(10, db / 10) * dt;
    });
    integratedMs += dt;
    lastIntegrationPerf = effectiveNow;
    timedMin = Math.min(timedMin, snapshot.totalDb);
    timedMax = Math.max(timedMax, snapshot.totalDb);
  }

  function finalizeTimedMeasurement() {
    if (!timedActive) return;
    sampleTimedMeasurement();

    const actualElapsed = Math.min(targetSeconds, Math.max(0, (performance.now() - timedStartPerf) / 1000));
    timedActive = false;
    pendingTimedStart = false;
    captureEnabled = false;
    clearInterval(countdownTimer);
    clearInterval(sampleTimer);
    clearTimeout(stopTimer);
    timedCountdown.textContent = '';
    setControlsDisabled(false);

    if (!(integratedMs > 0) || !(totalEnergy > 0)) return;

    const leq = 10 * Math.log10(totalEnergy / integratedMs);
    const octaves = {};
    OCTAVE_CENTERS.forEach(center => {
      const e = octaveEnergy[center];
      octaves[center] = e > 0 ? Number((10 * Math.log10(e / integratedMs)).toFixed(2)) : null;
    });

    const completedTarget = actualElapsed >= targetSeconds - 0.15;
    const durationSec = completedTarget ? targetSeconds : Number(actualElapsed.toFixed(2));
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      name: `Měření ${results.length + 1}`,
      startedAt: timedStartedAt ? timedStartedAt.toISOString() : new Date().toISOString(),
      durationSec,
      targetSec: targetSeconds,
      leq: Number(leq.toFixed(2)),
      min: Number.isFinite(timedMin) ? Number(timedMin.toFixed(2)) : null,
      max: Number.isFinite(timedMax) ? Number(timedMax.toFixed(2)) : null,
      unit: unitOut.textContent || (measurementSpl ? `dB${measurementWeighting}` : `dBFS (${measurementWeighting})`),
      weighting: measurementWeighting,
      octaves
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
      name.addEventListener('input', () => {
        item.name = name.value;
        persistResults();
      });
      name.addEventListener('blur', () => {
        item.name = name.value.trim() || `Měření ${index + 1}`;
        name.value = item.name;
        persistResults();
      });

      const meta = document.createElement('div');
      meta.className = 'timedMeta';
      const d = new Date(item.startedAt);
      meta.textContent = `${Number(item.durationSec).toFixed(1)} s · ${d.toLocaleTimeString('cs-CZ', {hour:'2-digit', minute:'2-digit', second:'2-digit'})}`;
      left.append(name, meta);

      const value = document.createElement('div');
      value.className = 'timedValue';
      value.textContent = `${Number(item.leq).toFixed(1)} ${item.unit || 'dB'}`;
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

  function octaveHeader(center) {
    if (center >= 1000) return `${String(center / 1000).replace('.', ',')} kHz [dB]`;
    return `${String(center).replace('.', ',')} Hz [dB]`;
  }

  function exportResults() {
    if (!results.length) {
      alert('Nejsou žádná časovaná měření.');
      return;
    }

    const rows = [[
      'Název','Datum','Čas','Délka [s]','Vážení','Jednotka','Leq [dB]','Minimum [dB]','Maximum [dB]',
      ...OCTAVE_CENTERS.map(octaveHeader)
    ]];

    results.forEach(item => {
      const d = new Date(item.startedAt);
      rows.push([
        item.name || '',
        d.toLocaleDateString('cs-CZ'),
        d.toLocaleTimeString('cs-CZ'),
        numCs(item.durationSec),
        item.weighting || '',
        item.unit || '',
        numCs(item.leq),
        numCs(item.min),
        numCs(item.max),
        ...OCTAVE_CENTERS.map(center => numCs(item.octaves?.[center]))
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
      captureEnabled = false;
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
    captureEnabled = true;
  });

  stopBtn.addEventListener('click', () => {
    if (!timedActive) return;
    sampleTimedMeasurement();
    setTimeout(finalizeTimedMeasurement, 40);
  });

  const statusObserver = new MutationObserver(() => {
    const text = statusPill.textContent.trim();
    if (pendingTimedStart && text.startsWith('měřím')) startTimedCountdown();
    if (pendingTimedStart && text.includes('nepovolen')) {
      pendingTimedStart = false;
      captureEnabled = false;
      setControlsDisabled(false);
    }
  });
  statusObserver.observe(statusPill, {childList:true, characterData:true, subtree:true});

  if (timedSeriesDetails?.querySelector('summary')) timedSeriesDetails.querySelector('summary').textContent = 'Výsledky časovaných měření';
  if (normalSavedDetails?.querySelector('summary')) normalSavedDetails.querySelector('summary').textContent = 'Ruční uložená měření';
  exportTimedBtn.textContent = 'Export všech měření';

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