(() => {
  'use strict';

  const TRACK = {
    id: 'bernio-calibration-track-v2',
    version: 2,
    wav: 'calibration/bernio_kalibrace_v2.wav',
    mp3: 'calibration/bernio_kalibrace_v2.mp3',
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

  const ROOM_KEY = 'hlukomer.roomAcousticsTest.v1';
  const QUALITY_KEY = 'hlukomer.calibrationQuality.v1';
  const MATH = window.HLUKOMER_MATH;
  if (!MATH) throw new Error('Chybí acoustic-math.js');
  const ENGINE_VERSION = String(window.HLUKOMER_CALIBRATION_ENGINE_VERSION || '2.1.0');
  const DEFAULT_STANDARD_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
  const DEFAULT_EXPERIMENTAL_BANDS = [16000];
  const $ = id => document.getElementById(id);

  const state = {
    trackFormat: 'wav',
    backgroundBefore: null,
    pink: null,
    backgroundAfter: null,
    white: null,
    linearityLow: null,
    linearityHigh: null,
    linearity: null,
    backgroundDbfs: null,
    pinkDbfs: null,
    whiteDbfs: null,
    room: null,
    quality: null,
    technicalCaptures: [],
    finalQuality: null,
    step: 0,
    busy: false
  };

  function standardCalibrationBands() {
    const configured = (window.HLUKOMER_CALIBRATION_PROFILES || [])[0]?.recommendedOctavesHz;
    const bands = Array.isArray(configured) ? configured.map(Number).filter(Number.isFinite) : [];
    return bands.length ? bands : DEFAULT_STANDARD_BANDS;
  }

  function experimentalCalibrationBands() {
    const configured = (window.HLUKOMER_CALIBRATION_PROFILES || [])[0]?.experimentalOctavesHz;
    const bands = Array.isArray(configured) ? configured.map(Number).filter(Number.isFinite) : [];
    return bands.length ? bands : DEFAULT_EXPERIMENTAL_BANDS;
  }

  function calibrationBands() {
    return [...new Set([...standardCalibrationBands(), ...experimentalCalibrationBands()])].sort((a, b) => a - b);
  }

  function isExperimentalBand(center) {
    return experimentalCalibrationBands().includes(Number(center));
  }

  function emptyBandMap(value = 0) {
    return Object.fromEntries(calibrationBands().map(center => [center, value]));
  }

  function formatBand(center) {
    if (center >= 1000) return `${Number(center / 1000).toLocaleString('cs-CZ')} kHz`;
    return `${center} Hz`;
  }

  function powerToDb(power) {
    return MATH.powerToDb(power);
  }

  function signalToNoiseSnr(totalPower, backgroundPower) {
    return MATH.signalToNoiseSnr(totalPower, backgroundPower);
  }

  function classifySnr(snr) {
    return MATH.classifySnr(snr);
  }

  function median(values) {
    const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!arr.length) return null;
    const m = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  function meanSquare(samples, start, end) {
    start = Math.max(0, Math.floor(start));
    end = Math.min(samples.length, Math.ceil(end));
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    return sum / (end - start);
  }

  function rms(samples, start, end) {
    return Math.sqrt(meanSquare(samples, start, end));
  }

  function regression(points) {
    if (points.length < 4) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const n = points.length;
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) return null;
    return { slope: (n * sxy - sx * sy) / den };
  }

  function detectChirps(samples, sampleRate) {
    const frameSize = Math.max(64, Math.round(sampleRate * 0.01));
    const frames = [];
    for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
      frames.push({ start, rms: rms(samples, start, start + frameSize) });
    }

    const baseline = frames
      .filter(f => f.start / sampleRate >= 0.2 && f.start / sampleRate <= 3.2)
      .map(f => f.rms);
    const noiseRms = median(baseline) || 0.001;
    const threshold = Math.max(noiseRms * 7, 0.008);
    const candidates = [];

    for (let i = 2; i < frames.length - 2; i += 1) {
      const t = frames[i].start / sampleRate;
      if (t < 2 || frames[i].rms < threshold) continue;
      if (frames[i].rms >= frames[i - 1].rms && frames[i].rms >= frames[i + 1].rms &&
          frames[i].rms >= frames[i - 2].rms && frames[i].rms >= frames[i + 2].rms) {
        candidates.push(frames[i]);
      }
    }

    candidates.sort((a, b) => b.rms - a.rms);
    const selected = [];
    const minGap = sampleRate * 1.7;
    for (const candidate of candidates) {
      if (selected.every(other => Math.abs(other.start - candidate.start) >= minGap)) {
        selected.push(candidate);
        if (selected.length === 3) break;
      }
    }
    selected.sort((a, b) => a.start - b.start);
    return selected;
  }

  function analyzeChirp(samples, sampleRate, roughStart) {
    const radius = Math.round(sampleRate * 0.04);
    const a = Math.max(0, roughStart - radius);
    const b = Math.min(samples.length, roughStart + radius);
    let peak = a;
    let peakAbs = 0;
    for (let i = a; i < b; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peakAbs) {
        peakAbs = value;
        peak = i;
      }
    }

    const noiseStart = Math.max(0, peak - Math.round(sampleRate * 0.45));
    const noiseEnd = Math.max(noiseStart + 1, peak - Math.round(sampleRate * 0.12));
    const noiseEnergy = Math.max(1e-12, meanSquare(samples, noiseStart, noiseEnd));
    const noiseRms = Math.sqrt(noiseEnergy);
    const snrDb = 20 * Math.log10(Math.max(peakAbs, 1e-9) / Math.max(noiseRms, 1e-9));
    if (!Number.isFinite(snrDb) || snrDb < 22) return null;

    const directStart = Math.max(0, peak - Math.round(sampleRate * 0.018));
    const directEnd = Math.min(samples.length, peak + Math.round(sampleRate * 0.022));
    const directRms = rms(samples, directStart, directEnd);

    const tailStart = peak + Math.round(sampleRate * 0.04);
    const frame = Math.max(64, Math.round(sampleRate * 0.01));
    const tailLength = Math.min(Math.round(sampleRate * 1.2), samples.length - tailStart);
    const energies = [];
    for (let off = 0; off + frame <= tailLength; off += frame) {
      const e = meanSquare(samples, tailStart + off, tailStart + off + frame);
      energies.push(Math.max(e - noiseEnergy, noiseEnergy * 1e-4));
    }
    if (energies.length < 20) return null;

    const cumulative = new Array(energies.length);
    let total = 0;
    for (let i = energies.length - 1; i >= 0; i -= 1) {
      total += energies[i];
      cumulative[i] = total;
    }

    const ref = cumulative[0] || 1e-12;
    const points = [];
    let minDb = 0;
    for (let i = 0; i < cumulative.length; i += 1) {
      const db = 10 * Math.log10(Math.max(cumulative[i], 1e-20) / ref);
      minDb = Math.min(minDb, db);
      if (db <= -5 && db >= -25) points.push([i * frame / sampleRate, db]);
    }

    let rt60Sec = null;
    const fit = regression(points);
    if (fit && fit.slope < -5) {
      const rt = -60 / fit.slope;
      if (Number.isFinite(rt) && rt > 0.08 && rt < 5) rt60Sec = rt;
    }
    if (rt60Sec === null && minDb > -18) rt60Sec = 2.5;
    if (rt60Sec === null) return null;

    const reflWindow = Math.max(32, Math.round(sampleRate * 0.006));
    const reflStart = peak + Math.round(sampleRate * 0.045);
    const reflEnd = Math.min(samples.length - reflWindow, peak + Math.round(sampleRate * 0.13));
    let reflectionRms = 0;
    for (let s = reflStart; s <= reflEnd; s += Math.max(8, Math.round(reflWindow / 2))) {
      reflectionRms = Math.max(reflectionRms, rms(samples, s, s + reflWindow));
    }
    const earlyReflectionDb = 20 * Math.log10(Math.max(reflectionRms, 1e-9) / Math.max(directRms, 1e-9));

    return { rt60Sec, earlyReflectionDb, peakSnrDb: snrDb };
  }

  function classifyRoom(rt, reflectionDb) {
    const reverb = rt <= 0.5
      ? { level: 'good', label: 'dobrý' }
      : rt <= 0.8
        ? { level: 'warn', label: 'zvýšený' }
        : { level: 'bad', label: 'příliš velký' };
    const reflections = reflectionDb <= -12
      ? { level: 'good', label: 'minimální' }
      : reflectionDb <= -6
        ? { level: 'warn', label: 'zvýšené' }
        : { level: 'bad', label: 'silné' };
    let overall = 'good';
    if (reverb.level === 'bad' || reflections.level === 'bad') overall = 'bad';
    else if (reverb.level === 'warn' || reflections.level === 'warn') overall = 'warn';
    return { reverb, reflections, overall };
  }

  function ensureStyles() {
    if ($('calGuideStyles')) return;
    const style = document.createElement('style');
    style.id = 'calGuideStyles';
    style.textContent = `
      #referenceCalibrationPreview .calPreview{display:grid;gap:8px}
      .calEntryButtons{display:grid;gap:8px}
      .calEntryButtons button{width:100%;min-height:48px}
      .calEntryButtons .primary{min-height:54px}
      .calGuideParking{display:none!important}
      .calScreen{position:fixed;inset:0;z-index:10000;background:var(--bg);color:var(--text);display:flex;flex-direction:column;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
      .calScreen[hidden]{display:none!important}
      .calScreenHeader{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--card)}
      .calBack{min-width:74px;min-height:40px;padding:7px 10px}
      .calScreenTitle{font-size:17px;font-weight:850}
      .calScreenBody{width:min(100%,720px);margin:0 auto;padding:18px 16px 34px;overflow:auto;display:grid;gap:16px}
      .calGuideSection{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:9px}
      .calGuideSection h3{margin:0;font-size:15px}
      .calGuideSection p{margin:0;color:var(--muted);font-size:13px;line-height:1.45}
      .calGuideList{margin:0;padding-left:20px;color:var(--text);font-size:13px;line-height:1.5}
      .calDownloadGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .calDownload{display:flex;flex-direction:column;gap:3px;text-decoration:none;border:1px solid var(--line);background:#152236;color:var(--text);border-radius:12px;padding:12px;font-size:13px;font-weight:800}
      .calDownload.recommended{background:#123d58;border-color:#1f7aa4}
      .calDownload small{font-size:10px;color:var(--muted);font-weight:600}
      .calWizardBody{align-content:start;min-height:100%}
      .calStepTop{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px;font-weight:750}
      .calStepDots{display:flex;gap:5px}
      .calStepDot{width:8px;height:8px;border-radius:50%;background:#314158}
      .calStepDot.active{background:var(--accent)}
      .calStepDot.done{background:var(--ok)}
      .calWizardCard{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px 16px;display:grid;gap:14px;text-align:center}
      .calWizardIcon{font-size:34px;line-height:1}
      .calWizardCard h3{font-size:19px;margin:0}
      .calWizardText{font-size:14px;line-height:1.45;color:var(--muted);margin:0}
      .calWizardAction{width:100%;min-height:52px;font-size:15px}
      .calWizardResult{display:grid;gap:8px;text-align:left}
      .calResultRow{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--card2);border-radius:12px;padding:10px 12px}
      .calResultRow span{font-size:12px;color:var(--muted)}
      .calResultRow strong{font-size:13px;text-align:right}
      .calStatus{border-radius:12px;padding:11px 12px;font-size:13px;font-weight:750;line-height:1.35;text-align:left}
      .calStatus.good{background:#123329;border:1px solid #245f49}
      .calStatus.warn{background:#3a3015;border:1px solid #756020}
      .calStatus.bad{background:#3a2029;border:1px solid #743645}
      .calProgress{font-size:13px;color:var(--accent);font-weight:800;min-height:20px}
      .calWizardNav{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .calWizardNav button:only-child{grid-column:1/-1}
      .calBandTable{display:grid;gap:5px}
      .calBandRow{display:grid;grid-template-columns:minmax(70px,1fr) auto auto;align-items:center;gap:8px;background:var(--card2);border-radius:10px;padding:8px 10px;text-align:left}
      .calBandRow span{font-size:12px;color:var(--muted)}
      .calBandRow strong{font-size:12px;font-variant-numeric:tabular-nums}
      .calBandTag{font-size:10px;font-weight:850;border-radius:999px;padding:3px 7px;border:1px solid var(--line)}
      .calBandTag.good{background:#123329;border-color:#245f49;color:#b8f3d5}
      .calBandTag.warn{background:#3a3015;border-color:#756020;color:#f8e7a1}
      .calBandTag.bad{background:#3a2029;border-color:#743645;color:#ffd2d9}
      body.calScreenOpen{overflow:hidden}
      @media(max-width:560px){
        .calScreenBody{padding:14px 12px 28px}
        .calDownloadGrid{grid-template-columns:1fr}
        .calWizardCard{padding:16px 14px}
        .calWizardNav{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function buildHelpScreen() {
    if ($('calHelpScreen')) return;
    const screen = document.createElement('section');
    screen.id = 'calHelpScreen';
    screen.className = 'calScreen';
    screen.hidden = true;
    screen.innerHTML = `
      <div class="calScreenHeader">
        <button type="button" class="calBack" data-cal-close="help">← Zpět</button>
        <div class="calScreenTitle">Návod ke kalibraci</div>
      </div>
      <div class="calScreenBody">
        <div class="calGuideSection">
          <h3>Co budete potřebovat</h3>
          <ul class="calGuideList">
            <li>podporovaný referenční reproduktor, zatím T&G TG-113A,</li>
            <li>telefon s aplikací Hlukoměr,</li>
            <li>kalibrační nahrávku Bernio v2,</li>
            <li>metr pro nastavení vzdálenosti 1,50 m,</li>
            <li>co nejtišší místnost.</li>
          </ul>
        </div>
        <div class="calGuideSection">
          <h3>Stáhněte kalibrační nahrávku</h3>
          <p><strong>WAV je referenční varianta.</strong> MP3 je pouze nouzová možnost; pro plnohodnotnou automatickou kalibraci musí mít jednou vlastní referenční data.</p>
          <div class="calDownloadGrid">
            <a class="calDownload recommended" href="${TRACK.wav}" download>Stáhnout WAV v2 · referenční<small>obsahuje i test linearity</small></a>
            <a class="calDownload" href="${TRACK.mp3}" download>Stáhnout MP3 v2 · nouzově<small>není ekvivalentní referenčnímu WAV</small></a>
          </div>
        </div>
        <div class="calGuideSection">
          <h3>Jak sestavu nachystat</h3>
          <ul class="calGuideList">
            <li>Telefon a reproduktor dejte 1,50 m od sebe.</li>
            <li>Mají být ve stejné výšce a namířené proti sobě.</li>
            <li>Nedávejte je těsně ke stěně ani do rohu místnosti.</li>
            <li>Během kalibrace s telefonem ani reproduktorem nehýbejte.</li>
            <li>Na reproduktoru použijte předepsané nastavení hlasitosti daného profilu.</li>
          </ul>
        </div>
        <div class="calGuideSection">
          <h3>Co je v nahrávce</h3>
          <p><strong>0:05–0:11</strong> · tři krátké chirpy pro test místnosti<br><strong>0:20–0:45</strong> · ticho pro pozadí před kalibrací<br><strong>0:50–1:05</strong> · slabší růžový šum pro test linearity<br><strong>1:10–1:25</strong> · tentýž růžový šum přesně o 10 dB výš<br><strong>1:30–2:30</strong> · růžový šum pro kalibraci<br><strong>2:30–3:00</strong> · ticho pro pozadí po kalibraci<br><strong>3:00–3:30</strong> · bílý šum pro kontrolu</p>
        </div>
        <div class="calGuideSection">
          <h3>Pak už jen postupujte podle telefonu</h3>
          <p>Po stisku „Začít kalibraci“ aplikace ukáže vždy jen jeden krok. Standardní kalibrační rozsah je 125 Hz–8 kHz. Pásmo 16 kHz zatím ponecháváme experimentálně a vyhodnotíme ho až podle referenčních měření.</p>
        </div>
      </div>`;
    document.body.appendChild(screen);
  }

  function buildWizardScreen() {
    if ($('calWizardScreen')) return;
    const screen = document.createElement('section');
    screen.id = 'calWizardScreen';
    screen.className = 'calScreen';
    screen.hidden = true;
    screen.innerHTML = `
      <div class="calScreenHeader">
        <button type="button" class="calBack" data-cal-close="wizard">← Zpět</button>
        <div class="calScreenTitle">Kalibrace</div>
      </div>
      <div class="calScreenBody calWizardBody">
        <div class="calStepTop"><span id="calStepLabel"></span><div class="calStepDots" id="calStepDots"></div></div>
        <div class="calWizardCard" id="calWizardCard"></div>
      </div>`;
    document.body.appendChild(screen);
  }

  function compactReferenceSection() {
    const details = $('referenceCalibrationPreview');
    const body = details?.querySelector('.detailbody');
    if (!details || !body || body.dataset.compactGuide === '1') return;

    body.dataset.compactGuide = '1';
    const parking = document.createElement('div');
    parking.id = 'calGuideParking';
    parking.className = 'calGuideParking';
    while (body.firstChild) parking.appendChild(body.firstChild);
    document.body.appendChild(parking);

    body.innerHTML = `
      <div class="calEntryButtons">
        <button type="button" id="openCalibrationHelp">Návod ke kalibraci</button>
        <button type="button" class="primary" id="openCalibrationWizard">Začít kalibraci</button>
      </div>`;
  }

  function openScreen(id) {
    const screen = $(id);
    if (!screen) return;
    screen.hidden = false;
    document.body.classList.add('calScreenOpen');
  }

  function closeScreen(id) {
    const screen = $(id);
    if (!screen) return;
    screen.hidden = true;
    if ($('calHelpScreen')?.hidden !== false && $('calWizardScreen')?.hidden !== false) {
      document.body.classList.remove('calScreenOpen');
    }
  }

  function isRegularMeasurementRunning() {
    if (window.HLUKOMER_REFERENCE_SPEAKER_RUNNING === true) return true;
    const transportStop = $('transportStopBtn');
    const nativeStop = $('stopBtn');
    return Boolean((transportStop && !transportStop.disabled) || (nativeStop && !nativeStop.disabled));
  }

  function technicalMetadataSnapshot(track, context, captureEngine, label) {
    let settings = {};
    try { settings = typeof track?.getSettings === 'function' ? track.getSettings() : {}; }
    catch (_) { settings = {}; }

    const entry = {
      label,
      capturedAt: new Date().toISOString(),
      captureEngine,
      audioContextSampleRate: Number(context?.sampleRate) || null,
      trackSettings: {
        sampleRate: Number(settings.sampleRate) || null,
        channelCount: Number(settings.channelCount) || null,
        autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
        noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
        echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null
      },
      browser: {
        userAgent: navigator.userAgent || null,
        platform: navigator.platform || null,
        language: navigator.language || null
      }
    };

    state.technicalCaptures = state.technicalCaptures.filter(item => item.label !== label);
    state.technicalCaptures.push(entry);
    return entry;
  }

  function technicalSummary() {
    const latest = state.technicalCaptures[state.technicalCaptures.length - 1] || null;
    return {
      calibrationEngineVersion: ENGINE_VERSION,
      referenceTrackId: TRACK.id,
      referenceTrackFormat: state.trackFormat,
      referenceTrackFile: state.trackFormat === 'mp3' ? TRACK.mp3 : TRACK.wav,
      referenceProfileId: getReferenceProfile()?.id || null,
      referenceProfileVersion: getReferenceProfile()?.profileVersion ?? null,
      browser: latest?.browser || {
        userAgent: navigator.userAgent || null,
        platform: navigator.platform || null,
        language: navigator.language || null
      },
      captures: state.technicalCaptures.slice()
    };
  }

  async function withMicrophone(durationSec, onChunk, onProgress, captureLabel = 'measurement') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Tento prohlížeč neumí použít mikrofon.');
    if (isRegularMeasurementRunning()) throw new Error('Nejdřív ukončete běžné měření hluku.');

    let stream = null;
    let context = null;
    let source = null;
    let worklet = null;
    let fallbackProcessor = null;
    let silentGain = null;
    let timer = null;
    let progressTimer = null;
    let captureEngine = 'audio-worklet';

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }});

      const track = stream.getAudioTracks?.()[0];
      let micStatus = null;
      if (typeof window.hlukomerInspectMicrophoneTrack === 'function') {
        micStatus = window.hlukomerInspectMicrophoneTrack(track);
      } else {
        let settings = {};
        try { settings = typeof track?.getSettings === 'function' ? track.getSettings() : {}; } catch (_) {}
        const keys = ['autoGainControl', 'noiseSuppression', 'echoCancellation'];
        micStatus = { settings, active: keys.filter(key => settings[key] === true) };
      }
      if (micStatus?.active?.length) {
        const labels = {
          autoGainControl: 'automatické zesílení',
          noiseSuppression: 'potlačení šumu',
          echoCancellation: 'potlačení ozvěny'
        };
        const activeText = micStatus.active.map(key => labels[key] || key).join(', ');
        throw new Error(`Prohlížeč ponechal zapnuté zpracování mikrofonu: ${activeText}. Pro spolehlivou kalibraci použijte prohlížeč/zařízení, kde lze tyto funkce vypnout.`);
      }

      const Ctx = window.AudioContext || window.webkitAudioContext;
      context = new Ctx();
      await context.resume();
      source = context.createMediaStreamSource(stream);
      silentGain = context.createGain();
      silentGain.gain.value = 0;

      if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          await context.audioWorklet.addModule('measurement-worklet.js?v=31');
          worklet = new AudioWorkletNode(context, 'hlukomer-capture', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1]
          });
          worklet.port.onmessage = event => {
            const data = event.data;
            if (data?.type !== 'block' || !(data.samples instanceof Float32Array)) return;
            onChunk?.(data.samples, Number(data.sampleRate) || context.sampleRate);
          };
          source.connect(worklet);
          worklet.connect(silentGain);
        } catch (error) {
          console.warn('Kalibrační AudioWorklet není dostupný, používám záložní sběr.', error);
          worklet = null;
        }
      }

      if (!worklet) {
        captureEngine = 'script-processor-fallback';
        fallbackProcessor = context.createScriptProcessor(2048, 1, 1);
        fallbackProcessor.onaudioprocess = event => {
          const input = event.inputBuffer.getChannelData(0);
          onChunk?.(new Float32Array(input), context.sampleRate);
        };
        source.connect(fallbackProcessor);
        fallbackProcessor.connect(silentGain);
      }

      silentGain.connect(context.destination);
      technicalMetadataSnapshot(track, context, captureEngine, captureLabel);

      const started = performance.now();
      progressTimer = setInterval(() => {
        const elapsed = Math.min(durationSec, (performance.now() - started) / 1000);
        onProgress?.(elapsed, durationSec);
      }, 150);

      await new Promise(resolve => {
        timer = setTimeout(resolve, durationSec * 1000);
      });
      onProgress?.(durationSec, durationSec);
      return { sampleRate: context.sampleRate, captureEngine };
    } finally {
      clearTimeout(timer);
      clearInterval(progressTimer);
      if (worklet) worklet.port.onmessage = null;
      if (fallbackProcessor) fallbackProcessor.onaudioprocess = null;
      try { source?.disconnect(); } catch (_) {}
      try { worklet?.disconnect(); } catch (_) {}
      try { fallbackProcessor?.disconnect(); } catch (_) {}
      try { silentGain?.disconnect(); } catch (_) {}
      stream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== 'closed') {
        try { await context.close(); } catch (_) {}
      }
    }
  }

  async function captureAcousticSample(durationSec, progressEl, captureLabel = 'level') {
    let sumSquares = 0;
    let sampleCount = 0;
    let clippedSamples = 0;
    let peakAbs = 0;
    let measuredSampleRate = 0;
    const bandPowerSum = emptyBandMap(0);
    const bandFrames = emptyBandMap(0);
    const coverage = Object.fromEntries(calibrationBands().map(center => [center, null]));

    await withMicrophone(durationSec, (chunk, sampleRate) => {
      measuredSampleRate = sampleRate;
      for (let i = 0; i < chunk.length; i += 1) {
        const x = chunk[i];
        sumSquares += x * x;
        sampleCount += 1;
        const ax = Math.abs(x);
        peakAbs = Math.max(peakAbs, ax);
        if (ax >= 0.995) clippedSamples += 1;
      }

      const block = MATH.analyzeTimeBlock(chunk, sampleRate, {
        centers: calibrationBands(),
        calibration: {},
        analysisMaxHz: 20000,
        offsetDb: 0
      });
      if (!block) return;

      calibrationBands().forEach(center => {
        coverage[center] = block.coverage?.[center] === true;
        const power = block.octavePowersZ?.[center];
        if (Number.isFinite(power) && power > 0) {
          bandPowerSum[center] += power;
          bandFrames[center] += 1;
        }
      });
    }, (elapsed, total) => {
      if (progressEl) progressEl.textContent = `Měřím… ${Math.ceil(elapsed)} / ${total} s`;
    }, captureLabel);

    const overallPower = sumSquares / Math.max(1, sampleCount);
    const bandPowers = emptyBandMap(0);
    const bandDb = emptyBandMap(-Infinity);
    calibrationBands().forEach(center => {
      const frames = bandFrames[center] || 0;
      const power = frames > 0 ? bandPowerSum[center] / frames : 0;
      bandPowers[center] = power;
      bandDb[center] = powerToDb(power);
    });

    return {
      overallPower,
      dbfs: powerToDb(overallPower),
      sampleRate: measuredSampleRate,
      peakAbs: Number(peakAbs.toFixed(6)),
      clippedFraction: sampleCount > 0 ? clippedSamples / sampleCount : 0,
      coverage,
      bandPowers,
      bandDb
    };
  }

  async function captureLevel(durationSec, progressEl) {
    const sample = await captureAcousticSample(durationSec, progressEl);
    return sample.dbfs;
  }

  function evaluateLinearity() {
    if (!state.linearityLow || !state.linearityHigh || !state.backgroundBefore) return null;

    const expectedDb = TRACK.linearityExpectedDifferenceDb;
    const backgroundPower = state.backgroundAfter
      ? MATH.worstBackgroundPower(state.backgroundBefore.overallPower, state.backgroundAfter.overallPower)
      : state.backgroundBefore.overallPower;
    const lowSourcePower = MATH.sourcePowerFromTotalAndBackground(state.linearityLow.overallPower, backgroundPower);
    const highSourcePower = MATH.sourcePowerFromTotalAndBackground(state.linearityHigh.overallPower, backgroundPower);
    const measuredDb = lowSourcePower > 0 && highSourcePower > 0
      ? MATH.powerToDb(highSourcePower / lowSourcePower)
      : NaN;
    const errorDb = measuredDb - expectedDb;
    const absError = Math.abs(errorDb);
    const clipping = (state.linearityLow.clippedFraction || 0) > 0.0001
      || (state.linearityHigh.clippedFraction || 0) > 0.0001
      || Number(state.linearityHigh.peakAbs) >= 0.995;

    let level = Number.isFinite(measuredDb)
      ? (absError <= 1 ? 'good' : absError <= 2 ? 'warn' : 'bad')
      : 'bad';
    if (clipping) level = 'bad';

    const bandDifferencesDb = {};
    standardCalibrationBands().forEach(center => {
      const before = state.backgroundBefore.bandPowers?.[center] || 0;
      const after = state.backgroundAfter?.bandPowers?.[center] || 0;
      const bandBackground = state.backgroundAfter
        ? MATH.worstBackgroundPower(before, after)
        : before;
      const low = MATH.sourcePowerFromTotalAndBackground(state.linearityLow.bandPowers?.[center] || 0, bandBackground);
      const high = MATH.sourcePowerFromTotalAndBackground(state.linearityHigh.bandPowers?.[center] || 0, bandBackground);
      bandDifferencesDb[center] = low > 0 && high > 0
        ? Number(MATH.powerToDb(high / low).toFixed(2))
        : null;
    });

    const result = {
      measuredAt: new Date().toISOString(),
      backgroundCorrected: true,
      backgroundDbfs: Number(MATH.powerToDb(backgroundPower).toFixed(2)),
      expectedDifferenceDb: expectedDb,
      measuredDifferenceDb: Number.isFinite(measuredDb) ? Number(measuredDb.toFixed(2)) : null,
      errorDb: Number.isFinite(errorDb) ? Number(errorDb.toFixed(2)) : null,
      toleranceDb: { good: 1, warning: 2 },
      clipping,
      low: {
        dbfs: Number(state.linearityLow.dbfs.toFixed(2)),
        sourceDbfs: lowSourcePower > 0 ? Number(MATH.powerToDb(lowSourcePower).toFixed(2)) : null,
        peakAbs: state.linearityLow.peakAbs,
        clippedFraction: state.linearityLow.clippedFraction
      },
      high: {
        dbfs: Number(state.linearityHigh.dbfs.toFixed(2)),
        sourceDbfs: highSourcePower > 0 ? Number(MATH.powerToDb(highSourcePower).toFixed(2)) : null,
        peakAbs: state.linearityHigh.peakAbs,
        clippedFraction: state.linearityHigh.clippedFraction
      },
      bandDifferencesDb,
      level,
      usable: level !== 'bad'
    };
    state.linearity = result;
    return result;
  }

  function evaluateCalibrationQuality() {
    if (!state.backgroundBefore || !state.pink || !state.backgroundAfter) return null;

    const backgroundPower = MATH.worstBackgroundPower(state.backgroundBefore.overallPower, state.backgroundAfter.overallPower);
    const overallSnrDb = signalToNoiseSnr(state.pink.overallPower, backgroundPower);
    const backgroundChangeDb = Math.abs(state.backgroundAfter.dbfs - state.backgroundBefore.dbfs);
    const bands = {};
    const usableBands = [];
    const usableStandardBands = [];
    const standardSet = new Set(standardCalibrationBands());

    calibrationBands().forEach(center => {
      const experimental = isExperimentalBand(center);
      const fullyCovered = state.backgroundBefore.coverage?.[center] === true
        && state.pink.coverage?.[center] === true
        && state.backgroundAfter.coverage?.[center] === true;

      if (!fullyCovered) {
        bands[center] = {
          snrDb: null,
          level: experimental ? 'warn' : 'bad',
          usable: false,
          coverage: 'incomplete',
          experimental
        };
        return;
      }

      const before = state.backgroundBefore.bandPowers?.[center] || 0;
      const after = state.backgroundAfter.bandPowers?.[center] || 0;
      const bg = MATH.worstBackgroundPower(before, after);
      const total = state.pink.bandPowers?.[center] || 0;
      const snrDb = signalToNoiseSnr(total, bg);
      const classification = classifySnr(snrDb);
      const usable = snrDb >= 15;
      bands[center] = {
        snrDb: Number.isFinite(snrDb) ? Number(snrDb.toFixed(2)) : null,
        level: classification.level,
        usable,
        coverage: 'complete',
        experimental
      };
      if (usable) {
        usableBands.push(center);
        if (standardSet.has(center)) usableStandardBands.push(center);
      }
    });

    const profile = getReferenceProfile();
    const quality = {
      measuredAt: new Date().toISOString(),
      calibrationEngineVersion: ENGINE_VERSION,
      referenceTrack: TRACK.id,
      referenceProfileId: profile?.id || null,
      referenceProfileVersion: profile?.profileVersion ?? null,
      standardBandsHz: standardCalibrationBands(),
      experimentalBandsHz: experimentalCalibrationBands(),
      backgroundBeforeDbfs: Number(state.backgroundBefore.dbfs.toFixed(2)),
      backgroundAfterDbfs: Number(state.backgroundAfter.dbfs.toFixed(2)),
      backgroundChangeDb: Number(backgroundChangeDb.toFixed(2)),
      overallSnrDb: Number.isFinite(overallSnrDb) ? Number(overallSnrDb.toFixed(2)) : null,
      thresholdsDb: { good: 20, minimum: 15 },
      analysisMaxHz: 20000,
      sampleRate: state.pink.sampleRate || state.backgroundBefore.sampleRate || state.backgroundAfter.sampleRate || null,
      bands,
      usableBands,
      usableStandardBands,
      trackFormat: state.trackFormat,
      linearity: state.linearity,
      technicalMetadata: technicalSummary(),
      whiteValidation: null,
      finalAssessment: null
    };
    state.quality = quality;
    localStorage.setItem(QUALITY_KEY, JSON.stringify(quality));
    return quality;
  }

  async function runRoomTest(progressEl) {
    const chunks = [];
    let totalLength = 0;
    let baseline = [];
    let liveCount = 0;
    let lastHit = -Infinity;
    let startedPerf = performance.now();
    let sampleRate = 44100;

    await withMicrophone(16, (chunk, sr) => {
      sampleRate = sr;
      chunks.push(chunk);
      totalLength += chunk.length;

      let sum = 0;
      for (let i = 0; i < chunk.length; i += 1) sum += chunk[i] * chunk[i];
      const currentRms = Math.sqrt(sum / Math.max(1, chunk.length));
      const elapsed = (performance.now() - startedPerf) / 1000;
      if (elapsed < 2.5) baseline.push(currentRms);
      const base = median(baseline) || 0.001;
      if (elapsed > 2 && currentRms > Math.max(base * 7, 0.008) && elapsed - lastHit > 1.7) {
        liveCount = Math.min(3, liveCount + 1);
        lastHit = elapsed;
        if (progressEl) progressEl.textContent = `Rozpoznáno: ${liveCount} / 3 ${'✓'.repeat(liveCount)}`;
      }
    }, () => {}, 'room-test');

    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    if (progressEl) progressEl.textContent = 'Vyhodnocuji místnost…';
    const chirps = detectChirps(samples, sampleRate);
    if (chirps.length < 3) {
      throw new Error('Nepodařilo se rozpoznat všechny 3 signály. Spusťte test znovu a nahrávku pusťte až po stisku tlačítka.');
    }
    const analyzed = chirps.map(chirp => analyzeChirp(samples, sampleRate, chirp.start)).filter(Boolean);
    if (analyzed.length < 2) throw new Error('Signály nebyly dostatečně zřetelné. Zkuste tišší místnost nebo vyšší hlasitost referenčního zdroje.');

    const rt = median(analyzed.map(item => item.rt60Sec));
    const reflection = median(analyzed.map(item => item.earlyReflectionDb));
    const result = {
      method: 'three-chirp-room-screening-v1',
      referenceTrack: TRACK.id,
      testedAt: new Date().toISOString(),
      chirpsDetected: analyzed.length,
      rt60Sec: Number(rt.toFixed(3)),
      earlyReflectionDb: Number(reflection.toFixed(2)),
      thresholds: {
        reverberationSec: { goodMax: 0.5, warningMax: 0.8 },
        earlyReflectionDb: { goodMax: -12, warningMax: -6 }
      }
    };
    localStorage.setItem(ROOM_KEY, JSON.stringify(result));
    return result;
  }

  function getReferenceProfile() {
    return (window.HLUKOMER_CALIBRATION_PROFILES || [])[0] || null;
  }

  function getReferenceNumber(profile, paths) {
    for (const path of paths) {
      let value = profile?.reference;
      for (const key of path) value = value?.[key];
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function validationErrorDb() {
    const profile = getReferenceProfile();
    const pinkRef = getReferenceNumber(profile, [['pinkLeqZ'], ['pink', 'leqZ'], ['pink', 'leq']]);
    const whiteRef = getReferenceNumber(profile, [['whiteLeqZ'], ['white', 'leqZ'], ['white', 'leq']]);
    if (pinkRef === null || whiteRef === null || !Number.isFinite(state.pinkDbfs) || !Number.isFinite(state.whiteDbfs)) return null;
    const offset = pinkRef - state.pinkDbfs;
    const estimatedWhite = state.whiteDbfs + offset;
    return estimatedWhite - whiteRef;
  }

  function getReferenceBand(profile, noise, center) {
    const ref = profile?.reference;
    if (!ref) return null;
    const candidates = [
      ref?.[noise]?.octavesZ?.[center],
      ref?.[noise]?.octavesZ?.[String(center)],
      ref?.[`${noise}OctavesZ`]?.[center],
      ref?.[`${noise}OctavesZ`]?.[String(center)],
      ref?.octavesZ?.[noise]?.[center],
      ref?.octavesZ?.[noise]?.[String(center)]
    ];
    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function evaluateWhiteValidation() {
    if (!state.white || !state.pink || !state.quality) return null;
    const profile = getReferenceProfile();
    const rows = {};
    let referenceBands = 0;
    let checkedBands = 0;
    let badBands = 0;
    let warnBands = 0;

    calibrationBands().forEach(center => {
      const experimental = isExperimentalBand(center);
      const fullyCovered = state.white.coverage?.[center] === true && state.pink.coverage?.[center] === true;
      if (!fullyCovered) {
        rows[center] = {
          coverage: 'incomplete',
          experimental,
          whiteSnrDb: null,
          errorDb: null,
          level: experimental ? 'warn' : 'bad'
        };
        return;
      }

      const before = state.backgroundBefore?.bandPowers?.[center] || 0;
      const after = state.backgroundAfter?.bandPowers?.[center] || 0;
      const background = MATH.worstBackgroundPower(before, after);
      const totalWhite = state.white.bandPowers?.[center] || 0;
      const whiteSnr = signalToNoiseSnr(totalWhite, background);

      const pinkRef = getReferenceBand(profile, 'pink', center);
      const whiteRef = getReferenceBand(profile, 'white', center);
      let errorDb = null;
      let level = classifySnr(whiteSnr).level;

      if (pinkRef !== null && whiteRef !== null
          && Number.isFinite(state.pink.bandDb?.[center])
          && Number.isFinite(state.white.bandDb?.[center])
          && whiteSnr >= 15) {
        referenceBands += 1;
        const correction = pinkRef - state.pink.bandDb[center];
        const estimatedWhite = state.white.bandDb[center] + correction;
        errorDb = estimatedWhite - whiteRef;
        const abs = Math.abs(errorDb);
        level = abs <= 1 ? 'good' : abs <= 2 ? 'warn' : 'bad';
        checkedBands += 1;
        if (level === 'bad') badBands += 1;
        if (level === 'warn') warnBands += 1;
      }

      rows[center] = {
        coverage: 'complete',
        experimental,
        whiteSnrDb: Number.isFinite(whiteSnr) ? Number(whiteSnr.toFixed(2)) : null,
        errorDb: Number.isFinite(errorDb) ? Number(errorDb.toFixed(2)) : null,
        level
      };
    });

    const overallError = validationErrorDb();
    const result = {
      measuredAt: new Date().toISOString(),
      overallErrorDb: Number.isFinite(overallError) ? Number(overallError.toFixed(2)) : null,
      referenceBands,
      checkedBands,
      badBands,
      warnBands,
      bands: rows
    };

    state.quality.whiteValidation = result;
    state.quality.technicalMetadata = technicalSummary();
    localStorage.setItem(QUALITY_KEY, JSON.stringify(state.quality));
    return result;
  }

  function evaluateFinalQuality() {
    if (!state.quality) return null;
    const room = state.room ? classifyRoom(state.room.rt60Sec, state.room.earlyReflectionDb) : { overall: 'bad' };
    const standard = standardCalibrationBands();
    const q = state.quality;
    const white = q.whiteValidation;
    const standardUsable = standard.filter(center => q.bands?.[center]?.usable);
    const standardGood = standard.filter(center => Number(q.bands?.[center]?.snrDb) >= 20);
    const backgroundStable = Number(q.backgroundChangeDb) <= 3;
    const allWorklet = state.technicalCaptures.length > 0
      && state.technicalCaptures.every(item => item.captureEngine === 'audio-worklet');
    const referenceAvailable = Number.isFinite(white?.overallErrorDb)
      || standard.some(center => Number.isFinite(white?.bands?.[center]?.errorDb));
    const linearity = state.linearity || q.linearity || null;
    const wavReference = state.trackFormat === 'wav';

    let level = 'good';
    const reasons = [];

    if (room.overall === 'bad' || Number(q.overallSnrDb) < 15 || standardUsable.length === 0 || linearity?.level === 'bad') {
      level = 'bad';
    }
    if (!backgroundStable || standardUsable.length < standard.length || !allWorklet || linearity?.level === 'warn' || !wavReference) {
      if (level !== 'bad') level = 'warn';
    }
    if (!referenceAvailable) {
      if (level !== 'bad') level = 'warn';
      reasons.push('Chybí referenční hodnoty reproduktoru pro úplnou kontrolu.');
    } else {
      const overallAbs = Math.abs(Number(white.overallErrorDb));
      if (Number.isFinite(overallAbs) && overallAbs > 2) level = 'bad';
      else if (Number.isFinite(overallAbs) && overallAbs > 1 && level === 'good') level = 'warn';

      if (white.badBands > 0) level = 'bad';
      else if (white.warnBands > 0 && level === 'good') level = 'warn';
    }

    const linearityMeasuredText = Number.isFinite(Number(linearity?.measuredDifferenceDb))
      ? Number(linearity.measuredDifferenceDb).toFixed(1) + ' dB'
      : 'nelze určit';
    if (!linearity) reasons.push('Test linearity nebyl vyhodnocen.');
    else if (linearity.level === 'bad') reasons.push(`Linearita nevyhověla: naměřeno ${linearityMeasuredText}, očekáváno 10,0 dB.`);
    else if (linearity.level === 'warn') reasons.push(`Linearita je hraniční: naměřeno ${linearityMeasuredText}, očekáváno 10,0 dB.`);
    if (!wavReference) reasons.push('Použita MP3 stopa; referenční variantou je WAV.');
    if (!backgroundStable) reasons.push('Pozadí se během kalibrace změnilo o více než 3 dB.');
    if (standardUsable.length < standard.length) reasons.push(`Použitelných je ${standardUsable.length} z ${standard.length} standardních pásem.`);
    if (!allWorklet) reasons.push('Alespoň jeden krok použil záložní zvukový sběr místo AudioWorkletu.');
    if (experimentalCalibrationBands().length) reasons.push('16 kHz zůstává experimentální a neovlivňuje standardní hodnocení.');

    const label = level === 'good' ? 'dobrá' : level === 'warn' ? 'omezená' : 'nevyhovující';
    const result = {
      level,
      label,
      assessedAt: new Date().toISOString(),
      standardBandsTotal: standard.length,
      standardBandsUsable: standardUsable.length,
      standardBandsGood: standardGood.length,
      room: room.overall,
      backgroundStable,
      allAudioWorklet: allWorklet,
      trackFormat: state.trackFormat,
      linearity: linearity ? {
        level: linearity.level,
        measuredDifferenceDb: linearity.measuredDifferenceDb,
        expectedDifferenceDb: linearity.expectedDifferenceDb,
        clipping: linearity.clipping
      } : null,
      referenceValidationAvailable: referenceAvailable,
      reasons
    };
    state.finalQuality = result;
    q.finalAssessment = result;
    q.technicalMetadata = technicalSummary();
    localStorage.setItem(QUALITY_KEY, JSON.stringify(q));
    return result;
  }

  const STEPS = [
    {
      icon: '📐',
      title: 'Připravte sestavu',
      text: 'Telefon a reproduktor dejte 1,50 m od sebe, ve stejné výšce a proti sobě. Připravte kalibrační nahrávku Bernio v2 na začátek.',
      action: 'Jsem připraven',
      run: async () => {
        state.trackFormat = $('calTrackFormat')?.value || state.trackFormat || 'wav';
        return true;
      }
    },
    {
      icon: '〰️',
      title: 'Test místnosti',
      text: 'Stiskněte tlačítko a hned potom spusťte kalibrační nahrávku od začátku. Telefon čeká na 3 krátké chirpy.',
      action: 'Spustit test místnosti',
      run: async progressEl => {
        state.room = await runRoomTest(progressEl);
        return state.room;
      }
    },
    {
      icon: '🤫',
      title: 'Pozadí před kalibrací',
      text: 'Po chirpech následuje ticho přibližně od 0:20 do 0:45. Změřte hluk pozadí.',
      action: 'Změřit pozadí',
      run: async progressEl => {
        state.backgroundBefore = await captureAcousticSample(5, progressEl, 'background-before');
        state.backgroundDbfs = state.backgroundBefore.dbfs;
        return state.backgroundBefore;
      }
    },
    {
      icon: '🔉',
      title: 'Linearita · slabší signál',
      text: 'Počkejte na první růžový šum přibližně v čase 0:50. Jakmile začne, spusťte měření.',
      action: 'Změřit slabší signál',
      run: async progressEl => {
        state.linearityLow = await captureAcousticSample(8, progressEl, 'linearity-low');
        return state.linearityLow;
      }
    },
    {
      icon: '🔊',
      title: 'Linearita · hlasitější signál',
      text: 'Počkejte na druhý úsek stejného růžového šumu přibližně v čase 1:10. Je přesně o 10 dB výš.',
      action: 'Změřit hlasitější signál',
      run: async progressEl => {
        state.linearityHigh = await captureAcousticSample(8, progressEl, 'linearity-high');
        evaluateLinearity();
        return state.linearityHigh;
      }
    },
    {
      icon: '🌸',
      title: 'Růžový šum',
      text: 'Od 1:30 začíná hlavní růžový šum. Jakmile ho uslyšíte, spusťte měření kalibračního signálu.',
      action: 'Změřit růžový šum',
      run: async progressEl => {
        state.pink = await captureAcousticSample(25, progressEl, 'pink');
        state.pinkDbfs = state.pink.dbfs;
        return state.pink;
      }
    },
    {
      icon: '🤫',
      title: 'Pozadí po kalibraci',
      text: 'Od 2:30 do 3:00 je znovu ticho. Změřte druhé pozadí.',
      action: 'Změřit pozadí po',
      run: async progressEl => {
        state.backgroundAfter = await captureAcousticSample(5, progressEl, 'background-after');
        evaluateLinearity();
        evaluateCalibrationQuality();
        return state.backgroundAfter;
      }
    },
    {
      icon: '✓',
      title: 'Kontrola bílým šumem',
      text: 'Od 3:00 začíná bílý šum. Spusťte závěrečnou kontrolu.',
      action: 'Spustit kontrolu',
      run: async progressEl => {
        state.white = await captureAcousticSample(15, progressEl, 'white');
        state.whiteDbfs = state.white.dbfs;
        evaluateWhiteValidation();
        evaluateFinalQuality();
        return state.white;
      }
    }
  ];

  function resetWizard() {
    state.trackFormat = 'wav';
    state.backgroundBefore = null;
    state.pink = null;
    state.backgroundAfter = null;
    state.white = null;
    state.linearityLow = null;
    state.linearityHigh = null;
    state.linearity = null;
    state.backgroundDbfs = null;
    state.pinkDbfs = null;
    state.whiteDbfs = null;
    state.room = null;
    state.quality = null;
    state.technicalCaptures = [];
    state.finalQuality = null;
    state.step = 0;
    state.busy = false;
    renderWizard();
  }

  function stepResult(stepIndex) {
    if (stepIndex === 0) {
      return `
        <div class="calWizardResult">
          <div class="calResultRow">
            <span>Použitá nahrávka</span>
            <select id="calTrackFormat" aria-label="Formát kalibrační nahrávky">
              <option value="wav" ${state.trackFormat === 'wav' ? 'selected' : ''}>WAV v2 · referenční</option>
              <option value="mp3" ${state.trackFormat === 'mp3' ? 'selected' : ''}>MP3 v2 · nouzově</option>
            </select>
          </div>
          ${state.trackFormat === 'mp3' ? '<div class="calStatus warn">MP3 lze použít pro experimentální kontrolu, ale výsledná kalibrace bude označena jako omezená.</div>' : ''}
        </div>`;
    }

    if (stepIndex === 1 && state.room) {
      const c = classifyRoom(state.room.rt60Sec, state.room.earlyReflectionDb);
      const statusText = c.overall === 'good'
        ? 'Místnost je vhodná.'
        : c.overall === 'warn'
          ? 'Místnost je použitelná, ale není ideální.'
          : 'Místnost není pro kalibraci vhodná.';
      return `
        <div class="calWizardResult">
          <div class="calResultRow"><span>Dozvuk</span><strong>${c.reverb.label} · ${state.room.rt60Sec.toFixed(2)} s</strong></div>
          <div class="calResultRow"><span>Odrazy</span><strong>${c.reflections.label}</strong></div>
          <div class="calStatus ${c.overall}">${statusText}</div>
        </div>`;
    }

    if (stepIndex === 2 && state.backgroundBefore) {
      return `
        <div class="calWizardResult">
          <div class="calResultRow"><span>Pozadí</span><strong>${state.backgroundBefore.dbfs.toFixed(1)} dBFS</strong></div>
          <div class="calStatus good">Pozadí změřeno ✓<br>Teď počkejte na slabší růžový šum kolem 0:50.</div>
        </div>`;
    }

    if (stepIndex === 3 && state.linearityLow) {
      return `
        <div class="calWizardResult">
          <div class="calResultRow"><span>Slabší signál</span><strong>${state.linearityLow.dbfs.toFixed(1)} dBFS</strong></div>
          <div class="calStatus good">První úroveň změřena ✓<br>Počkejte na hlasitější úsek kolem 1:10.</div>
        </div>`;
    }

    if (stepIndex === 4 && state.linearity) {
      const l = state.linearity;
      const measuredText = Number.isFinite(l.measuredDifferenceDb) ? l.measuredDifferenceDb.toFixed(1) + ' dB' : 'nelze určit';
      const errorText = Number.isFinite(l.errorDb) ? (l.errorDb >= 0 ? '+' : '') + l.errorDb.toFixed(1) + ' dB' : '—';
      const text = l.clipping
        ? 'Záznam se dostal do limitace. Kalibraci nelze spolehlivě provést.'
        : l.level === 'good'
          ? 'Linearita je v pořádku.'
          : l.level === 'warn'
            ? 'Linearita je hraniční. Kalibrace může být méně spolehlivá.'
            : 'Odezva není dostatečně lineární. Kalibraci nelze spolehlivě provést.';
      return `
        <div class="calWizardResult">
          <div class="calResultRow"><span>Očekávaný rozdíl</span><strong>10,0 dB</strong></div>
          <div class="calResultRow"><span>Naměřený rozdíl</span><strong>${measuredText}</strong></div>
          <div class="calResultRow"><span>Odchylka</span><strong>${errorText}</strong></div>
          <div class="calStatus ${l.level}">${text}</div>
        </div>`;
    }

    if (stepIndex === 5 && state.pink) {
      return '<div class="calStatus good">Růžový šum změřen ✓<br>Počkejte do 2:30 a změřte druhé pozadí.</div>';
    }

    if (stepIndex === 6 && state.backgroundAfter && state.quality) {
      const q = state.quality;
      const overallSnr = Number(q.overallSnrDb);
      const stable = q.backgroundChangeDb <= 3;
      const rows = calibrationBands().map(center => {
        const item = q.bands?.[center] || {};
        const experimental = isExperimentalBand(center);
        const name = experimental ? `${formatBand(center)} · experimentální` : formatBand(center);
        if (item.coverage === 'incomplete') {
          return `<div class="calBandRow">
            <span>${name}</span>
            <strong>neúplné pásmo</strong>
            <span class="calBandTag warn">${experimental ? 'sledovat' : 'nepoužít'}</span>
          </div>`;
        }
        const snr = Number(item.snrDb);
        const cls = classifySnr(snr);
        return `<div class="calBandRow">
          <span>${name}</span>
          <strong>${Number.isFinite(snr) ? snr.toFixed(1) + ' dB' : '—'}</strong>
          <span class="calBandTag ${cls.level}">${experimental ? 'experiment' : cls.label}</span>
        </div>`;
      }).join('');

      const standard = standardCalibrationBands();
      const usable = standard.filter(center => q.bands?.[center]?.usable).length;
      const total = standard.length;
      const statusLevel = overallSnr < 15 ? 'bad' : stable ? (usable === total ? 'good' : 'warn') : 'warn';
      const statusText = overallSnr < 15
        ? 'Celkový signál je příliš blízko hluku pozadí. Kalibraci zopakujte v tišším prostředí.'
        : !stable
          ? 'Hluk pozadí se během kalibrace změnil o více než 3 dB. Výsledek může být méně spolehlivý.'
          : usable === total
            ? 'Všech 7 standardních pásem 125 Hz–8 kHz má dostatečný odstup od pozadí.'
            : `${usable} z ${total} standardních pásem lze použít. Pásma pod 15 dB se do frekvenční kalibrace nezahrnou.`;

      return `
        <div class="calWizardResult">
          <div class="calResultRow"><span>Celkový SNR</span><strong>${Number.isFinite(overallSnr) ? overallSnr.toFixed(1) + ' dB' : '—'}</strong></div>
          <div class="calResultRow"><span>Změna pozadí před / po</span><strong>${q.backgroundChangeDb.toFixed(1)} dB</strong></div>
          <div class="calBandTable">${rows}</div>
          <div class="calStatus ${statusLevel}">${statusText}</div>
        </div>`;
    }

    if (stepIndex === 7 && state.white) {
      const validation = state.quality?.whiteValidation || evaluateWhiteValidation();
      const finalQuality = state.finalQuality || evaluateFinalQuality();
      const overallError = Number(validation?.overallErrorDb);

      const rows = standardCalibrationBands().map(center => {
        const item = validation?.bands?.[center] || {};
        if (item.coverage === 'incomplete') {
          return `<div class="calBandRow"><span>${formatBand(center)}</span><strong>neúplné</strong><span class="calBandTag bad">nelze ověřit</span></div>`;
        }
        const error = Number(item.errorDb);
        const snr = Number(item.whiteSnrDb);
        if (Number.isFinite(error)) {
          const abs = Math.abs(error);
          const level = abs <= 1 ? 'good' : abs <= 2 ? 'warn' : 'bad';
          return `<div class="calBandRow">
            <span>${formatBand(center)}</span>
            <strong>${error >= 0 ? '+' : ''}${error.toFixed(1)} dB</strong>
            <span class="calBandTag ${level}">${abs <= 1 ? 'výborné' : abs <= 2 ? 'použitelné' : 'mimo'}</span>
          </div>`;
        }
        const cls = classifySnr(snr);
        return `<div class="calBandRow">
          <span>${formatBand(center)}</span>
          <strong>${Number.isFinite(snr) ? 'SNR ' + snr.toFixed(1) + ' dB' : '—'}</strong>
          <span class="calBandTag ${cls.level}">bez reference</span>
        </div>`;
      }).join('');

      const expRows = experimentalCalibrationBands().map(center => {
        const item = validation?.bands?.[center] || {};
        const error = Number(item.errorDb);
        const snr = Number(item.whiteSnrDb);
        const value = Number.isFinite(error)
          ? `${error >= 0 ? '+' : ''}${error.toFixed(1)} dB`
          : Number.isFinite(snr) ? `SNR ${snr.toFixed(1)} dB` : 'neúplné pásmo';
        return `<div class="calBandRow">
          <span>${formatBand(center)} · experimentální</span>
          <strong>${value}</strong>
          <span class="calBandTag warn">jen sledovat</span>
        </div>`;
      }).join('');

      const finalLevel = finalQuality?.level === 'good' ? 'good' : finalQuality?.level === 'bad' ? 'bad' : 'warn';
      const finalText = finalQuality
        ? `Kvalita kalibrace: ${finalQuality.label}.${finalQuality.reasons?.length ? ' ' + finalQuality.reasons.join(' ') : ''}`
        : 'Kvalitu kalibrace se nepodařilo vyhodnotit.';

      return `
        <div class="calWizardResult">
          ${Number.isFinite(overallError) ? `<div class="calResultRow"><span>Celková kontrolní odchylka</span><strong>${overallError >= 0 ? '+' : ''}${overallError.toFixed(1)} dB</strong></div>` : ''}
          <div class="calBandTable">${rows}${expRows}</div>
          ${!Number.isFinite(overallError) ? '<div class="calStatus warn">Bílý šum je změřen po pásmech. Přesnou odchylku dopočítáme po doplnění referenčních hodnot reproduktoru.</div>' : ''}
          <div class="calStatus ${finalLevel}">${finalText}</div>
        </div>`;
    }
    return '';
  }

  function stepMayContinue(stepIndex) {
    if (stepIndex === 1 && state.room) {
      return classifyRoom(state.room.rt60Sec, state.room.earlyReflectionDb).overall !== 'bad';
    }
    if (stepIndex === 4 && state.linearity) {
      return state.linearity.level !== 'bad';
    }
    if (stepIndex === 6 && state.quality) {
      return Number(state.quality.overallSnrDb) >= 15 && (state.quality.usableStandardBands?.length || 0) > 0;
    }
    return true;
  }

  function stepDone(stepIndex) {
    if (stepIndex === 0) return state.step > 0;
    if (stepIndex === 1) return Boolean(state.room);
    if (stepIndex === 2) return Boolean(state.backgroundBefore);
    if (stepIndex === 3) return Boolean(state.linearityLow);
    if (stepIndex === 4) return Boolean(state.linearityHigh && state.linearity);
    if (stepIndex === 5) return Boolean(state.pink);
    if (stepIndex === 6) return Boolean(state.backgroundAfter && state.quality);
    if (stepIndex === 7) return Boolean(state.white);
    return false;
  }

  function renderWizard() {
    const card = $('calWizardCard');
    const label = $('calStepLabel');
    const dots = $('calStepDots');
    if (!card || !label || !dots) return;

    const step = STEPS[state.step];
    label.textContent = `Krok ${state.step + 1} z ${STEPS.length}`;
    dots.innerHTML = STEPS.map((_, index) => `<span class="calStepDot ${index < state.step ? 'done' : index === state.step ? 'active' : ''}"></span>`).join('');

    const done = stepDone(state.step);
    const final = state.step === STEPS.length - 1;
    const canContinue = stepMayContinue(state.step);

    card.innerHTML = `
      <div class="calWizardIcon">${step.icon}</div>
      <h3>${step.title}</h3>
      <p class="calWizardText">${step.text}</p>
      <div class="calProgress" id="calWizardProgress"></div>
      <div id="calWizardResult">${stepResult(state.step)}</div>
      ${!done ? `<button type="button" class="primary calWizardAction" id="calWizardRun">${step.action}</button>` : ''}
      ${done ? `<div class="calWizardNav">
        ${!final && canContinue ? '<button type="button" class="primary" id="calWizardNext">Pokračovat</button>' : ''}
        ${final ? '<button type="button" class="primary" id="calWizardFinish">Dokončit</button>' : ''}
        ${!canContinue ? '<button type="button" id="calWizardRetry">Zkusit znovu</button>' : ''}
      </div>` : ''}`;

    $('calTrackFormat')?.addEventListener('change', event => {
      state.trackFormat = event.target.value === 'mp3' ? 'mp3' : 'wav';
      renderWizard();
    });
    $('calWizardRun')?.addEventListener('click', runCurrentStep);
    $('calWizardNext')?.addEventListener('click', () => {
      state.step += 1;
      renderWizard();
    });
    $('calWizardRetry')?.addEventListener('click', () => {
      if (state.step === 1) state.room = null;
      if (state.step === 4) {
        state.linearityLow = null;
        state.linearityHigh = null;
        state.linearity = null;
        state.step = 3;
      } else if (state.step === 6) {
        state.backgroundAfter = null;
        state.quality = null;
      }
      renderWizard();
    });
    $('calWizardFinish')?.addEventListener('click', () => closeScreen('calWizardScreen'));
  }

  async function runCurrentStep() {
    if (state.busy) return;
    const stepIndex = state.step;
    const step = STEPS[stepIndex];
    const button = $('calWizardRun');
    const progress = $('calWizardProgress');
    state.busy = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Pracuji…';
    }

    try {
      await step.run(progress);
      if (stepIndex === 0) {
        state.step = 1;
        renderWizard();
        return;
      }
      renderWizard();
    } catch (error) {
      if (progress) progress.textContent = '';
      const result = $('calWizardResult');
      if (result) result.innerHTML = `<div class="calStatus bad">${error?.message || 'Krok se nepodařilo dokončit.'}</div>`;
      if (button) {
        button.disabled = false;
        button.textContent = step.action;
      }
    } finally {
      state.busy = false;
    }
  }

  function bindUi() {
    $('openCalibrationHelp')?.addEventListener('click', () => openScreen('calHelpScreen'));
    $('openCalibrationWizard')?.addEventListener('click', () => {
      resetWizard();
      openScreen('calWizardScreen');
    });
    document.querySelectorAll('[data-cal-close="help"]').forEach(button => button.addEventListener('click', () => closeScreen('calHelpScreen')));
    document.querySelectorAll('[data-cal-close="wizard"]').forEach(button => button.addEventListener('click', () => {
      if (!state.busy) closeScreen('calWizardScreen');
    }));
  }

  window.HLUKOMER_CALIBRATION_TRACK = Object.freeze({ ...TRACK });

  function init() {
    ensureStyles();
    compactReferenceSection();
    buildHelpScreen();
    buildWizardScreen();
    bindUi();
  }

  init();
  window.addEventListener('DOMContentLoaded', init);
})();
