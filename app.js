/* Hlukoměr PWA – spektrum, A/C/Z vážení a frekvenční kalibrace. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function ensureExtendedControls() {
    const aside = document.querySelector('aside.card');
    if (aside && !document.getElementById('weighting')) {
      const row = document.createElement('div');
      row.className = 'sideRow';
      const label = document.createElement('label');
      label.textContent = 'Frekvenční vážení';
      const select = document.createElement('select');
      select.id = 'weighting';
      select.style.width = '100%';
      [['A','A – vnímání lidského sluchu'],['C','C – hlasité a nízké zvuky'],['Z','Z – bez frekvenčního vážení']].forEach(([value,text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
      });
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'A potlačuje hlavně nízké frekvence, C méně a Z je bez vážení.';
      row.append(label, select, note);
      const heading = aside.querySelector('h2');
      heading?.insertAdjacentElement('afterend', row);
    }
    if (!document.getElementById('freqCalBtn')) {
      const grid = document.getElementById('calGrid');
      if (grid) {
        const btn = document.createElement('button');
        btn.id = 'freqCalBtn';
        btn.textContent = 'Kalibrovat aktuální tón';
        btn.style.marginBottom = '8px';
        grid.insertAdjacentElement('beforebegin', btn);
      }
    }
    const mode = document.getElementById('spectrumMode');
    if (mode?.options?.length >= 2) {
      mode.options[0].textContent = 'Graf FFT';
      mode.options[1].textContent = 'Sloupce 1/3 oktávy';
    }
  }
  ensureExtendedControls();

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const resetBtn = $('resetBtn');
  const dbOut = $('dbOut');
  const unitOut = $('unitOut');
  const subOut = $('subOut');
  const statusPill = $('statusPill');
  const instOut = $('instOut');
  const maxOut = $('maxOut');
  const minOut = $('minOut');
  const avgOut = $('avgOut');
  const bar = $('bar');
  const permWarn = $('permWarn');
  const showSPL = $('showSPL');
  const holdPeak = $('holdPeak');
  const weighting = $('weighting');
  const offsetNum = $('offsetNum');
  const calibrateBtn = $('calibrateBtn');
  const freqCalBtn = $('freqCalBtn');
  const zeroCalBtn = $('zeroCalBtn');
  const fftSizeSelect = $('fftSize');
  const resolutionNote = $('resolutionNote');
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
    freqCal: 'hlukomer.freqCalibration.v2'
  };

  const CAL_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const THIRD_OCT = [25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];

  let offsetDB = loadNumber(LS.offset, 40);
  let freqCalibration = loadCalibration();
  let audioCtx = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let timeData = null;
  let freqData = null;
  let running = false;
  let raf = 0;
  let frameCounter = 0;
  let lastRawDbfs = NaN;
  let lastPeakHz = NaN;
  let minDB = Infinity;
  let maxDB = -Infinity;
  const history = [];
  const historyTimes = [];
  const HISTORY_MS = 30000;

  function loadNumber(key, fallback) {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? n : fallback;
  }

  function loadCalibration() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS.freqCal) || '{}');
      const out = {};
      CAL_FREQS.forEach(f => {
        const n = Number(parsed[f]);
        out[f] = Number.isFinite(n) ? n : 0;
      });
      return out;
    } catch (_) {
      return Object.fromEntries(CAL_FREQS.map(f => [f, 0]));
    }
  }

  function saveSettings() {
    localStorage.setItem(LS.offset, String(offsetDB));
    localStorage.setItem(LS.spl, showSPL.checked ? '1' : '0');
    localStorage.setItem(LS.hold, holdPeak.checked ? '1' : '0');
    localStorage.setItem(LS.weighting, weighting.value);
    localStorage.setItem(LS.fft, fftSizeSelect.value);
    localStorage.setItem(LS.mode, spectrumMode.value);
    localStorage.setItem(LS.scale, freqScale.value);
    localStorage.setItem(LS.freqCal, JSON.stringify(freqCalibration));
  }

  showSPL.checked = (localStorage.getItem(LS.spl) ?? '1') === '1';
  holdPeak.checked = (localStorage.getItem(LS.hold) ?? '0') === '1';
  weighting.value = localStorage.getItem(LS.weighting) || 'A';
  fftSizeSelect.value = localStorage.getItem(LS.fft) || '4096';
  spectrumMode.value = localStorage.getItem(LS.mode) || 'line';
  freqScale.value = localStorage.getItem(LS.scale) || 'log';
  offsetNum.value = offsetDB.toFixed(1);

  function weightingLabel() {
    return weighting.value === 'A' ? 'A' : weighting.value === 'C' ? 'C' : 'Z';
  }

  function renderUnits() {
    const w = weightingLabel();
    unitOut.textContent = showSPL.checked ? `dB${w}` : `dBFS (${w})`;
    subOut.textContent = showSPL.checked ? `${w}-vážení · kalibrované pomocí uloženého offsetu` : `${w}-vážení · relativní úroveň bez SPL offsetu`;
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
      const suffix = document.createElement('span');
      suffix.className = 'calunit';
      suffix.textContent = ' dB';
      box.append(label, input, suffix);
      calGrid.appendChild(box);
    });
  }

  function formatFreq(freq) {
    if (freq >= 1000) {
      const k = freq / 1000;
      return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)} kHz`;
    }
    return `${freq} Hz`;
  }

  function setStatus(text) {
    statusPill.textContent = text;
  }

  function fmt(v) {
    return Number.isFinite(v) ? v.toFixed(1) : '--';
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
    const ra = num / den;
    return 20 * Math.log10(Math.max(ra, 1e-20)) + 2.0;
  }

  function calibrationDb(freq) {
    if (!(freq > 0)) return 0;
    if (freq <= CAL_FREQS[0]) return freqCalibration[CAL_FREQS[0]] || 0;
    if (freq >= CAL_FREQS[CAL_FREQS.length - 1]) return freqCalibration[CAL_FREQS[CAL_FREQS.length - 1]] || 0;
    const lf = Math.log(freq);
    for (let i = 0; i < CAL_FREQS.length - 1; i++) {
      const f1 = CAL_FREQS[i], f2 = CAL_FREQS[i + 1];
      if (freq >= f1 && freq <= f2) {
        const t = (lf - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
        const c1 = freqCalibration[f1] || 0;
        const c2 = freqCalibration[f2] || 0;
        return c1 + (c2 - c1) * t;
      }
    }
    return 0;
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
    const nyquist = audioCtx.sampleRate / 2;
    const binHz = nyquist / freqData.length;
    return { binHz, nyquist };
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

  function averageRecent(sec) {
    const cutoff = performance.now() - sec * 1000;
    let sum = 0, n = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (historyTimes[i] < cutoff) break;
      sum += history[i];
      n++;
    }
    return n ? sum / n : NaN;
  }

  function updateResolutionNote() {
    const fft = Number(fftSizeSelect.value);
    if (!audioCtx) {
      resolutionNote.textContent = `Vyšší FFT = jemnější rozlišení frekvence. Aktuálně ${fft} vzorků.`;
      return;
    }
    const hz = audioCtx.sampleRate / fft;
    resolutionNote.textContent = `Rozlišení ≈ ${hz.toFixed(1)} Hz · vzorkování ${Math.round(audioCtx.sampleRate)} Hz`;
  }

  function updatePeak(binHz) {
    let bestDb = -Infinity;
    let bestHz = NaN;
    const maxHz = Math.min(20000, audioCtx.sampleRate / 2);
    for (let i = 1; i < freqData.length; i++) {
      const freq = i * binHz;
      if (freq < 20 || freq > maxHz) continue;
      const corrected = freqData[i] + calibrationDb(freq) + weightDb(freq, weighting.value);
      if (corrected > bestDb) {
        bestDb = corrected;
        bestHz = freq;
      }
    }
    lastPeakHz = bestHz;
    peakFreq.textContent = Number.isFinite(bestHz) ? Math.round(bestHz) : '--';
    peakNote.textContent = Number.isFinite(bestHz) ? `maximum spektra po ${weightingLabel()}-vážení` : '—';
  }

  function mapMeter(db) {
    const min = showSPL.checked ? 30 : -70;
    const max = showSPL.checked ? 110 : 0;
    return Math.max(0, Math.min(100, ((db - min) / (max - min)) * 100));
  }

  async function start() {
    if (running) return;
    permWarn.style.display = 'none';
    setStatus('žádám o mikrofon…');
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
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = Number(fftSizeSelect.value);
    analyser.smoothingTimeConstant = 0.55;
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    source.connect(analyser);
    allocateBuffers();

    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    resetStats();
    setStatus('měřím');
    updateResolutionNote();
    loop();
  }

  function allocateBuffers() {
    timeData = new Float32Array(analyser.fftSize);
    freqData = new Float32Array(analyser.frequencyBinCount);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    try { source?.disconnect(); } catch (_) {}
    try { analyser?.disconnect(); } catch (_) {}
    stream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
    stream = source = analyser = audioCtx = null;
    timeData = freqData = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('zastaveno');
    subOut.textContent = 'Měření zastaveno.';
  }

  function resetStats() {
    minDB = Infinity;
    maxDB = -Infinity;
    history.length = 0;
    historyTimes.length = 0;
    maxOut.textContent = minOut.textContent = avgOut.textContent = '--';
  }

  function loop() {
    if (!running) return;
    lastRawDbfs = computeRawRmsDbfs();
    const { binHz } = getSpectrum();
    const delta = spectralDeltaDb(weighting.value, binHz);
    const disp = displayedDb(lastRawDbfs, delta);

    minDB = Math.min(minDB, disp);
    maxDB = Math.max(maxDB, disp);
    const now = performance.now();
    history.push(disp);
    historyTimes.push(now);
    while (historyTimes.length && historyTimes[0] < now - HISTORY_MS) {
      historyTimes.shift();
      history.shift();
    }

    const hero = holdPeak.checked ? maxDB : disp;
    dbOut.textContent = fmt(hero);
    instOut.textContent = fmt(disp);
    maxOut.textContent = fmt(maxDB);
    minOut.textContent = fmt(minDB);
    avgOut.textContent = fmt(averageRecent(5));
    bar.style.width = `${mapMeter(hero).toFixed(1)}%`;

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

  function drawSpectrum(binHz) {
    const c = spectrumCanvas, ctx = sctx;
    clearCanvas(ctx, c);
    const padL = 52, padR = 16, padT = 18, padB = 34;
    const w = c.width - padL - padR, h = c.height - padT - padB;
    const fMin = 20;
    const fMax = Math.min(20000, audioCtx.sampleRate / 2);
    const yMin = -100, yMax = 0;

    drawGrid(ctx, c, padL, padR, padT, padB, yMin, yMax);

    const xForFreq = (f) => {
      if (freqScale.value === 'linear') return padL + w * ((f - fMin) / (fMax - fMin));
      return padL + w * ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin)));
    };
    const yForDb = (db) => padT + h * (1 - (db - yMin) / (yMax - yMin));

    drawFreqLabels(ctx, xForFreq, padT + h, fMin, fMax);

    if (spectrumMode.value === 'bars') {
      drawThirdOctaveBars(ctx, xForFreq, yForDb, binHz, fMin, fMax, yMin);
    } else {
      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      let started = false;
      const step = Math.max(1, Math.floor(freqData.length / 1400));
      for (let i = 1; i < freqData.length; i += step) {
        const f = i * binHz;
        if (f < fMin || f > fMax) continue;
        const db = Math.max(yMin, Math.min(yMax, freqData[i] + calibrationDb(f) + weightDb(f, weighting.value)));
        const x = xForFreq(f), y = yForDb(db);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#93a4ba';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(`relativní dB · ${weightingLabel()}-vážení`, padL, 13);
  }

  function drawThirdOctaveBars(ctx, xForFreq, yForDb, binHz, fMin, fMax, yMin) {
    const factor = Math.pow(2, 1 / 6);
    THIRD_OCT.forEach(center => {
      if (center < fMin || center > fMax) return;
      const lo = center / factor, hi = center * factor;
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.min(freqData.length - 1, Math.ceil(hi / binHz));
      let p = 0;
      for (let i = i0; i <= i1; i++) {
        const f = i * binHz;
        const db = freqData[i] + calibrationDb(f) + weightDb(f, weighting.value);
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
    for (let db = yMin; db <= yMax; db += 20) {
      const y = padT + h * (1 - (db - yMin) / (yMax - yMin));
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
      ctx.fillText(String(db), padL - 7, y + 4);
    }
  }

  function drawFreqLabels(ctx, xForFreq, baseline, fMin, fMax) {
    const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    ctx.fillStyle = '#93a4ba';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ticks.forEach(f => {
      if (f < fMin || f > fMax) return;
      const x = xForFreq(f);
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, baseline + 18);
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
    ctx.fillStyle = '#93a4ba';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('posledních 30 s', padL, c.height - 7);
  }

  function nearestCalibrationFrequency(freq) {
    return CAL_FREQS.reduce((best, f) => Math.abs(Math.log(f / freq)) < Math.abs(Math.log(best / freq)) ? f : best, CAL_FREQS[0]);
  }

  function calibrateSpl() {
    if (!running || !Number.isFinite(lastRawDbfs)) {
      alert('Nejdřív spusť měření.');
      return;
    }
    const ref = Number(prompt('Kolik dB SPL ukazuje referenční hlukoměr právě teď?'));
    if (!Number.isFinite(ref)) return;
    const binHz = (audioCtx.sampleRate / 2) / freqData.length;
    const deltaWithoutOffset = spectralDeltaDb(weighting.value, binHz);
    offsetDB = ref - (lastRawDbfs + deltaWithoutOffset);
    offsetNum.value = offsetDB.toFixed(1);
    saveSettings();
    renderUnits();
  }

  function calibrateCurrentFrequency() {
    if (!running || !Number.isFinite(lastPeakHz) || !Number.isFinite(lastRawDbfs)) {
      alert('Nejdřív spusť měření a pusť čistý tón.');
      return;
    }
    const ref = Number(prompt(`Detekováno přibližně ${Math.round(lastPeakHz)} Hz. Kolik dB SPL má referenční tón?`));
    if (!Number.isFinite(ref)) return;
    const center = nearestCalibrationFrequency(lastPeakHz);
    const correction = Math.max(-30, Math.min(30, ref - (lastRawDbfs + offsetDB)));
    freqCalibration[center] = correction;
    saveSettings();
    renderCalibrationGrid();
    alert(`Uložena korekce ${correction.toFixed(1)} dB pro pásmo ${formatFreq(center)}.`);
  }

  function changeFftSize() {
    saveSettings();
    if (analyser) {
      analyser.fftSize = Number(fftSizeSelect.value);
      allocateBuffers();
    }
    updateResolutionNote();
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
  resetBtn.addEventListener('click', resetStats);
  showSPL.addEventListener('change', () => { saveSettings(); renderUnits(); resetStats(); });
  holdPeak.addEventListener('change', saveSettings);
  weighting.addEventListener('change', () => { saveSettings(); renderUnits(); resetStats(); });
  offsetNum.addEventListener('change', () => {
    const n = Number(offsetNum.value);
    if (!Number.isFinite(n)) return;
    offsetDB = Math.max(-40, Math.min(100, n));
    offsetNum.value = offsetDB.toFixed(1);
    saveSettings();
  });
  calibrateBtn.addEventListener('click', calibrateSpl);
  freqCalBtn.addEventListener('click', calibrateCurrentFrequency);
  zeroCalBtn.addEventListener('click', () => {
    if (!confirm('Vynulovat všechny frekvenční korekce?')) return;
    freqCalibration = Object.fromEntries(CAL_FREQS.map(f => [f, 0]));
    saveSettings();
    renderCalibrationGrid();
  });
  fftSizeSelect.addEventListener('change', changeFftSize);
  spectrumMode.addEventListener('change', saveSettings);
  freqScale.addEventListener('change', saveSettings);

  renderCalibrationGrid();
  renderUnits();
  updateResolutionNote();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
  }
})();
