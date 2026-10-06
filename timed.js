(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const TYPES = ['A', 'C', 'Z'];
  const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const OCTAVE_FACTOR = Math.SQRT2;
  const MAX_FRAME_DT_MS = 60;
  const UI_TIMER_MS = 100;

  const nativeStart = $('startBtn');
  const nativeStop = $('stopBtn');
  const nativeReset = $('resetBtn');
  const nativeSave = $('saveMeasurementBtn');
  const nativeExport = $('exportExcelBtn');
  const nativeSavedDetails = nativeExport?.closest('details') || null;

  const statusPill = $('statusPill');
  const unitOut = $('unitOut');
  const weighting = $('weighting');
  const showSPL = $('showSPL');
  const holdPeak = $('holdPeak');
  const offsetNum = $('offsetNum');

  const timedMode = $('timedMode');
  const timedOptions = $('timedOptions');
  const timedSeconds = $('timedSeconds');
  const timedCountdown = $('timedCountdown');
  const resultsDetails = $('timedSeriesDetails');
  const resultsList = $('timedMeasurements');
  const exportBtn = $('exportTimedBtn');
  const clearBtn = $('clearTimedBtn');

  const LS = {
    mode: 'hlukomer.timedMode.v1',
    seconds: 'hlukomer.timedSeconds.v1',
    results: 'hlukomer.results.v4',
    resultsV3: 'hlukomer.results.v3',
    timedV2: 'hlukomer.timedResults.v2',
    timedV1: 'hlukomer.timedResults.v1',
    manualV2: 'hlukomer.manualResults.v2',
    nativeV1: 'hlukomer.measurements.v1',
    calibrationState: 'hlukomer.calibrationState.v1'
  };

  let results = loadResults();

  let capturedTime = null;
  let capturedFreq = null;
  let capturedSampleRate = 0;
  let capturedFftSize = 0;
  let capturedSerial = 0;
  let lastIntegratedSerial = 0;
  let captureEnabled = false;

  let sessionActive = false;
  let paused = false;
  let pendingStart = false;
  let finishing = false;
  let sessionStartedAt = null;
  let lastIntegrationPerf = 0;
  let integratedMs = 0;
  let totalEnergy = typeMap(0);
  let octaveEnergyA = octaveMap(0);
  let octaveEnergyZ = octaveMap(0);
  let recentSegments = [];
  let minLeq1 = typeMap(Infinity);
  let maxLeq1 = typeMap(-Infinity);

  let measurementWeighting = 'A';
  let measurementSpl = true;
  let measurementOffset = 40;
  let measurementCalibration = {};
  let measurementCalibrated = false;
  let targetSeconds = 5;
  let sampleTimer = 0;

  const ui = buildUi();
  patchAnalyserCapture();

  timedMode.checked = localStorage.getItem(LS.mode) === '1';
  timedSeconds.value = clampSeconds(Number(localStorage.getItem(LS.seconds)) || 5);
  targetSeconds = Number(timedSeconds.value);
  persistResults();
  updatePresetState();
  updateTimedVisibility();
  renderResults();
  resetLeqDisplay();

  function typeMap(value) {
    return { A: value, C: value, Z: value };
  }

  function octaveMap(value) {
    return Object.fromEntries(OCTAVES.map(f => [f, value]));
  }

  function buildUi() {
    const style = document.createElement('style');
    style.textContent = `
      #startBtn,#stopBtn,#resetBtn,#saveMeasurementBtn{display:none!important}
      .buttons{grid-template-columns:repeat(2,minmax(72px,1fr))!important}
      .transportBtn{min-width:76px;min-height:52px;font-size:24px;line-height:1;padding:8px 18px}
      .transportBtn.stop{font-size:21px}
      .leqCaption{font-size:12px;color:var(--muted);font-weight:750;margin-bottom:4px}
      .nativeMeasureValue{display:none!important}
      #timedSeriesDetails{display:block!important}
      .resultRight{display:flex;align-items:center;gap:7px}
      .resultDelete{min-width:38px;min-height:36px;padding:6px 9px;font-size:16px;background:#2a1820;border-color:#60303e}
      @media(max-width:560px){.buttons{grid-template-columns:1fr 1fr!important}.transportBtn{width:100%;min-height:50px}.resultRight{gap:5px}}
    `;
    document.head.appendChild(style);

    const buttons = nativeStart?.parentElement;
    const play = document.createElement('button');
    play.id = 'transportPlayBtn';
    play.className = 'primary transportBtn';
    play.textContent = '▶';
    play.title = 'Spustit měření';
    play.setAttribute('aria-label', 'Spustit měření');

    const stop = document.createElement('button');
    stop.id = 'transportStopBtn';
    stop.className = 'danger transportBtn stop';
    stop.textContent = '■';
    stop.title = 'Ukončit měření';
    stop.setAttribute('aria-label', 'Ukončit měření');
    stop.disabled = true;
    buttons?.append(play, stop);

    const oldBig = $('dbOut');
    const big = document.createElement('div');
    big.id = 'leqBigOut';
    big.className = oldBig?.className || 'value';
    big.textContent = '--';
    if (oldBig) {
      oldBig.classList.add('nativeMeasureValue');
      oldBig.insertAdjacentElement('afterend', big);
      const reading = oldBig.closest('.reading');
      const caption = document.createElement('div');
      caption.className = 'leqCaption';
      caption.textContent = 'Leq 1 s';
      reading?.insertAdjacentElement('beforebegin', caption);
    }

    const replaceStat = (oldId, newId, label) => {
      const old = $(oldId);
      const fresh = document.createElement('span');
      fresh.id = newId;
      fresh.textContent = '--';
      if (old) {
        old.classList.add('nativeMeasureValue');
        old.insertAdjacentElement('afterend', fresh);
        const k = old.closest('.stat')?.querySelector('.k');
        if (k) k.textContent = label;
      }
      return fresh;
    };

    const leq1 = replaceStat('instOut', 'leq1Out', 'Leq 1 s');
    const max = replaceStat('maxOut', 'leqMaxOut', 'Maximum Leq 1 s');
    const min = replaceStat('minOut', 'leqMinOut', 'Minimum Leq 1 s');
    const leq5 = replaceStat('avgOut', 'leq5Out', 'Leq 5 s');
    const total = replaceStat('measureAvgOut', 'leqTotalOut', 'Leq měření');

    const oldBar = $('bar');
    const bar = document.createElement('div');
    bar.id = 'leqBar';
    if (oldBar) {
      oldBar.classList.add('nativeMeasureValue');
      oldBar.insertAdjacentElement('afterend', bar);
    }

    if (holdPeak?.closest('label')) holdPeak.closest('label').style.display = 'none';
    if (nativeSavedDetails) nativeSavedDetails.style.display = 'none';
    if (resultsDetails) {
      resultsDetails.style.display = '';
      resultsDetails.open = true;
      const summary = resultsDetails.querySelector('summary');
      if (summary) summary.textContent = 'Uložená měření';
    }
    if (exportBtn) exportBtn.textContent = 'Export všech měření';
    if (clearBtn) clearBtn.textContent = 'Smazat všechna měření';

    return { play, stop, big, leq1, max, min, leq5, total, bar };
  }

  function patchAnalyserCapture() {
    const ctors = [window.AudioContext, window.webkitAudioContext].filter(Boolean);
    const done = new Set();
    ctors.forEach(Ctor => {
      if (!Ctor?.prototype || done.has(Ctor.prototype)) return;
      done.add(Ctor.prototype);
      const proto = Ctor.prototype;
      const originalCreateAnalyser = proto.createAnalyser;
      if (!originalCreateAnalyser || originalCreateAnalyser.__hlukomerUnifiedWrapped) return;

      function wrappedCreateAnalyser(...args) {
        const context = this;
        const node = originalCreateAnalyser.apply(context, args);
        if (node.__hlukomerUnifiedCapture) return node;
        node.__hlukomerUnifiedCapture = true;
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
            capturedSampleRate = context.sampleRate || 0;
            capturedFftSize = node.fftSize || array.length * 2;
            capturedSerial += 1;
            // Integrujeme při každém čerstvém FFT rámci místo starého 80ms časovače.
            sampleMeasurement(performance.now(), capturedSerial);
          }
        };
        return node;
      }

      wrappedCreateAnalyser.__hlukomerUnifiedWrapped = true;
      proto.createAnalyser = wrappedCreateAnalyser;
    });
  }

  function clampSeconds(v) {
    if (!Number.isFinite(v)) return 5;
    return Math.max(1, Math.min(3600, Math.round(v)));
  }

  function finiteOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function objectOrEmpty(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function normalizeResult(item) {
    const legacyLeq = finiteOrNull(item.leq ?? item.average);
    const legacyWeight = String(item.weighting || '').toUpperCase();
    let leqA = finiteOrNull(item.leqA);
    let leqC = finiteOrNull(item.leqC);
    let leqZ = finiteOrNull(item.leqZ);
    if (legacyLeq !== null) {
      if (legacyWeight === 'A' && leqA === null) leqA = legacyLeq;
      if (legacyWeight === 'C' && leqC === null) leqC = legacyLeq;
      if (legacyWeight === 'Z' && leqZ === null) leqZ = legacyLeq;
    }

    let octavesA = objectOrEmpty(item.octavesA);
    let octavesZ = objectOrEmpty(item.octavesZ);
    const legacyOctaves = objectOrEmpty(item.octaves);
    if (!Object.keys(octavesA).length && legacyWeight === 'A') octavesA = legacyOctaves;
    if (!Object.keys(octavesZ).length && legacyWeight === 'Z') octavesZ = legacyOctaves;

    return {
      id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      name: item.name || 'Měření',
      startedAt: item.startedAt || new Date().toISOString(),
      durationSec: Number(item.durationSec) || 0,
      timed: Boolean(item.timed ?? item.targetSec != null),
      targetSec: finiteOrNull(item.targetSec),
      completedTarget: Boolean(item.completedTarget),
      spl: item.spl !== undefined ? Boolean(item.spl) : !String(item.unit || '').includes('dBFS'),
      calibrated: item.calibrated === true ? true : item.calibrated === false ? false : null,
      leqA,
      leqC,
      leqZ,
      minA: finiteOrNull(item.minA ?? (legacyWeight === 'A' ? item.min : null)),
      maxA: finiteOrNull(item.maxA ?? (legacyWeight === 'A' ? item.max : null)),
      minC: finiteOrNull(item.minC ?? (legacyWeight === 'C' ? item.min : null)),
      maxC: finiteOrNull(item.maxC ?? (legacyWeight === 'C' ? item.max : null)),
      minZ: finiteOrNull(item.minZ ?? (legacyWeight === 'Z' ? item.min : null)),
      maxZ: finiteOrNull(item.maxZ ?? (legacyWeight === 'Z' ? item.max : null)),
      octavesA,
      octavesZ
    };
  }

  function loadResults() {
    const merged = [];
    const ids = new Set();
    const add = item => {
      if (!item || typeof item !== 'object') return;
      const normalized = normalizeResult(item);
      if (ids.has(normalized.id)) return;
      ids.add(normalized.id);
      merged.push(normalized);
    };

    try {
      const current = JSON.parse(localStorage.getItem(LS.results) || '[]');
      if (Array.isArray(current) && current.length) return current.map(normalizeResult);
    } catch (_) {}

    [LS.resultsV3, LS.timedV2, LS.timedV1, LS.manualV2].forEach(key => {
      try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(arr)) arr.forEach(add);
      } catch (_) {}
    });

    try {
      const old = JSON.parse(localStorage.getItem(LS.nativeV1) || '[]');
      if (Array.isArray(old)) old.forEach((m, i) => add({
        ...m,
        name: m.name || `Měření ${i + 1}`,
        leq: finiteOrNull(m.average),
        weighting: m.weighting || ''
      }));
    } catch (_) {}

    return merged;
  }

  function persistResults() {
    localStorage.setItem(LS.results, JSON.stringify(results));
  }

  function loadNumber(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function loadCalibration() {
    try {
      const parsed = JSON.parse(localStorage.getItem('hlukomer.freqCalibration.v2') || '{}');
      return Object.fromEntries(OCTAVES.map(f => {
        const n = Number(parsed[f]);
        return [f, Number.isFinite(n) ? n : 0];
      }));
    } catch (_) {
      return octaveMap(0);
    }
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
    if (freq <= OCTAVES[0]) return measurementCalibration[OCTAVES[0]] || 0;
    if (freq >= OCTAVES[OCTAVES.length - 1]) return measurementCalibration[OCTAVES[OCTAVES.length - 1]] || 0;
    const lf = Math.log(freq);
    for (let i = 0; i < OCTAVES.length - 1; i++) {
      const f1 = OCTAVES[i], f2 = OCTAVES[i + 1];
      if (freq >= f1 && freq <= f2) {
        const t = (lf - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
        return (measurementCalibration[f1] || 0) + ((measurementCalibration[f2] || 0) - (measurementCalibration[f1] || 0)) * t;
      }
    }
    return 0;
  }

  function currentSnapshot() {
    if (!capturedTime || !capturedFreq || !capturedSampleRate || !capturedFftSize) return null;

    let sumSquares = 0;
    for (let i = 0; i < capturedTime.length; i++) sumSquares += capturedTime[i] * capturedTime[i];
    const rms = Math.sqrt(sumSquares / capturedTime.length);
    const rawDbfs = 20 * Math.log10(Math.max(rms, 1e-9));
    const binHz = capturedSampleRate / capturedFftSize;
    const maxHz = Math.min(20000, capturedSampleRate / 2);

    let rawPower = 0;
    const adjusted = typeMap(0);
    const bandsA = octaveMap(0);
    const bandsZ = octaveMap(0);

    for (let i = 1; i < capturedFreq.length; i++) {
      const freq = i * binHz;
      if (freq < 20 || freq > maxHz) continue;
      const db = capturedFreq[i];
      if (!Number.isFinite(db) || db < -150) continue;

      const p = Math.pow(10, db / 10);
      rawPower += p;
      const cal = calibrationDb(freq);
      const pA = p * Math.pow(10, (cal + weightDb(freq, 'A')) / 10);
      const pC = p * Math.pow(10, (cal + weightDb(freq, 'C')) / 10);
      const pZ = p * Math.pow(10, cal / 10);
      adjusted.A += pA;
      adjusted.C += pC;
      adjusted.Z += pZ;

      for (const center of OCTAVES) {
        if (freq >= center / OCTAVE_FACTOR && freq < center * OCTAVE_FACTOR) {
          bandsA[center] += pA;
          bandsZ[center] += pZ;
          break;
        }
      }
    }

    if (!(rawPower > 0) || TYPES.some(type => !(adjusted[type] > 0))) return null;

    const db = {};
    const powers = {};
    TYPES.forEach(type => {
      const delta = 10 * Math.log10(adjusted[type] / rawPower);
      db[type] = rawDbfs + delta + (measurementSpl ? measurementOffset : 0);
      powers[type] = Math.pow(10, db[type] / 10);
    });

    const octavePowersA = octaveMap(0);
    const octavePowersZ = octaveMap(0);
    OCTAVES.forEach(center => {
      if (bandsA[center] > 0) {
        const bandDbA = db.A + 10 * Math.log10(bandsA[center] / adjusted.A);
        octavePowersA[center] = Math.pow(10, bandDbA / 10);
      }
      if (bandsZ[center] > 0) {
        const bandDbZ = db.Z + 10 * Math.log10(bandsZ[center] / adjusted.Z);
        octavePowersZ[center] = Math.pow(10, bandDbZ / 10);
      }
    });

    return { powers, octavePowersA, octavePowersZ };
  }

  function beginSession() {
    sessionActive = true;
    paused = false;
    finishing = false;
    sessionStartedAt = new Date();
    integratedMs = 0;
    totalEnergy = typeMap(0);
    octaveEnergyA = octaveMap(0);
    octaveEnergyZ = octaveMap(0);
    recentSegments = [];
    minLeq1 = typeMap(Infinity);
    maxLeq1 = typeMap(-Infinity);
    capturedTime = null;
    capturedFreq = null;
    capturedSampleRate = 0;
    capturedFftSize = 0;
    lastIntegratedSerial = capturedSerial;
    lastIntegrationPerf = performance.now();

    measurementWeighting = weighting?.value || 'A';
    measurementSpl = !!showSPL?.checked;
    measurementOffset = loadNumber('hlukomer.offsetDB.v2', loadNumber('noiseMeterOffsetDB', 40));
    measurementCalibration = loadCalibration();
    measurementCalibrated = localStorage.getItem(LS.calibrationState) !== null && localStorage.getItem(LS.calibrationState) !== 'uncalibrated';
    targetSeconds = clampSeconds(Number(timedSeconds.value));

    captureEnabled = true;
    lockMeasurementSettings(true);
    setTransportState('running');
    resetLeqDisplay();
    clearInterval(sampleTimer);
    sampleTimer = setInterval(updateCountdown, UI_TIMER_MS);
  }

  function integrateSnapshot(snapshot, dt) {
    TYPES.forEach(type => { totalEnergy[type] += snapshot.powers[type] * dt; });
    OCTAVES.forEach(center => {
      octaveEnergyA[center] += (snapshot.octavePowersA[center] || 0) * dt;
      octaveEnergyZ[center] += (snapshot.octavePowersZ[center] || 0) * dt;
    });
    integratedMs += dt;
    recentSegments.push({ end: integratedMs, dt, powers: snapshot.powers });
    const keepAfter = integratedMs - 5200;
    while (recentSegments.length && recentSegments[0].end < keepAfter) recentSegments.shift();

    if (integratedMs >= 900) {
      TYPES.forEach(type => {
        const v = recentLeq(1000, type);
        if (Number.isFinite(v)) {
          minLeq1[type] = Math.min(minLeq1[type], v);
          maxLeq1[type] = Math.max(maxLeq1[type], v);
        }
      });
    }
  }

  function sampleMeasurement(now = performance.now(), serial = capturedSerial) {
    if (!sessionActive || paused || finishing) return;
    if (serial === lastIntegratedSerial) return;
    let dt = now - lastIntegrationPerf;
    lastIntegrationPerf = now;
    lastIntegratedSerial = serial;
    if (!(dt > 0)) return;
    // Při zatížení nebo přepnutí karty nepřipisujeme jeden starý FFT snímek dlouhému intervalu.
    dt = Math.min(dt, MAX_FRAME_DT_MS);

    if (timedMode.checked) {
      const remaining = targetSeconds * 1000 - integratedMs;
      if (remaining <= 0) {
        finishMeasurement(true);
        return;
      }
      dt = Math.min(dt, remaining);
    }

    const snapshot = currentSnapshot();
    if (!snapshot) return;
    integrateSnapshot(snapshot, dt);
    renderLeq();
    updateCountdown();

    if (timedMode.checked && integratedMs >= targetSeconds * 1000 - 0.5) finishMeasurement(true);
  }

  function recentLeq(windowMs, type) {
    if (!recentSegments.length) return NaN;
    const start = Math.max(0, integratedMs - windowMs);
    let energy = 0;
    let duration = 0;
    for (const seg of recentSegments) {
      const segStart = seg.end - seg.dt;
      const overlap = Math.max(0, Math.min(seg.end, integratedMs) - Math.max(segStart, start));
      if (overlap > 0) {
        energy += seg.powers[type] * overlap;
        duration += overlap;
      }
    }
    return duration > 0 && energy > 0 ? 10 * Math.log10(energy / duration) : NaN;
  }

  function totalLeq(type) {
    return integratedMs > 0 && totalEnergy[type] > 0 ? 10 * Math.log10(totalEnergy[type] / integratedMs) : NaN;
  }

  function renderLeq() {
    const type = measurementWeighting;
    const leq1 = recentLeq(1000, type);
    const leq5 = recentLeq(5000, type);
    const total = totalLeq(type);
    const fmt = v => Number.isFinite(v) ? v.toFixed(1) : '--';
    ui.big.textContent = fmt(leq1);
    ui.leq1.textContent = fmt(leq1);
    ui.leq5.textContent = fmt(leq5);
    ui.total.textContent = fmt(total);
    ui.min.textContent = Number.isFinite(minLeq1[type]) ? minLeq1[type].toFixed(1) : '--';
    ui.max.textContent = Number.isFinite(maxLeq1[type]) ? maxLeq1[type].toFixed(1) : '--';
    ui.bar.style.width = `${meterPercent(leq1).toFixed(1)}%`;
  }

  function resetLeqDisplay() {
    [ui.big, ui.leq1, ui.leq5, ui.total, ui.min, ui.max].forEach(el => { if (el) el.textContent = '--'; });
    if (ui.bar) ui.bar.style.width = '0%';
    updateCountdown();
  }

  function meterPercent(db) {
    if (!Number.isFinite(db)) return 0;
    const min = measurementSpl ? 30 : -70;
    const max = measurementSpl ? 110 : 0;
    return Math.max(0, Math.min(100, ((db - min) / (max - min)) * 100));
  }

  function pauseMeasurement() {
    if (!sessionActive || paused || finishing) return;
    sampleMeasurement();
    paused = true;
    captureEnabled = false;
    setTransportState('paused');
    statusPill.textContent = 'pozastaveno';
    updateCountdown();
  }

  function resumeMeasurement() {
    if (!sessionActive || !paused || finishing) return;
    paused = false;
    captureEnabled = true;
    lastIntegrationPerf = performance.now();
    setTransportState('running');
    statusPill.textContent = 'měřím';
  }

  function sampleMeasurementFinal() {
    if (capturedSerial === lastIntegratedSerial) return;
    const now = performance.now();
    let dt = Math.min(Math.max(0, now - lastIntegrationPerf), MAX_FRAME_DT_MS);
    lastIntegrationPerf = now;
    lastIntegratedSerial = capturedSerial;
    if (timedMode.checked) dt = Math.min(dt, Math.max(0, targetSeconds * 1000 - integratedMs));
    if (!(dt > 0)) return;
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    integrateSnapshot(snapshot, dt);
    renderLeq();
  }

  function finishMeasurement(autoFinished) {
    if (!sessionActive || finishing) return;
    if (!paused) sampleMeasurementFinal();
    finishing = true;
    paused = false;
    captureEnabled = false;
    clearInterval(sampleTimer);
    sampleTimer = 0;
    if (!nativeStop.disabled) nativeStop.click();

    const item = makeResult(autoFinished);
    setTimeout(() => {
      const shouldSave = item && confirm('Chcete měření uložit?');
      if (shouldSave) {
        const defaultName = `Měření ${results.length + 1}`;
        const entered = prompt('Název měření:', defaultName);
        if (entered !== null) {
          item.name = entered.trim() || defaultName;
          results.push(item);
          persistResults();
          renderResults();
        }
      }

      sessionActive = false;
      finishing = false;
      pendingStart = false;
      lockMeasurementSettings(false);
      setTransportState('stopped');
      timedCountdown.textContent = '';
      statusPill.textContent = 'připraven';
    }, 80);
  }

  function makeResult(autoFinished) {
    if (!(integratedMs > 0) || !(totalEnergy.A > 0)) return null;
    const octavesA = {};
    const octavesZ = {};
    OCTAVES.forEach(center => {
      octavesA[center] = octaveEnergyA[center] > 0 ? Number((10 * Math.log10(octaveEnergyA[center] / integratedMs)).toFixed(2)) : null;
      octavesZ[center] = octaveEnergyZ[center] > 0 ? Number((10 * Math.log10(octaveEnergyZ[center] / integratedMs)).toFixed(2)) : null;
    });

    return normalizeResult({
      id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      name: '',
      startedAt: sessionStartedAt ? sessionStartedAt.toISOString() : new Date().toISOString(),
      durationSec: Number((integratedMs / 1000).toFixed(2)),
      timed: !!timedMode.checked,
      targetSec: timedMode.checked ? targetSeconds : null,
      completedTarget: !!(autoFinished && timedMode.checked),
      spl: measurementSpl,
      calibrated: measurementSpl ? measurementCalibrated : null,
      leqA: Number(totalLeq('A').toFixed(2)),
      leqC: Number(totalLeq('C').toFixed(2)),
      leqZ: Number(totalLeq('Z').toFixed(2)),
      minA: Number.isFinite(minLeq1.A) ? Number(minLeq1.A.toFixed(2)) : null,
      maxA: Number.isFinite(maxLeq1.A) ? Number(maxLeq1.A.toFixed(2)) : null,
      minC: Number.isFinite(minLeq1.C) ? Number(minLeq1.C.toFixed(2)) : null,
      maxC: Number.isFinite(maxLeq1.C) ? Number(maxLeq1.C.toFixed(2)) : null,
      minZ: Number.isFinite(minLeq1.Z) ? Number(minLeq1.Z.toFixed(2)) : null,
      maxZ: Number.isFinite(maxLeq1.Z) ? Number(maxLeq1.Z.toFixed(2)) : null,
      octavesA,
      octavesZ
    });
  }

  function setTransportState(state) {
    if (state === 'running') {
      ui.play.textContent = 'Ⅱ';
      ui.play.title = 'Pozastavit měření';
      ui.play.setAttribute('aria-label', 'Pozastavit měření');
      ui.play.disabled = false;
      ui.stop.disabled = false;
    } else if (state === 'paused') {
      ui.play.textContent = '▶';
      ui.play.title = 'Pokračovat v měření';
      ui.play.setAttribute('aria-label', 'Pokračovat v měření');
      ui.play.disabled = false;
      ui.stop.disabled = false;
    } else if (state === 'starting') {
      ui.play.textContent = '▶';
      ui.play.disabled = true;
      ui.stop.disabled = true;
    } else {
      ui.play.textContent = '▶';
      ui.play.title = 'Spustit nové měření';
      ui.play.setAttribute('aria-label', 'Spustit nové měření');
      ui.play.disabled = false;
      ui.stop.disabled = true;
    }
  }

  function lockMeasurementSettings(locked) {
    timedMode.disabled = locked;
    timedSeconds.disabled = locked;
    document.querySelectorAll('.preset').forEach(btn => btn.disabled = locked);
    if (weighting) weighting.disabled = locked;
    if (showSPL) showSPL.disabled = locked;
    if (offsetNum) offsetNum.disabled = locked;
  }

  function updateCountdown() {
    if (!timedMode.checked || !sessionActive) {
      timedCountdown.textContent = '';
      return;
    }
    const remain = Math.max(0, targetSeconds - integratedMs / 1000);
    timedCountdown.textContent = paused ? `⏸ ${remain.toFixed(1)} s` : `${remain.toFixed(remain < 10 ? 1 : 0)} s`;
  }

  function updateTimedVisibility() {
    timedOptions.hidden = !timedMode.checked;
    localStorage.setItem(LS.mode, timedMode.checked ? '1' : '0');
    if (resultsDetails) resultsDetails.style.display = '';
  }

  function updatePresetState() {
    document.querySelectorAll('.preset').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.sec) === Number(timedSeconds.value));
    });
  }

  function primaryValue(item) {
    if (item.leqA !== null) return { value: item.leqA, unit: item.spl ? 'dBA' : 'dBFS A' };
    if (item.leqC !== null) return { value: item.leqC, unit: item.spl ? 'dBC' : 'dBFS C' };
    if (item.leqZ !== null) return { value: item.leqZ, unit: item.spl ? 'dBZ' : 'dBFS Z' };
    return { value: null, unit: 'dB' };
  }

  function renderResults() {
    resultsList.innerHTML = '';
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Žádná uložená měření';
      resultsList.appendChild(empty);
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
      meta.textContent = `${Number(item.durationSec).toFixed(1)} s · ${item.timed ? 'časované' : 'ruční'} · ${d.toLocaleTimeString('cs-CZ', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}${item.spl && item.calibrated === false ? ' · nekalibrované SPL' : ''}`;
      left.append(name, meta);

      const right = document.createElement('div');
      right.className = 'resultRight';
      const value = document.createElement('div');
      value.className = 'timedValue';
      const primary = primaryValue(item);
      value.textContent = primary.value === null ? '--' : `${primary.value.toFixed(1)} ${primary.unit}`;

      const del = document.createElement('button');
      del.className = 'resultDelete';
      del.textContent = '🗑';
      del.title = 'Smazat měření';
      del.setAttribute('aria-label', `Smazat ${item.name || `měření ${index + 1}`}`);
      del.addEventListener('click', () => {
        const label = item.name || `Měření ${index + 1}`;
        if (!confirm(`Smazat měření „${label}“?`)) return;
        results = results.filter(r => r.id !== item.id);
        persistResults();
        renderResults();
      });

      right.append(value, del);
      row.append(left, right);
      resultsList.appendChild(row);
    });
  }

  function csvCell(v) {
    return `"${String(v ?? '').replace(/"/g, '""')}"`;
  }

  function numCs(v, digits = 2) {
    return Number.isFinite(Number(v)) ? Number(v).toFixed(digits).replace('.', ',') : '';
  }

  function octaveHeader(center, weight) {
    const f = center >= 1000 ? `${String(center / 1000).replace('.', ',')} kHz` : `${String(center).replace('.', ',')} Hz`;
    return `${f} ${weight} [dB]`;
  }

  function exportResults() {
    if (!results.length) {
      alert('Nejsou žádná uložená měření.');
      return;
    }

    const rows = [[
      'Název','Datum','Čas','Délka [s]','Režim','Hladina','Kalibrace SPL',
      'Leq A [dB]','Leq C [dB]','Leq Z [dB]',
      'Minimum Leq 1 s A [dB]','Maximum Leq 1 s A [dB]',
      ...OCTAVES.map(f => octaveHeader(f, 'A')),
      ...OCTAVES.map(f => octaveHeader(f, 'Z'))
    ]];

    results.forEach(item => {
      const d = new Date(item.startedAt);
      rows.push([
        item.name || '',
        d.toLocaleDateString('cs-CZ'),
        d.toLocaleTimeString('cs-CZ'),
        numCs(item.durationSec),
        item.timed ? 'časované' : 'ruční',
        item.spl ? 'SPL' : 'dBFS',
        item.calibrated === true ? 'ano' : item.calibrated === false ? 'ne' : '',
        numCs(item.leqA),
        numCs(item.leqC),
        numCs(item.leqZ),
        numCs(item.minA),
        numCs(item.maxA),
        ...OCTAVES.map(center => numCs(item.octavesA?.[center])),
        ...OCTAVES.map(center => numCs(item.octavesZ?.[center]))
      ]);
    });

    const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hlukomer-mereni-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  ui.play.addEventListener('click', () => {
    if (finishing || pendingStart) return;
    if (!sessionActive) {
      pendingStart = true;
      captureEnabled = true;
      setTransportState('starting');
      nativeStart.click();
      return;
    }
    if (paused) resumeMeasurement();
    else pauseMeasurement();
  });

  ui.stop.addEventListener('click', () => finishMeasurement(false));

  timedMode.addEventListener('change', () => {
    updateTimedVisibility();
    updateCountdown();
  });

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      timedSeconds.value = btn.dataset.sec;
      targetSeconds = Number(btn.dataset.sec);
      localStorage.setItem(LS.seconds, String(targetSeconds));
      updatePresetState();
    });
  });

  timedSeconds.addEventListener('change', () => {
    const value = clampSeconds(Number(timedSeconds.value));
    timedSeconds.value = value;
    targetSeconds = value;
    localStorage.setItem(LS.seconds, String(value));
    updatePresetState();
  });

  const statusObserver = new MutationObserver(() => {
    const text = statusPill.textContent.trim();
    if (pendingStart && text.startsWith('měřím')) {
      pendingStart = false;
      beginSession();
    }
    if (pendingStart && text.includes('nepovolen')) {
      pendingStart = false;
      captureEnabled = false;
      setTransportState('stopped');
    }
  });
  statusObserver.observe(statusPill, { childList: true, characterData: true, subtree: true });

  exportBtn.addEventListener('click', exportResults);
  clearBtn.addEventListener('click', () => {
    if (!results.length) return;
    if (!confirm('Smazat všechna uložená měření?')) return;
    results = [];
    persistResults();
    renderResults();
  });

  if (nativeSave) nativeSave.disabled = true;
  if (nativeExport) nativeExport.disabled = true;
  if (nativeReset) nativeReset.disabled = true;

  window.addEventListener('beforeunload', () => clearInterval(sampleTimer));
})();