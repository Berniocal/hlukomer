/* Měření referenčního reproduktoru pomocí kalibrovaného Dayton iMM-6 / iMM-6C. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const MATH = window.HLUKOMER_MATH;
  if (!MATH) return;

  const STORAGE_LAST = 'hlukomer.referenceSpeaker.last.v1';
  const STORAGE_LIST = 'hlukomer.referenceSpeaker.profiles.v1';
  const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const TYPES = ['A', 'C', 'Z'];

  const fallbackTrack = {
    id: 'bernio-calibration-track-v2',
    version: 2,
    durationSec: 215,
    chirpTimesSec: [5, 8, 11],
    backgroundBefore: [20, 45],
    linearityLow: [50, 65],
    linearityHigh: [70, 85],
    linearityExpectedDifferenceDb: 10,
    pink: [90, 150],
    backgroundAfter: [150, 180],
    white: [180, 210]
  };

  const state = {
    running: false,
    aborting: false,
    stream: null,
    context: null,
    worklet: null,
    processor: null,
    silentGain: null,
    timer: null,
    startedPerf: 0,
    syncT0Perf: null,
    detections: [],
    baselineDb: [],
    lastDetectionPerf: -Infinity,
    segments: null,
    clippedSamples: 0,
    totalSamples: 0,
    lastProfile: loadLastProfile(),
    speakerName: 'T&G TG-113A',
    speakerUnit: ''
  };

  function track() {
    return window.HLUKOMER_CALIBRATION_TRACK || fallbackTrack;
  }

  function loadLastProfile() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_LAST) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function saveProfile(profile) {
    state.lastProfile = profile;
    localStorage.setItem(STORAGE_LAST, JSON.stringify(profile));
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_LIST) || '[]');
      const arr = Array.isArray(list) ? list : [];
      arr.unshift(profile);
      localStorage.setItem(STORAGE_LIST, JSON.stringify(arr.slice(0, 10)));
    } catch (_) {}
    renderLastResult();
  }

  function emptyEnergy() {
    return {
      duration: 0,
      energy: { A: 0, C: 0, Z: 0 },
      octaveEnergyA: Object.fromEntries(OCTAVES.map(f => [f, 0])),
      octaveEnergyZ: Object.fromEntries(OCTAVES.map(f => [f, 0])),
      coverage: Object.fromEntries(OCTAVES.map(f => [f, null]))
    };
  }

  function resetSegments() {
    state.segments = {
      backgroundBefore: emptyEnergy(),
      linearityLow: emptyEnergy(),
      linearityHigh: emptyEnergy(),
      pink: emptyEnergy(),
      backgroundAfter: emptyEnergy(),
      white: emptyEnergy()
    };
    state.clippedSamples = 0;
    state.totalSamples = 0;
  }

  function segmentForTime(sec) {
    const t = track();
    const ranges = [
      ['backgroundBefore', t.backgroundBefore],
      ['linearityLow', t.linearityLow],
      ['linearityHigh', t.linearityHigh],
      ['pink', t.pink],
      ['backgroundAfter', t.backgroundAfter],
      ['white', t.white]
    ];
    for (const [name, range] of ranges) {
      if (Array.isArray(range) && sec >= range[0] && sec < range[1]) return name;
    }
    return null;
  }

  function addBlockToSegment(name, block, dt) {
    const seg = state.segments?.[name];
    if (!seg || !block || !(dt > 0)) return;
    seg.duration += dt;
    TYPES.forEach(type => {
      const power = Number(block.powers?.[type]);
      if (power > 0) seg.energy[type] += power * dt;
    });
    OCTAVES.forEach(center => {
      if (typeof block.coverage?.[center] === 'boolean') seg.coverage[center] = block.coverage[center];
      if (block.coverage?.[center] === false) return;
      const a = Number(block.octavePowersA?.[center]);
      const z = Number(block.octavePowersZ?.[center]);
      if (a > 0) seg.octaveEnergyA[center] += a * dt;
      if (z > 0) seg.octaveEnergyZ[center] += z * dt;
    });
  }

  function median(values) {
    const arr = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!arr.length) return NaN;
    const i = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[i] : (arr[i - 1] + arr[i]) / 2;
  }

  function rawDbfs(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return MATH.powerToDb(sum / Math.max(1, samples.length));
  }

  function processSync(samples, nowPerf) {
    const elapsed = (nowPerf - state.startedPerf) / 1000;
    const db = rawDbfs(samples);

    if (elapsed < 2.5) {
      if (Number.isFinite(db)) state.baselineDb.push(db);
      return;
    }

    const baseline = median(state.baselineDb);
    if (!Number.isFinite(baseline)) return;
    const threshold = Math.max(baseline + 12, -48);
    if (!(db >= threshold)) return;
    if (nowPerf - state.lastDetectionPerf < 1600) return;

    state.lastDetectionPerf = nowPerf;
    state.detections.push(nowPerf);
    state.detections = state.detections.slice(-6);

    if (state.detections.length >= 3) {
      for (let i = Math.max(0, state.detections.length - 4); i <= state.detections.length - 3; i += 1) {
        const a = state.detections[i];
        const b = state.detections[i + 1];
        const c = state.detections[i + 2];
        const d1 = (b - a) / 1000;
        const d2 = (c - b) / 1000;
        if (d1 >= 2.2 && d1 <= 3.8 && d2 >= 2.2 && d2 <= 3.8) {
          const chirps = track().chirpTimesSec || [5, 8, 11];
          state.syncT0Perf = median([
            a - chirps[0] * 1000,
            b - chirps[1] * 1000,
            c - chirps[2] * 1000
          ]);
          setStatus('good', '✓ Synchronizováno. Teď už na telefon ani reproduktor nesahejte.');
          return;
        }
      }
    }

    setStatus('ready', `Rozpoznáno značek: ${Math.min(3, state.detections.length)} / 3`);
  }

  function processChunk(samples, sampleRate) {
    if (!state.running || !(samples instanceof Float32Array) || !(sampleRate > 0)) return;

    const nowPerf = performance.now();
    for (let i = 0; i < samples.length; i += 1) {
      const ax = Math.abs(samples[i]);
      state.totalSamples += 1;
      if (ax >= 0.995) state.clippedSamples += 1;
    }

    if (state.syncT0Perf === null) {
      processSync(samples, nowPerf);
      return;
    }

    const calibration = window.HLUKOMER_DAYTON?.getActiveCalibration?.();
    if (!calibration?.centers?.length || !calibration?.values) return;

    const block = MATH.analyzeTimeBlock(samples, sampleRate, {
      centers: OCTAVES,
      calibration: calibration.values,
      calibrationCenters: calibration.centers,
      analysisMaxHz: 20000,
      offsetDb: 0
    });
    if (!block) return;

    const dt = samples.length / sampleRate;
    const trackSec = (nowPerf - state.syncT0Perf) / 1000 - dt / 2;
    const segment = segmentForTime(trackSec);
    if (segment) addBlockToSegment(segment, block, dt);

    updateLiveProgress(trackSec);

    const stopAt = (track().white?.[1] || track().durationSec || 210) + 0.8;
    if (trackSec >= stopAt) finishMeasurement(false);
  }

  function dbFromEnergy(energy, duration) {
    return energy > 0 && duration > 0 ? MATH.powerToDb(energy / duration) : null;
  }

  function segmentResult(seg) {
    if (!seg || !(seg.duration > 0)) return null;
    const leq = {};
    TYPES.forEach(type => {
      const value = dbFromEnergy(seg.energy[type], seg.duration);
      leq[type] = Number.isFinite(value) ? Number(value.toFixed(2)) : null;
    });

    const octavesA = {};
    const octavesZ = {};
    OCTAVES.forEach(center => {
      if (seg.coverage[center] === false) {
        octavesA[center] = null;
        octavesZ[center] = null;
        return;
      }
      const a = dbFromEnergy(seg.octaveEnergyA[center], seg.duration);
      const z = dbFromEnergy(seg.octaveEnergyZ[center], seg.duration);
      octavesA[center] = Number.isFinite(a) ? Number(a.toFixed(2)) : null;
      octavesZ[center] = Number.isFinite(z) ? Number(z.toFixed(2)) : null;
    });

    return {
      durationSec: Number(seg.duration.toFixed(2)),
      leq,
      octavesA,
      octavesZ,
      powers: {
        A: seg.energy.A / seg.duration,
        C: seg.energy.C / seg.duration,
        Z: seg.energy.Z / seg.duration
      },
      octavePowersZ: Object.fromEntries(OCTAVES.map(center => [
        center,
        seg.octaveEnergyZ[center] / seg.duration
      ]))
    };
  }

  function sourceDb(totalPower, backgroundPower) {
    const source = MATH.sourcePowerFromTotalAndBackground(totalPower, backgroundPower);
    const db = MATH.powerToDb(source);
    return Number.isFinite(db) ? Number(db.toFixed(2)) : null;
  }

  function buildProfile() {
    const calibration = window.HLUKOMER_DAYTON?.getActiveCalibration?.();
    const device = window.HLUKOMER_DAYTON?.getSelectedDevice?.() || {};
    const results = Object.fromEntries(
      Object.entries(state.segments || {}).map(([name, seg]) => [name, segmentResult(seg)])
    );

    const before = results.backgroundBefore;
    const after = results.backgroundAfter;
    const pink = results.pink;
    const white = results.white;
    const low = results.linearityLow;
    const high = results.linearityHigh;

    const backgroundPower = {};
    const pinkSource = {};
    const whiteSource = {};
    TYPES.forEach(type => {
      const bg = MATH.worstBackgroundPower(before?.powers?.[type] || 0, after?.powers?.[type] || 0);
      backgroundPower[type] = bg;
      pinkSource[type] = sourceDb(pink?.powers?.[type] || 0, bg);
      whiteSource[type] = sourceDb(white?.powers?.[type] || 0, bg);
    });

    const pinkOctavesZ = {};
    const whiteOctavesZ = {};
    const snrPinkZ = {};
    OCTAVES.forEach(center => {
      const bg = MATH.worstBackgroundPower(
        before?.octavePowersZ?.[center] || 0,
        after?.octavePowersZ?.[center] || 0
      );
      pinkOctavesZ[center] = sourceDb(pink?.octavePowersZ?.[center] || 0, bg);
      whiteOctavesZ[center] = sourceDb(white?.octavePowersZ?.[center] || 0, bg);
      const snr = MATH.signalToNoiseSnr(pink?.octavePowersZ?.[center] || 0, bg);
      snrPinkZ[center] = Number.isFinite(snr) ? Number(snr.toFixed(2)) : null;
    });

    let linearityMeasuredDb = null;
    if (low?.powers?.Z > 0 && high?.powers?.Z > 0) {
      const bg = backgroundPower.Z || 0;
      const lowSource = MATH.sourcePowerFromTotalAndBackground(low.powers.Z, bg);
      const highSource = MATH.sourcePowerFromTotalAndBackground(high.powers.Z, bg);
      const diff = lowSource > 0 && highSource > 0 ? MATH.powerToDb(highSource / lowSource) : NaN;
      if (Number.isFinite(diff)) linearityMeasuredDb = Number(diff.toFixed(2));
    }

    const clippingFraction = state.totalSamples > 0 ? state.clippedSamples / state.totalSamples : 0;
    const t = track();

    return {
      format: 'bernio-reference-speaker-profile',
      version: 1,
      createdAt: new Date().toISOString(),
      speaker: {
        name: state.speakerName.trim() || 'Referenční reproduktor',
        unitId: state.speakerUnit.trim() || null,
        distanceM: 1.5,
        geometry: 'reproduktor a mikrofon ve stejné výšce, proti sobě'
      },
      track: {
        id: t.id,
        version: t.version,
        timing: {
          chirpTimesSec: t.chirpTimesSec,
          backgroundBefore: t.backgroundBefore,
          linearityLow: t.linearityLow,
          linearityHigh: t.linearityHigh,
          pink: t.pink,
          backgroundAfter: t.backgroundAfter,
          white: t.white
        }
      },
      microphone: {
        type: 'Dayton iMM-6 / iMM-6C',
        serial: calibration?.serial || null,
        fileName: calibration?.fileName || null,
        sensitivity1000HzDb: calibration?.sensitivity1000HzDb ?? null,
        deviceLabel: device.label || null,
        frequencyCalibrationApplied: true,
        absoluteSplVerified: false
      },
      measurement: {
        unit: 'corrected dBFS',
        absoluteSplVerified: false,
        note: 'Frekvenční charakteristika je opravena individuálním souborem Dayton. Absolutní SPL zatím není ověřeno.',
        clippingFraction: Number(clippingFraction.toFixed(8)),
        syncMethod: 'three-chirp-timing-v1'
      },
      results: {
        rawSegments: results,
        sourceAfterBackgroundCorrection: {
          pinkLeq: pinkSource,
          whiteLeq: whiteSource,
          pinkOctavesZ,
          whiteOctavesZ,
          pinkSnrOctavesZ: snrPinkZ
        },
        linearity: {
          expectedDifferenceDb: Number(t.linearityExpectedDifferenceDb || 10),
          measuredDifferenceDb: linearityMeasuredDb,
          errorDb: Number.isFinite(linearityMeasuredDb)
            ? Number((linearityMeasuredDb - Number(t.linearityExpectedDifferenceDb || 10)).toFixed(2))
            : null
        }
      }
    };
  }

  function formatDb(value) {
    return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} dB` : '—';
  }

  function speakerProfileSummary(profile) {
    const source = profile?.results?.sourceAfterBackgroundCorrection;
    const linearity = profile?.results?.linearity;
    const pink = source?.pinkLeq || {};
    return `
      <div class="refSpResultGrid">
        <div><span>Růžový šum · Z</span><strong>${formatDb(pink.Z)}</strong></div>
        <div><span>Růžový šum · A</span><strong>${formatDb(pink.A)}</strong></div>
        <div><span>Linearita</span><strong>${Number.isFinite(linearity?.measuredDifferenceDb) ? linearity.measuredDifferenceDb.toFixed(1) + ' dB' : '—'}</strong></div>
        <div><span>Absolutní SPL</span><strong>zatím neověřeno</strong></div>
      </div>`;
  }

  function setStatus(level, text) {
    const el = $('refSpeakerStatus');
    if (!el) return;
    el.className = `refSpeakerStatus ${level || ''}`;
    el.textContent = text || '';
  }

  function phaseName(sec) {
    if (!Number.isFinite(sec) || sec < 0) return 'Čekám na začátek nahrávky';
    const t = track();
    if (sec < (t.backgroundBefore?.[0] || 20)) return 'Úvod a chirpy';
    if (sec < (t.backgroundBefore?.[1] || 45)) return 'Hluk pozadí před';
    if (sec < (t.linearityLow?.[1] || 65)) return 'Linearita · slabší šum';
    if (sec < (t.linearityHigh?.[1] || 85)) return 'Linearita · hlasitější šum';
    if (sec < (t.pink?.[1] || 150)) return 'Růžový šum';
    if (sec < (t.backgroundAfter?.[1] || 180)) return 'Hluk pozadí po';
    if (sec < (t.white?.[1] || 210)) return 'Bílý šum';
    return 'Dokončuji';
  }

  function updateLiveProgress(trackSec) {
    const t = track();
    const max = t.white?.[1] || t.durationSec || 210;
    const clamped = Math.max(0, Math.min(max, trackSec));
    const bar = $('refSpeakerProgressBar');
    const time = $('refSpeakerTime');
    const phase = $('refSpeakerPhase');
    if (bar) bar.style.width = `${(clamped / max * 100).toFixed(1)}%`;
    if (time) time.textContent = `${Math.floor(clamped / 60)}:${String(Math.floor(clamped % 60)).padStart(2, '0')} / ${Math.floor(max / 60)}:${String(Math.floor(max % 60)).padStart(2, '0')}`;
    if (phase) phase.textContent = phaseName(trackSec);
  }

  async function startMeasurement() {
    if (state.running) return;
    const dayton = window.HLUKOMER_DAYTON;
    if (!dayton?.isActive?.()) {
      alert('Nejdřív zapněte Dayton a načtěte jeho kalibrační soubor.');
      return;
    }
    const validation = dayton.validateBeforeStart?.();
    if (validation && validation.ok === false) {
      alert(validation.message || 'Vyberte USB mikrofon Dayton.');
      return;
    }
    const speakerName = $('refSpeakerName')?.value?.trim() || 'T&G TG-113A';
    const speakerUnit = $('refSpeakerUnit')?.value?.trim() || '';
    state.speakerName = speakerName;
    state.speakerUnit = speakerUnit;

    resetSegments();
    state.running = true;
    state.aborting = false;
    state.syncT0Perf = null;
    state.detections = [];
    state.baselineDb = [];
    state.lastDetectionPerf = -Infinity;
    state.startedPerf = performance.now();
    window.HLUKOMER_REFERENCE_SPEAKER_RUNNING = true;
    renderRunning(true);
    setStatus('ready', 'Čekám na tři úvodní chirpy. Teď spusťte kalibrační nahrávku na reproduktoru.');
    updateLiveProgress(-1);

    try {
      const constraints = dayton.getAudioConstraints?.();
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      const trackObj = state.stream.getAudioTracks?.()[0];
      const verification = dayton.reportActiveTrack?.(trackObj);
      if (verification && verification.ok === false) throw new Error(verification.message || 'Je aktivní jiný mikrofon.');

      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.context = new Ctx();
      await state.context.resume();
      const source = state.context.createMediaStreamSource(state.stream);
      state.silentGain = state.context.createGain();
      state.silentGain.gain.value = 0;

      if (state.context.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          await state.context.audioWorklet.addModule('measurement-worklet.js?v=32');
          state.worklet = new AudioWorkletNode(state.context, 'hlukomer-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          state.worklet.port.onmessage = event => {
            const data = event.data;
            if (data?.type === 'block' && data.samples instanceof Float32Array) {
              processChunk(data.samples, Number(data.sampleRate) || state.context.sampleRate);
            }
          };
          source.connect(state.worklet);
          state.worklet.connect(state.silentGain);
        } catch (_) {
          state.worklet = null;
        }
      }

      if (!state.worklet) {
        state.processor = state.context.createScriptProcessor(2048, 1, 1);
        state.processor.onaudioprocess = event => {
          const input = event.inputBuffer.getChannelData(0);
          processChunk(new Float32Array(input), state.context.sampleRate);
        };
        source.connect(state.processor);
        state.processor.connect(state.silentGain);
      }

      state.silentGain.connect(state.context.destination);
      state.timer = setTimeout(() => {
        if (state.running && state.syncT0Perf === null) {
          failMeasurement('Úvodní chirpy se nepodařilo rozpoznat. Spusťte měření znovu a potom pusťte kalibrační soubor od začátku.');
        }
      }, 32000);
    } catch (error) {
      await cleanupCapture();
      state.running = false;
      window.HLUKOMER_REFERENCE_SPEAKER_RUNNING = false;
      renderRunning(false);
      setStatus('bad', error?.message || 'Měření se nepodařilo spustit.');
    }
  }

  async function cleanupCapture() {
    clearTimeout(state.timer);
    state.timer = null;
    if (state.worklet) state.worklet.port.onmessage = null;
    if (state.processor) state.processor.onaudioprocess = null;
    try { state.worklet?.disconnect(); } catch (_) {}
    try { state.processor?.disconnect(); } catch (_) {}
    try { state.silentGain?.disconnect(); } catch (_) {}
    state.stream?.getTracks?.().forEach(trackObj => trackObj.stop());
    if (state.context && state.context.state !== 'closed') {
      try { await state.context.close(); } catch (_) {}
    }
    state.stream = null;
    state.context = null;
    state.worklet = null;
    state.processor = null;
    state.silentGain = null;
    window.HLUKOMER_DAYTON?.clearActiveTrack?.();
  }

  async function failMeasurement(message) {
    if (!state.running) return;
    state.running = false;
    window.HLUKOMER_REFERENCE_SPEAKER_RUNNING = false;
    await cleanupCapture();
    renderRunning(false);
    setStatus('bad', message);
  }

  async function stopMeasurement() {
    if (!state.running) return;
    state.aborting = true;
    state.running = false;
    window.HLUKOMER_REFERENCE_SPEAKER_RUNNING = false;
    await cleanupCapture();
    renderRunning(false);
    setStatus('warn', 'Měření bylo ukončeno předčasně.');
  }

  async function finishMeasurement(manual) {
    if (!state.running) return;
    state.running = false;
    window.HLUKOMER_REFERENCE_SPEAKER_RUNNING = false;
    await cleanupCapture();

    if (manual || !state.syncT0Perf) {
      renderRunning(false);
      setStatus('warn', 'Měření nebylo dokončeno.');
      return;
    }

    const required = ['backgroundBefore', 'linearityLow', 'linearityHigh', 'pink', 'backgroundAfter', 'white'];
    const incomplete = required.filter(name => !(state.segments?.[name]?.duration > 5));
    if (incomplete.length) {
      renderRunning(false);
      setStatus('bad', 'Některé části nahrávky nebyly zachyceny celé. Měření zopakujte od začátku.');
      return;
    }

    const profile = buildProfile();
    saveProfile(profile);
    renderRunning(false);
    setStatus('good', '✓ Měření dokončeno. Profil reproduktoru byl vytvořen.');
    const panel = $('refSpeakerLastResult');
    if (panel) panel.hidden = false;
  }

  function renderRunning(running) {
    const start = $('refSpeakerStart');
    const stop = $('refSpeakerStop');
    const name = $('refSpeakerName');
    const unit = $('refSpeakerUnit');
    if (start) start.disabled = running;
    if (stop) stop.hidden = !running;
    if (name) name.disabled = running;
    if (unit) unit.disabled = running;
  }

  function downloadLastProfile() {
    if (!state.lastProfile) return;
    const name = (state.lastProfile.speaker?.name || 'reproduktor')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const blob = new Blob([JSON.stringify(state.lastProfile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bernio-reference-${name || 'reproduktor'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderLastResult() {
    const box = $('refSpeakerLastResult');
    const summary = $('refSpeakerLastSummary');
    if (!box || !summary) return;
    if (!state.lastProfile) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    summary.innerHTML = speakerProfileSummary(state.lastProfile);
  }

  function ensureScreen() {
    if ($('refSpeakerScreen')) return;
    const screen = document.createElement('section');
    screen.id = 'refSpeakerScreen';
    screen.className = 'refSpeakerScreen';
    screen.hidden = true;
    screen.innerHTML = `
      <div class="refSpeakerHeader">
        <button type="button" id="refSpeakerBack">← Zpět</button>
        <strong>Změřit referenční reproduktor</strong>
      </div>
      <div class="refSpeakerBody">
        <div class="refSpeakerCard">
          <h3>Referenční sestava</h3>
          <label>Název reproduktoru<input id="refSpeakerName" value="T&G TG-113A"></label>
          <label>Označení kusu<input id="refSpeakerUnit" placeholder="např. kus 1"></label>
          <div class="refSpeakerNote">Telefon nic nepřehrává. Nejdřív spusťte měření zde a potom pusťte <strong>kalibrační nahrávku Bernio v2 z flashdisku v reproduktoru</strong>. Telefon se synchronizuje podle tří úvodních chirpů.</div>
          <div class="refSpeakerChecklist">Vzdálenost 1,50 m · stejná výška · proti sobě · během měření nehýbat</div>
          <button type="button" class="primary" id="refSpeakerStart">Začít měření</button>
          <button type="button" class="danger" id="refSpeakerStop" hidden>Ukončit měření</button>
        </div>

        <div class="refSpeakerCard">
          <div class="refSpeakerPhase" id="refSpeakerPhase">Připraveno</div>
          <div class="refSpeakerProgress"><div id="refSpeakerProgressBar"></div></div>
          <div class="refSpeakerTime" id="refSpeakerTime">0:00</div>
          <div class="refSpeakerStatus" id="refSpeakerStatus">Připraveno.</div>
        </div>

        <div class="refSpeakerCard" id="refSpeakerLastResult" hidden>
          <h3>Poslední vytvořený profil</h3>
          <div id="refSpeakerLastSummary"></div>
          <button type="button" id="refSpeakerDownload">Stáhnout profil JSON</button>
          <div class="refSpeakerNote">Hodnoty jsou už frekvenčně opravené individuálním souborem Dayton. Absolutní SPL zatím nepovažujeme za ověřené.</div>
        </div>
      </div>`;
    document.body.appendChild(screen);

    $('refSpeakerBack')?.addEventListener('click', () => {
      if (state.running) {
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      screen.hidden = true;
      document.body.classList.remove('refSpeakerOpen');
    });
    $('refSpeakerStart')?.addEventListener('click', startMeasurement);
    $('refSpeakerStop')?.addEventListener('click', stopMeasurement);
    $('refSpeakerDownload')?.addEventListener('click', downloadLastProfile);
    renderLastResult();
  }

  function ensureUi() {
    const panel = $('daytonMicPanel');
    if (!panel || $('refSpeakerOpenBtn')) return;

    const block = document.createElement('div');
    block.className = 'refSpeakerEntry';
    block.innerHTML = `
      <button type="button" class="primary" id="refSpeakerOpenBtn">Změřit referenční reproduktor</button>
      <div class="calSmall">Telefon pouze poslouchá nahrávku z reproduktoru a automaticky změří pozadí, linearitu, růžový i bílý šum.</div>`;

    const deviceBlock = panel.querySelector('.daytonDeviceBlock');
    if (deviceBlock) deviceBlock.insertAdjacentElement('afterend', block);
    else panel.appendChild(block);

    $('refSpeakerOpenBtn')?.addEventListener('click', () => {
      if (!window.HLUKOMER_DAYTON?.isActive?.()) {
        alert('Nejdřív zapněte Dayton a načtěte jeho kalibrační soubor.');
        return;
      }
      const validation = window.HLUKOMER_DAYTON?.validateBeforeStart?.();
      if (validation && validation.ok === false) {
        alert(validation.message || 'Vyberte USB mikrofon Dayton.');
        return;
      }
      ensureScreen();
      $('refSpeakerScreen').hidden = false;
      document.body.classList.add('refSpeakerOpen');
    });

    if (!$('refSpeakerStyles')) {
      const style = document.createElement('style');
      style.id = 'refSpeakerStyles';
      style.textContent = `
        .refSpeakerEntry{display:grid;gap:6px}
        .refSpeakerEntry button{width:100%;min-height:50px}
        .refSpeakerScreen{position:fixed;inset:0;z-index:12000;background:var(--bg);color:var(--text);overflow:auto}
        .refSpeakerScreen[hidden]{display:none!important}
        .refSpeakerHeader{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--card);border-bottom:1px solid var(--line)}
        .refSpeakerHeader button{min-height:40px}
        .refSpeakerBody{width:min(100%,720px);margin:0 auto;padding:16px 12px 40px;display:grid;gap:12px}
        .refSpeakerCard{display:grid;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}
        .refSpeakerCard h3{margin:0;font-size:16px}
        .refSpeakerCard label{display:grid;gap:5px;font-size:12px;color:var(--muted);font-weight:750}
        .refSpeakerCard input{width:100%}
        .refSpeakerNote,.refSpeakerChecklist{font-size:12px;line-height:1.45;color:var(--muted)}
        .refSpeakerChecklist{padding:9px 10px;background:var(--card2);border-radius:10px;color:var(--text)}
        .refSpeakerPhase{font-size:17px;font-weight:850}
        .refSpeakerProgress{height:12px;border-radius:999px;background:#0b1422;border:1px solid var(--line);overflow:hidden}
        .refSpeakerProgress>div{height:100%;width:0;background:var(--accent);transition:width .2s linear}
        .refSpeakerTime{font-variant-numeric:tabular-nums;font-size:12px;color:var(--muted)}
        .refSpeakerStatus{border-radius:11px;padding:10px 11px;font-size:12px;line-height:1.4;border:1px solid var(--line);background:var(--card2)}
        .refSpeakerStatus.good{background:#123329;border-color:#245f49;color:#b8f3d5}
        .refSpeakerStatus.warn{background:#3a3015;border-color:#756020;color:#f8e7a1}
        .refSpeakerStatus.bad{background:#3a2029;border-color:#743645;color:#ffd2d9}
        .refSpeakerStatus.ready{background:#102538;border-color:#33506a;color:#c8e9f7}
        .refSpResultGrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
        .refSpResultGrid>div{display:grid;gap:3px;background:var(--card2);padding:9px;border-radius:10px}
        .refSpResultGrid span{font-size:10px;color:var(--muted)}
        .refSpResultGrid strong{font-size:13px}
        body.refSpeakerOpen{overflow:hidden}
        @media(max-width:520px){.refSpResultGrid{grid-template-columns:1fr}.refSpeakerBody{padding:12px 10px 30px}}
      `;
      document.head.appendChild(style);
    }
  }

  ensureUi();
  ensureScreen();
  window.addEventListener('DOMContentLoaded', () => {
    ensureUi();
    ensureScreen();
  });
})();
