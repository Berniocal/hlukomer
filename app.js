/* Hlukoměr PWA – spektrum, A/C/Z vážení, kalibrace, ukládání a export. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const MATH = window.HLUKOMER_MATH;
  if (!MATH) throw new Error('Chybí acoustic-math.js');

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const resetBtn = $('resetBtn');
  const saveMeasurementBtn = $('saveMeasurementBtn');
  const exportExcelBtn = $('exportExcelBtn');
  const savedMeasurementsEl = $('savedMeasurements');

  const dbOut = $('dbOut');
  const unitOut = $('unitOut');
  const calibrationStateBadge = $('calibrationStateBadge');
  const subOut = $('subOut');
  const statusPill = $('statusPill');
  const instOut = $('instOut');
  const maxOut = $('maxOut');
  const minOut = $('minOut');
  const avgOut = $('avgOut');
  const measureAvgOut = $('measureAvgOut');
  const bar = $('bar');

  const permWarn = $('permWarn');
  const showSPL = $('showSPL');
  const holdPeak = $('holdPeak');
  const weighting = $('weighting');
  const offsetNum = $('offsetNum');
  const calibrateBtn = $('calibrateBtn');
  const freqCalBtn = $('freqCalBtn');
  const zeroCalBtn = $('zeroCalBtn');
  const displayResponse = $('displayResponse');
  const fftSizeSelect = $('fftSize');
  const resolutionNote = $('resolutionNote');
  const micProcessingStatus = $('micProcessingStatus');
  const spectrumMode = $('spectrumMode');
  const freqScale = $('freqScale');
  const peakFreq = $('peakFreq');
  const peakNote = $('peakNote');
  const calGrid = $('calGrid');

  const spectrumCanvas = $('spectrumChart');
  const historyCanvas = $('historyChart');
  const sctx = spectrumCanvas.getContext('2d');
  const hctx = historyCanvas.getContext('2d');

  const LS = {
    offset: 'hlukomer.offsetDB.v2',
    spl: 'hlukomer.showSPL.v2',
    hold: 'hlukomer.holdPeak.v2',
    weighting: 'hlukomer.weighting.v2',
    fft: 'hlukomer.fftSize.v2',
    mode: 'hlukomer.spectrumMode.v2',
    scale: 'hlukomer.freqScale.v2',
    freqCal: 'hlukomer.freqCalibration.v2',
    response: 'hlukomer.displayResponse.v1',
    measurements: 'hlukomer.measurements.v1',
    calibrationState: 'hlukomer.calibrationState.v1'
  };

  const CAL_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const THIRD_OCT = [25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
  const HISTORY_MS = 30000;
  const MAX_SAVED_MEASUREMENTS = 10;
  const MAX_SESSION_SAMPLES = 7200;

  function loadNumber(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function loadCalibration() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS.freqCal) || '{}');
      return Object.fromEntries(CAL_FREQS.map(f => {
        const n = Number(parsed[f]);
        return [f, Number.isFinite(n) ? n : 0];
      }));
    } catch (_) {
      return Object.fromEntries(CAL_FREQS.map(f => [f, 0]));
    }
  }

  function loadMeasurements() {
    try {
      const data = JSON.parse(localStorage.getItem(LS.measurements) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  }

  let offsetDB = loadNumber(LS.offset, loadNumber('noiseMeterOffsetDB', 40));
  let freqCalibration = loadCalibration();
  let savedMeasurements = loadMeasurements();

  let audioCtx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let captureWorkletNode = null;
  let captureWorkletSink = null;
  let timeData = null;
  let freqData = null;
  let visualFreqData = null;
  let visualFreqInitialized = false;
  let running = false;
  let raf = 0;
  let frameCounter = 0;
  let lastRawDbfs = NaN;
  let lastPeakHz = NaN;

  window.HLUKOMER_CONTINUOUS_CAPTURE = false;

  function setContinuousCaptureMode(enabled) {
    window.HLUKOMER_CONTINUOUS_CAPTURE = Boolean(enabled);
    window.dispatchEvent(new CustomEvent('hlukomer-capture-mode', {
      detail: { continuous: Boolean(enabled) }
    }));
  }

  function resetContinuousCapture() {
    try { captureWorkletNode?.port.postMessage({ type: 'reset' }); } catch (_) {}
  }

  window.hlukomerResetContinuousCapture = resetContinuousCapture;

  async function setupContinuousCapture() {
    setContinuousCaptureMode(false);
    if (!audioCtx?.audioWorklet || typeof AudioWorkletNode !== 'function') return false;

    try {
      await audioCtx.audioWorklet.addModule('measurement-worklet.js?v=25');
      captureWorkletNode = new AudioWorkletNode(audioCtx, 'hlukomer-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      captureWorkletSink = audioCtx.createGain();
      captureWorkletSink.gain.value = 0;

      captureWorkletNode.port.onmessage = event => {
        const data = event.data;
        if (data?.type !== 'block' || !(data.samples instanceof Float32Array)) return;
        window.dispatchEvent(new CustomEvent('hlukomer-audio-block', {
          detail: { samples: data.samples, sampleRate: Number(data.sampleRate) || audioCtx?.sampleRate || 0 }
        }));
      };

      source.connect(captureWorkletNode);
      captureWorkletNode.connect(captureWorkletSink);
      captureWorkletSink.connect(audioCtx.destination);
      resetContinuousCapture();
      setContinuousCaptureMode(true);
      return true;
    } catch (error) {
      console.warn('AudioWorklet není dostupný, používám záložní měření.', error);
      try { captureWorkletNode?.disconnect(); } catch (_) {}
      try { captureWorkletSink?.disconnect(); } catch (_) {}
      captureWorkletNode = null;
      captureWorkletSink = null;
      setContinuousCaptureMode(false);
      return false;
    }
  }

  let minDB = Infinity;
  let maxDB = -Infinity;
  const history = [];
  const historyTimes = [];

  let smoothedPower = NaN;
  let lastSmoothAt = 0;
  let lastLoopAt = 0;

  let sessionId = null;
  let sessionStartedAt = null;
  let sessionEndedAt = null;
  let sessionEnergy = 0;
  let sessionDurationMs = 0;
  let sessionSamples = [];
  let lastStoredSampleAt = 0;

  function saveSettings() {
    localStorage.setItem(LS.offset, String(offsetDB));
    localStorage.setItem(LS.spl, showSPL.checked ? '1' : '0');
    localStorage.setItem(LS.hold, holdPeak.checked ? '1' : '0');
    localStorage.setItem(LS.weighting, weighting.value);
    localStorage.setItem(LS.fft, fftSizeSelect.value);
    localStorage.setItem(LS.mode, spectrumMode.value);
    localStorage.setItem(LS.scale, freqScale.value);
    localStorage.setItem(LS.freqCal, JSON.stringify(freqCalibration));
    localStorage.setItem(LS.response, displayResponse.value);
  }

  function calibrationState() {
    return localStorage.getItem(LS.calibrationState) || 'uncalibrated';
  }

  function isSplCalibrated() {
    return calibrationState() !== 'uncalibrated';
  }

  function renderCalibrationState() {
    if (!calibrationStateBadge) return;
    calibrationStateBadge.hidden = !showSPL.checked;
    if (!showSPL.checked) return;
    const calibrated = isSplCalibrated();
    calibrationStateBadge.classList.toggle('good', calibrated);
    calibrationStateBadge.textContent = calibrated ? 'SPL kalibrováno' : 'SPL nekalibrováno';
    calibrationStateBadge.title = calibrated
      ? 'Absolutní SPL používá uloženou kalibraci.'
      : 'Absolutní SPL používá pouze výchozí orientační offset. Pro přesné dB proveďte kalibraci.';
  }

  function setSplCalibrationState(state) {
    localStorage.setItem(LS.calibrationState, state || 'uncalibrated');
    renderCalibrationState();
  }

  function inspectMicrophoneTrack(track) {
    let settings = {};
    try { settings = typeof track?.getSettings === 'function' ? track.getSettings() : {}; }
    catch (_) { settings = {}; }

    const labels = {
      autoGainControl: 'AGC',
      noiseSuppression: 'potlačení šumu',
      echoCancellation: 'potlačení ozvěny'
    };
    const keys = Object.keys(labels);
    const active = keys.filter(key => settings[key] === true);
    const disabled = keys.filter(key => settings[key] === false);
    const unknown = keys.filter(key => typeof settings[key] !== 'boolean');
    const status = { settings, active, disabled, unknown };
    window.HLUKOMER_MIC_PROCESSING = status;

    if (micProcessingStatus) {
      const parts = keys.map(key => {
        if (settings[key] === false) return `${labels[key]} vypnuto`;
        if (settings[key] === true) return `${labels[key]} ZAPNUTO`;
        return `${labels[key]} nezjištěno`;
      });
      const rate = Number(settings.sampleRate);
      if (Number.isFinite(rate)) parts.push(`${Math.round(rate / 1000)} kHz`);
      micProcessingStatus.textContent = `Skutečné nastavení: ${parts.join(' · ')}`;
      micProcessingStatus.classList.toggle('good', active.length === 0 && unknown.length === 0);
      micProcessingStatus.classList.toggle('warn', active.length > 0);
    }
    return status;
  }

  window.hlukomerInspectMicrophoneTrack = inspectMicrophoneTrack;
  window.hlukomerIsSplCalibrated = isSplCalibrated;
  window.hlukomerSetSplCalibrationState = setSplCalibrationState;

  function persistMeasurements() {
    savedMeasurements = savedMeasurements.slice(0, MAX_SAVED_MEASUREMENTS);
    try {
      localStorage.setItem(LS.measurements, JSON.stringify(savedMeasurements));
    } catch (_) {
      savedMeasurements = savedMeasurements.map(m => ({ ...m, samples: (m.samples || []).filter((_, i) => i % 2 === 0) }));
      try { localStorage.setItem(LS.measurements, JSON.stringify(savedMeasurements)); } catch (_) {}
    }
  }

  showSPL.checked = (localStorage.getItem(LS.spl) ?? localStorage.getItem('noiseMeterShowSPL') ?? '1') === '1';
  holdPeak.checked = (localStorage.getItem(LS.hold) ?? localStorage.getItem('noiseMeterHoldPeak') ?? '0') === '1';

  const savedWeighting = localStorage.getItem(LS.weighting);
  if (savedWeighting) weighting.value = savedWeighting;
  else {
    const oldA = localStorage.getItem('noiseMeterAWeight');
    weighting.value = oldA === null ? 'A' : (oldA === '1' ? 'A' : 'Z');
  }

  fftSizeSelect.value = localStorage.getItem(LS.fft) || '4096';
  spectrumMode.value = localStorage.getItem(LS.mode) || 'line';
  freqScale.value = localStorage.getItem(LS.scale) || 'log';
  displayResponse.value = localStorage.getItem(LS.response) || '0.8';
  offsetNum.value = offsetDB.toFixed(1);

  function weightingLabel() {
    return weighting.value === 'A' ? 'A' : weighting.value === 'C' ? 'C' : 'Z';
  }

  function unitLabel() {
    return showSPL.checked ? `dB${weightingLabel()}` : `dBFS (${weightingLabel()})`;
  }

  function renderUnits() {
    unitOut.textContent = unitLabel();
    subOut.textContent = '';
    renderCalibrationState();
  }

  function renderCalibrationGrid() {
    calGrid.innerHTML = '';
    CAL_FREQS.forEach(freq => {
      const box = document.createElement('div');
      box.className = 'cal';
      const label = document.createElement('label');
      label.textContent = formatFreq(freq);
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.min = '-30';
      input.max = '30';
      input.value = Number(freqCalibration[freq] || 0).toFixed(1);
      input.setAttribute('aria-label', `Korekce ${formatFreq(freq)} v dB`);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        freqCalibration[freq] = Math.max(-30, Math.min(30, v));
        saveSettings();
      });
      box.append(label, input);
      calGrid.appendChild(box);
    });
  }

  function renderSavedMeasurements() {
    savedMeasurementsEl.innerHTML = '';
    if (!savedMeasurements.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Žádná uložená měření';
      savedMeasurementsEl.appendChild(empty);
      return;
    }

    savedMeasurements.forEach(item => {
      const row = document.createElement('div');
      row.className = 'savedItem';
      const main = document.createElement('div');
      main.className = 'savedMain';
      const title = document.createElement('div');
      title.className = 'savedTitle';
      const d = new Date(item.startedAt);
      title.textContent = `${d.toLocaleDateString('cs-CZ')} ${d.toLocaleTimeString('cs-CZ', {hour:'2-digit', minute:'2-digit'})}`;
      const meta = document.createElement('div');
      meta.className = 'savedMeta';
      meta.textContent = `${formatDuration(item.durationSec)} · ${fmt(item.average)} ${item.unit || 'dB'}${item.calibrated === false ? ' · nekalibrované SPL' : ''}`;
      main.append(title, meta);

      const del = document.createElement('button');
      del.className = 'savedDelete';
      del.textContent = 'Smazat';
      del.addEventListener('click', () => {
        savedMeasurements = savedMeasurements.filter(m => m.id !== item.id);
        persistMeasurements();
        renderSavedMeasurements();
      });
      row.append(main, del);
      savedMeasurementsEl.appendChild(row);
    });
  }

  function formatFreq(freq) {
    if (freq >= 1000) {
      const k = freq / 1000;
      return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)} kHz`;
    }
    return `${freq} Hz`;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function setStatus(text) { statusPill.textContent = text; }
  function fmt(v) { return Number.isFinite(v) ? v.toFixed(1) : '--'; }

  function weightDb(freq, type) {
    return MATH.weightDb(freq, type);
  }

  function calibrationDb(freq) {
    return MATH.calibrationDb(freq, freqCalibration, CAL_FREQS);
  }

  function computeRawRmsDbfs() {
    analyser.getFloatTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
    const rms = Math.sqrt(sum / timeData.length);
    return 20 * Math.log10(Math.max(rms, 1e-9));
  }

  function getSpectrum() {
    analyser.getFloatFrequencyData(freqData);

    // Pouze vizuální vyhlazení grafu. freqData zůstává syrové pro výpočty SPL/Leq.
    const keep = 0.55;
    if (!visualFreqInitialized || !visualFreqData || visualFreqData.length !== freqData.length) {
      visualFreqData = new Float32Array(freqData);
      visualFreqInitialized = true;
    } else {
      for (let i = 0; i < freqData.length; i += 1) {
        const raw = Number.isFinite(freqData[i]) ? freqData[i] : -160;
        const prev = Number.isFinite(visualFreqData[i]) ? visualFreqData[i] : raw;
        const p = keep * Math.pow(10, prev / 10) + (1 - keep) * Math.pow(10, raw / 10);
        visualFreqData[i] = 10 * Math.log10(Math.max(p, 1e-20));
      }
    }

    const nyquist = audioCtx.sampleRate / 2;
    return { binHz: nyquist / freqData.length, nyquist };
  }

  function spectralDeltaDb(type, binHz) {
    let rawPower = 0;
    let adjustedPower = 0;
    const maxHz = Math.min(20000, audioCtx.sampleRate / 2);
    for (let i = 1; i < freqData.length; i++) {
      const freq = i * binHz;
      if (freq < 20 || freq > maxHz) continue;
      const db = freqData[i];
      if (!Number.isFinite(db) || db < -150) continue;
      const p = Math.pow(10, db / 10);
      rawPower += p;
      const adj = calibrationDb(freq) + weightDb(freq, type);
      adjustedPower += p * Math.pow(10, adj / 10);
    }
    if (!(rawPower > 0) || !(adjustedPower > 0)) return 0;
    return 10 * Math.log10(adjustedPower / rawPower);
  }

  function displayedDb(rawDbfs, deltaDb) {
    const weightedDbfs = rawDbfs + deltaDb;
    return showSPL.checked ? weightedDbfs + offsetDB : weightedDbfs;
  }

  function smoothDb(db, now) {
    const p = Math.pow(10, db / 10);
    if (!Number.isFinite(smoothedPower) || !lastSmoothAt) {
      smoothedPower = p;
      lastSmoothAt = now;
      return db;
    }
    const dt = Math.max(1, Math.min(250, now - lastSmoothAt));
    lastSmoothAt = now;
    const tauMs = Math.max(50, Number(displayResponse.value || 0.8) * 1000);
    const alpha = 1 - Math.exp(-dt / tauMs);
    smoothedPower += alpha * (p - smoothedPower);
    return 10 * Math.log10(Math.max(smoothedPower, 1e-20));
  }

  function energyAverage(values) {
    return MATH.energyAverageDb(values);
  }

  function averageRecent(sec) {
    const cutoff = performance.now() - sec * 1000;
    const values = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (historyTimes[i] < cutoff) break;
      values.push(history[i]);
    }
    return energyAverage(values);
  }

  function currentMeasurementAverage() {
    return MATH.leqFromEnergy(sessionEnergy, sessionDurationMs);
  }

  function beginSession() {
    minDB = Infinity;
    maxDB = -Infinity;
    history.length = 0;
    historyTimes.length = 0;
    smoothedPower = NaN;
    lastSmoothAt = 0;
    lastLoopAt = 0;
    sessionId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    sessionStartedAt = new Date();
    sessionEndedAt = null;
    sessionEnergy = 0;
    sessionDurationMs = 0;
    sessionSamples = [];
    lastStoredSampleAt = 0;
    maxOut.textContent = minOut.textContent = avgOut.textContent = measureAvgOut.textContent = '--';
    dbOut.textContent = instOut.textContent = '--';
    bar.style.width = '0%';
    saveMeasurementBtn.disabled = true;
  }

  function resetCurrentMeasurement() {
    if (running) beginSession();
    else {
      minDB = Infinity;
      maxDB = -Infinity;
      history.length = 0;
      historyTimes.length = 0;
      smoothedPower = NaN;
      lastSmoothAt = 0;
      lastLoopAt = 0;
      sessionId = null;
      sessionStartedAt = null;
      sessionEndedAt = null;
      sessionEnergy = 0;
      sessionDurationMs = 0;
      sessionSamples = [];
      dbOut.textContent = instOut.textContent = maxOut.textContent = minOut.textContent = avgOut.textContent = measureAvgOut.textContent = '--';
      bar.style.width = '0%';
      saveMeasurementBtn.disabled = true;
      drawEmptyCharts();
    }
  }

  function updateResolutionNote() {
    const fft = Number(fftSizeSelect.value);
    if (!audioCtx) {
      resolutionNote.textContent = `${fft}`;
      return;
    }
    const hz = audioCtx.sampleRate / fft;
    resolutionNote.textContent = `${hz.toFixed(1)} Hz`;
  }

  function updatePeak(binHz) {
    let bestDb = -Infinity;
    let bestHz = NaN;
    const displayData = visualFreqData || freqData;
    const maxHz = Math.min(20000, audioCtx.sampleRate / 2);
    for (let i = 1; i < displayData.length; i++) {
      const freq = i * binHz;
      if (freq < 20 || freq > maxHz) continue;
      const corrected = displayData[i] + calibrationDb(freq) + weightDb(freq, weighting.value);
      if (corrected > bestDb) {
        bestDb = corrected;
        bestHz = freq;
      }
    }
    lastPeakHz = bestHz;
    peakFreq.textContent = Number.isFinite(bestHz) ? Math.round(bestHz) : '--';
    peakNote.textContent = '';
  }

  function mapMeter(db) {
    const min = showSPL.checked ? 30 : -70;
    const max = showSPL.checked ? 110 : 0;
    return Math.max(0, Math.min(100, ((db - min) / (max - min)) * 100));
  }

  async function start() {
    if (running) return;
    permWarn.style.display = 'none';
    setStatus('mikrofon…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
    } catch (err) {
      console.error(err);
      setStatus('mikrofon nepovolen');
      permWarn.style.display = 'block';
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    inspectMicrophoneTrack(stream.getAudioTracks?.()[0]);
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = Number(fftSizeSelect.value);
    // Měřicí FFT musí být bez časového vyhlazení. Vyhlazujeme jen data kreslená do grafu.
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    source.connect(analyser);
    allocateBuffers();
    await setupContinuousCapture();

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    beginSession();
    setStatus('měřím');
    updateResolutionNote();
    loop();
  }

  function allocateBuffers() {
    timeData = new Float32Array(analyser.fftSize);
    freqData = new Float32Array(analyser.frequencyBinCount);
    visualFreqData = new Float32Array(analyser.frequencyBinCount);
    visualFreqData.fill(-120);
    visualFreqInitialized = false;
  }

  function addFinalSample() {
    if (!sessionStartedAt || !history.length || sessionSamples.length >= MAX_SESSION_SAMPLES) return;
    const lastDb = history[history.length - 1];
    const lastSec = sessionSamples.length ? sessionSamples[sessionSamples.length - 1].t : -1;
    const sec = sessionDurationMs / 1000;
    if (sec - lastSec > 0.25) sessionSamples.push({ t: Number(sec.toFixed(2)), db: Number(lastDb.toFixed(2)) });
  }

  function stop() {
    if (!running) return;
    addFinalSample();
    sessionEndedAt = new Date();
    running = false;
    cancelAnimationFrame(raf);
    try { source?.disconnect(); } catch (_) {}
    try { analyser?.disconnect(); } catch (_) {}
    try { captureWorkletNode && (captureWorkletNode.port.onmessage = null); } catch (_) {}
    try { captureWorkletNode?.disconnect(); } catch (_) {}
    try { captureWorkletSink?.disconnect(); } catch (_) {}
    captureWorkletNode = null;
    captureWorkletSink = null;
    setContinuousCaptureMode(false);
    stream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
    stream = source = analyser = audioCtx = null;
    timeData = freqData = visualFreqData = null;
    visualFreqInitialized = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    saveMeasurementBtn.disabled = !(sessionDurationMs > 0);
    setStatus('zastaveno');
  }

  function loop() {
    if (!running) return;

    lastRawDbfs = computeRawRmsDbfs();
    const { binHz } = getSpectrum();
    const delta = spectralDeltaDb(weighting.value, binHz);
    const rawDisplay = displayedDb(lastRawDbfs, delta);
    const now = performance.now();
    const disp = smoothDb(rawDisplay, now);

    if (lastLoopAt) {
      const dt = Math.max(0, Math.min(250, now - lastLoopAt));
      if (dt > 0) {
        sessionEnergy += Math.pow(10, rawDisplay / 10) * dt;
        sessionDurationMs += dt;
      }
    }
    lastLoopAt = now;

    minDB = Math.min(minDB, disp);
    maxDB = Math.max(maxDB, disp);
    history.push(disp);
    historyTimes.push(now);
    while (historyTimes.length && historyTimes[0] < now - HISTORY_MS) {
      historyTimes.shift();
      history.shift();
    }

    if (sessionSamples.length < MAX_SESSION_SAMPLES && (!lastStoredSampleAt || now - lastStoredSampleAt >= 1000)) {
      sessionSamples.push({ t: Number((sessionDurationMs / 1000).toFixed(2)), db: Number(disp.toFixed(2)) });
      lastStoredSampleAt = now;
    }

    const hero = holdPeak.checked ? maxDB : disp;
    dbOut.textContent = fmt(hero);
    instOut.textContent = fmt(disp);
    maxOut.textContent = fmt(maxDB);
    minOut.textContent = fmt(minDB);
    avgOut.textContent = fmt(averageRecent(5));
    measureAvgOut.textContent = fmt(currentMeasurementAverage());
    bar.style.width = `${mapMeter(hero).toFixed(1)}%`;
    saveMeasurementBtn.disabled = !(sessionDurationMs > 500);

    updatePeak(binHz);
    if ((frameCounter++ % 2) === 0) {
      drawSpectrum(binHz);
      drawHistory();
    }
    raf = requestAnimationFrame(loop);
  }

  function clearCanvas(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0d1627';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawEmptyCharts() {
    clearCanvas(sctx, spectrumCanvas);
    clearCanvas(hctx, historyCanvas);
  }

  function drawSpectrum(binHz) {
    const c = spectrumCanvas, ctx = sctx;
    clearCanvas(ctx, c);
    const padL = 52, padR = 16, padT = 18, padB = 34;
    const w = c.width - padL - padR, h = c.height - padT - padB;
    const fMin = 20;
    const fMax = Math.min(20000, audioCtx.sampleRate / 2);
    const yMin = -100, yMax = 0;

    drawGrid(ctx, c, padL, padR, padT, padB, yMin, yMax);

    const xForFreq = f => {
      if (freqScale.value === 'linear') return padL + w * ((f - fMin) / (fMax - fMin));
      return padL + w * ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin)));
    };
    const yForDb = db => padT + h * (1 - (db - yMin) / (yMax - yMin));

    drawFreqLabels(ctx, xForFreq, padT + h, fMin, fMax);

    const displayData = visualFreqData || freqData;
    if (spectrumMode.value === 'bars') {
      drawThirdOctaveBars(ctx, xForFreq, yForDb, binHz, fMin, fMax, yMin, displayData);
    } else {
      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      let started = false;
      const step = Math.max(1, Math.floor(displayData.length / 1400));
      for (let i = 1; i < displayData.length; i += step) {
        const f = i * binHz;
        if (f < fMin || f > fMax) continue;
        const db = Math.max(yMin, Math.min(yMax, displayData[i] + calibrationDb(f) + weightDb(f, weighting.value)));
        const x = xForFreq(f), y = yForDb(db);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#93a4ba';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(`relativní dB · ${weightingLabel()}`, padL, 13);
  }

  function drawThirdOctaveBars(ctx, xForFreq, yForDb, binHz, fMin, fMax, yMin, displayData) {
    const factor = Math.pow(2, 1 / 6);
    THIRD_OCT.forEach(center => {
      if (center < fMin || center > fMax) return;
      const lo = center / factor, hi = center * factor;
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.min(displayData.length - 1, Math.ceil(hi / binHz));
      let p = 0;
      for (let i = i0; i <= i1; i++) {
        const f = i * binHz;
        const db = displayData[i] + calibrationDb(f) + weightDb(f, weighting.value);
        p += Math.pow(10, db / 10);
      }
      const bandDb = p > 0 ? 10 * Math.log10(p) : yMin;
      const x1 = xForFreq(lo), x2 = xForFreq(hi);
      const y = yForDb(Math.max(yMin, Math.min(0, bandDb)));
      const base = yForDb(yMin);
      ctx.fillStyle = '#38bdf8';
      ctx.globalAlpha = 0.78;
      ctx.fillRect(x1 + 1, y, Math.max(1, x2 - x1 - 2), base - y);
      ctx.globalAlpha = 1;
    });
  }

  function drawGrid(ctx, canvas, padL, padR, padT, padB, yMin, yMax) {
    const w = canvas.width - padL - padR, h = canvas.height - padT - padB;
    ctx.strokeStyle = '#26344b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#93a4ba';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    const step = (yMax - yMin) <= 80 ? 20 : 20;
    for (let db = yMin; db <= yMax; db += step) {
      const y = padT + h * (1 - (db - yMin) / (yMax - yMin));
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
      ctx.fillText(String(db), padL - 7, y + 4);
    }
  }

  function drawFreqLabels(ctx, xForFreq, baseline, fMin, fMax) {
    const ticks = [20,50,100,200,500,1000,2000,5000,10000,20000];
    ctx.fillStyle = '#93a4ba';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ticks.forEach(f => {
      if (f < fMin || f > fMax) return;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), xForFreq(f), baseline + 18);
    });
  }

  function drawHistory() {
    const c = historyCanvas, ctx = hctx;
    clearCanvas(ctx, c);
    const padL = 52, padR = 16, padT = 18, padB = 28;
    const w = c.width - padL - padR, h = c.height - padT - padB;
    const yMin = showSPL.checked ? 30 : -70;
    const yMax = showSPL.checked ? 110 : 0;
    drawGrid(ctx, c, padL, padR, padT, padB, yMin, yMax);
    if (history.length < 2) return;
    const oldest = historyTimes[0];
    const newest = historyTimes[historyTimes.length - 1];
    const span = Math.max(1000, newest - oldest);
    ctx.beginPath();
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 2;
    history.forEach((v, i) => {
      const x = padL + w * ((historyTimes[i] - oldest) / span);
      const y = padT + h * (1 - (v - yMin) / (yMax - yMin));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function nearestCalibrationFrequency(freq) {
    return CAL_FREQS.reduce((best, f) => Math.abs(Math.log(f / freq)) < Math.abs(Math.log(best / freq)) ? f : best, CAL_FREQS[0]);
  }

  function calibrateSpl() {
    if (!running || !Number.isFinite(lastRawDbfs)) {
      alert('Nejdřív spusť měření.');
      return;
    }
    const ref = Number(prompt('Kolik dB SPL ukazuje referenční hlukoměr?'));
    if (!Number.isFinite(ref)) return;
    const binHz = (audioCtx.sampleRate / 2) / freqData.length;
    const deltaWithoutOffset = spectralDeltaDb(weighting.value, binHz);
    offsetDB = ref - (lastRawDbfs + deltaWithoutOffset);
    offsetNum.value = offsetDB.toFixed(1);
    setSplCalibrationState('manual-reference');
    saveSettings();
    renderUnits();
    resetCurrentMeasurement();
  }

  function calibrateCurrentFrequency() {
    if (!running || !Number.isFinite(lastPeakHz) || !Number.isFinite(lastRawDbfs)) {
      alert('Nejdřív spusť měření a pusť čistý tón.');
      return;
    }
    const ref = Number(prompt(`${Math.round(lastPeakHz)} Hz – kolik ${unitLabel()} ukazuje referenční měřák?`));
    if (!Number.isFinite(ref)) return;
    const center = nearestCalibrationFrequency(lastPeakHz);
    const weightedBase = lastRawDbfs + offsetDB + weightDb(lastPeakHz, weighting.value);
    const correction = Math.max(-30, Math.min(30, ref - weightedBase));
    freqCalibration[center] = correction;
    saveSettings();
    renderCalibrationGrid();
    resetCurrentMeasurement();
  }

  function changeFftSize() {
    saveSettings();
    if (analyser) {
      analyser.fftSize = Number(fftSizeSelect.value);
      allocateBuffers();
    }
    updateResolutionNote();
  }

  function measurementSnapshot() {
    if (!sessionStartedAt || !(sessionDurationMs > 0)) return null;
    return {
      id: sessionId,
      startedAt: sessionStartedAt.toISOString(),
      endedAt: (sessionEndedAt || new Date()).toISOString(),
      durationSec: Number((sessionDurationMs / 1000).toFixed(2)),
      weighting: weightingLabel(),
      unit: unitLabel(),
      average: Number(currentMeasurementAverage().toFixed(2)),
      min: Number(minDB.toFixed(2)),
      max: Number(maxDB.toFixed(2)),
      offset: Number(offsetDB.toFixed(2)),
      calibrated: showSPL.checked ? isSplCalibrated() : null,
      samples: sessionSamples.map(s => ({ t: s.t, db: s.db }))
    };
  }

  function saveCurrentMeasurement() {
    addFinalSample();
    const snapshot = measurementSnapshot();
    if (!snapshot) return;
    const index = savedMeasurements.findIndex(m => m.id === snapshot.id);
    if (index >= 0) savedMeasurements[index] = snapshot;
    else savedMeasurements.unshift(snapshot);
    persistMeasurements();
    renderSavedMeasurements();
    setStatus(running ? 'měřím · uloženo' : 'uloženo');
    setTimeout(() => setStatus(running ? 'měřím' : 'zastaveno'), 1200);
  }

  function csvCell(value) {
    const s = String(value ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  }

  function numCs(value, digits = 2) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits).replace('.', ',') : '';
  }

  function exportToExcel() {
    let items = savedMeasurements;
    if (!items.length) {
      const current = measurementSnapshot();
      if (current) items = [current];
    }
    if (!items.length) {
      alert('Nejdřív ulož nebo proveď měření.');
      return;
    }

    const rows = [[
      'Měření','Datum','Začátek','Délka [s]','Vážení','Jednotka','Kalibrace SPL','Průměr [dB]','Minimum [dB]','Maximum [dB]','Čas od startu [s]','Hodnota [dB]'
    ]];

    items.slice().reverse().forEach((m, mi) => {
      const d = new Date(m.startedAt);
      const samples = Array.isArray(m.samples) && m.samples.length ? m.samples : [{t:'',db:''}];
      samples.forEach(s => {
        rows.push([
          mi + 1,
          d.toLocaleDateString('cs-CZ'),
          d.toLocaleTimeString('cs-CZ'),
          numCs(m.durationSec),
          m.weighting || '',
          m.unit || '',
          m.calibrated === true ? 'ano' : m.calibrated === false ? 'ne' : '',
          numCs(m.average),
          numCs(m.min),
          numCs(m.max),
          s.t === '' ? '' : numCs(s.t),
          s.db === '' ? '' : numCs(s.db)
        ]);
      });
    });

    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    a.href = url;
    a.download = `hlukomer-${now.toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.panel).classList.add('active');
    });
  });

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  resetBtn.addEventListener('click', resetCurrentMeasurement);
  saveMeasurementBtn.addEventListener('click', saveCurrentMeasurement);
  exportExcelBtn.addEventListener('click', exportToExcel);

  showSPL.addEventListener('change', () => { saveSettings(); renderUnits(); resetCurrentMeasurement(); });
  holdPeak.addEventListener('change', saveSettings);
  weighting.addEventListener('change', () => { saveSettings(); renderUnits(); resetCurrentMeasurement(); });
  displayResponse.addEventListener('change', () => {
    saveSettings();
    smoothedPower = NaN;
    lastSmoothAt = 0;
  });

  offsetNum.addEventListener('change', () => {
    const n = Number(offsetNum.value);
    if (!Number.isFinite(n)) return;
    offsetDB = Math.max(-40, n);
    offsetNum.value = offsetDB.toFixed(1);
    setSplCalibrationState('manual-offset');
    saveSettings();
    resetCurrentMeasurement();
  });

  calibrateBtn.addEventListener('click', calibrateSpl);
  freqCalBtn.addEventListener('click', calibrateCurrentFrequency);
  zeroCalBtn.addEventListener('click', () => {
    if (!confirm('Vynulovat všechny frekvenční korekce?')) return;
    freqCalibration = Object.fromEntries(CAL_FREQS.map(f => [f, 0]));
    saveSettings();
    renderCalibrationGrid();
    resetCurrentMeasurement();
  });

  fftSizeSelect.addEventListener('change', changeFftSize);
  spectrumMode.addEventListener('change', saveSettings);
  freqScale.addEventListener('change', saveSettings);

  renderCalibrationGrid();
  renderUnits();
  renderSavedMeasurements();
  updateResolutionNote();
  drawEmptyCharts();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const registration = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
        await registration.update();
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        console.error(error);
      }
    });
  }
})();