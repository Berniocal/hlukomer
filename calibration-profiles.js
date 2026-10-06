/* Připravené profily pro budoucí kalibraci podle referenčního zdroje. */
window.HLUKOMER_CALIBRATION_PROFILES = [
  {
    id: 'tg113a',
    name: 'T&G TG-113A',
    productCode: 'T615A',
    status: 'waiting-for-reference-values',
    distanceM: 1.5,
    speakerPosition: 'reproduktor a mikrofon telefonu ve stejné výšce, proti sobě',
    volumeInstruction: 'nastavení hlasitosti bude pevně určeno po referenčním měření',
    backgroundSeconds: 5,
    calibrationSeconds: 25,
    recommendedSignalOverBackgroundDb: 20,
    minimumSignalOverBackgroundDb: 15,
    primaryNoise: 'pink',
    checkNoise: 'white',
    noiseFiles: {
      pinkMp3: 'calibration/ruzovy_sum_2min.mp3',
      whiteMp3: 'calibration/bily_sum_2min.mp3'
    },
    recommendedOctavesHz: [125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    reference: null
  }
];

const HLUKOMER_CAL_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const HLUKOMER_CAL_PROFILE_NAME_KEY = 'hlukomer.calibrationProfileName.v1';
const HLUKOMER_CAL_REFERENCE_KEY = 'hlukomer.calibrationReferenceSource.v1';
const HLUKOMER_ROOM_TEST_KEY = 'hlukomer.roomAcousticsTest.v1';

/* Oprava migrace uložených měření.
   Pokud už nový seznam existuje a je prázdný, znamená to, že uživatel
   měření skutečně smazal. Staré klíče z předchozích verzí proto odstraníme,
   aby je timed.js při dalším spuštění znovu nenamigroval. */
(() => {
  const currentKey = 'hlukomer.results.v4';
  const legacyKeys = [
    'hlukomer.results.v3',
    'hlukomer.timedResults.v2',
    'hlukomer.timedResults.v1',
    'hlukomer.manualResults.v2',
    'hlukomer.measurements.v1'
  ];

  const raw = localStorage.getItem(currentKey);
  if (raw === null) return;

  try {
    const current = JSON.parse(raw);
    if (Array.isArray(current) && current.length === 0) {
      legacyKeys.forEach(key => localStorage.removeItem(key));
    }
  } catch (_) {}
})();

function hlukomerReadFrequencyCalibration() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('hlukomer.freqCalibration.v2') || '{}'); }
  catch (_) { raw = {}; }
  return Object.fromEntries(HLUKOMER_CAL_FREQS.map(freq => {
    const value = Number(raw[freq]);
    return [String(freq), Number.isFinite(value) ? value : 0];
  }));
}

function hlukomerReadRoomAcoustics() {
  try {
    const stored = JSON.parse(localStorage.getItem(HLUKOMER_ROOM_TEST_KEY) || 'null');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  } catch (_) {
    return null;
  }
}

function hlukomerCurrentReferenceSource() {
  const select = document.getElementById('referenceSpeakerPreview');
  const profiles = window.HLUKOMER_CALIBRATION_PROFILES || [];
  let profile = null;
  if (select?.dataset.profileId) profile = profiles.find(p => p.id === select.dataset.profileId);
  if (!profile && profiles.length) profile = profiles[0];
  if (profile) {
    return {
      id: profile.id,
      name: profile.name,
      productCode: profile.productCode || null,
      distanceM: profile.distanceM ?? null,
      primaryNoise: profile.primaryNoise || null
    };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(HLUKOMER_CAL_REFERENCE_KEY) || 'null');
    return stored && typeof stored === 'object' ? stored : null;
  } catch (_) { return null; }
}

function hlukomerDownloadCalibration(profileName) {
  const offset = Number(localStorage.getItem('hlukomer.offsetDB.v2') ?? localStorage.getItem('noiseMeterOffsetDB') ?? 40);
  const data = {
    format: 'bernio-hlukomer-calibration',
    version: 1,
    name: profileName || 'Kalibrace hlukoměru',
    createdAt: new Date().toISOString(),
    splOffsetDb: Number.isFinite(offset) ? offset : 40,
    calibrationState: localStorage.getItem('hlukomer.calibrationState.v1') || 'uncalibrated',
    frequencyCalibrationDb: hlukomerReadFrequencyCalibration(),
    referenceSource: hlukomerCurrentReferenceSource(),
    roomAcoustics: hlukomerReadRoomAcoustics()
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const safeName = String(data.name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'hlukomer-kalibrace';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hlukomerNormalizeImportedCalibration(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Soubor neobsahuje platnou kalibraci.');
  if (data.format && data.format !== 'bernio-hlukomer-calibration') throw new Error('Tento JSON není kalibrační profil hlukoměru Bernio.');
  const offset = Number(data.splOffsetDb);
  if (!Number.isFinite(offset)) throw new Error('V souboru chybí platná SPL kalibrace.');
  const sourceFreq = data.frequencyCalibrationDb;
  if (!sourceFreq || typeof sourceFreq !== 'object' || Array.isArray(sourceFreq)) throw new Error('V souboru chybí frekvenční kalibrace.');
  const frequencyCalibrationDb = {};
  HLUKOMER_CAL_FREQS.forEach(freq => {
    const value = Number(sourceFreq[freq]);
    frequencyCalibrationDb[freq] = Number.isFinite(value) ? value : 0;
  });
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Načtená kalibrace',
    splOffsetDb: offset,
    frequencyCalibrationDb,
    referenceSource: data.referenceSource && typeof data.referenceSource === 'object' ? data.referenceSource : null,
    roomAcoustics: data.roomAcoustics && typeof data.roomAcoustics === 'object' && !Array.isArray(data.roomAcoustics) ? data.roomAcoustics : null
  };
}

function hlukomerImportCalibrationFile(file, nameInput) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ''));
      const imported = hlukomerNormalizeImportedCalibration(parsed);
      if (!confirm(`Načíst kalibraci „${imported.name}“?\n\nSoučasná kalibrace bude nahrazena.`)) return;
      localStorage.setItem('hlukomer.offsetDB.v2', String(imported.splOffsetDb));
      localStorage.setItem('hlukomer.freqCalibration.v2', JSON.stringify(imported.frequencyCalibrationDb));
      localStorage.setItem('hlukomer.calibrationState.v1', 'imported');
      localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, imported.name);
      if (imported.referenceSource) localStorage.setItem(HLUKOMER_CAL_REFERENCE_KEY, JSON.stringify(imported.referenceSource));
      else localStorage.removeItem(HLUKOMER_CAL_REFERENCE_KEY);
      if (imported.roomAcoustics) localStorage.setItem(HLUKOMER_ROOM_TEST_KEY, JSON.stringify(imported.roomAcoustics));
      else localStorage.removeItem(HLUKOMER_ROOM_TEST_KEY);
      if (nameInput) nameInput.value = imported.name;
      alert('Kalibrace byla načtena. Aplikace se nyní obnoví.');
      location.reload();
    } catch (error) {
      alert(error?.message || 'Kalibrační JSON se nepodařilo načíst.');
    }
  };
  reader.onerror = () => alert('Soubor se nepodařilo přečíst.');
  reader.readAsText(file, 'utf-8');
}

function hlukomerEnsureCalibrationProfileUi() {
  if (document.getElementById('calibrationFileDetails')) return document.getElementById('calibrationFileDetails');

  const referenceDetails = document.getElementById('referenceCalibrationPreview');
  const aside = document.querySelector('aside.card') || document.querySelector('aside');
  if (!referenceDetails && !aside) return null;

  const details = document.createElement('details');
  details.id = 'calibrationFileDetails';
  details.open = false;
  details.innerHTML = `
    <summary>Kalibrační profil</summary>
    <div class="detailbody">
      <label class="calSmall" for="calibrationProfileName">Název profilu</label>
      <input id="calibrationProfileName" type="text" value="Moje kalibrace">
      <div class="savedActions">
        <button type="button" id="downloadCalibrationJsonBtn">Stáhnout kalibraci JSON</button>
        <button type="button" id="loadCalibrationJsonBtn">Načíst kalibraci JSON</button>
      </div>
      <input id="calibrationJsonFile" type="file" accept=".json,application/json" hidden>
      <div class="calSmall">JSON obsahuje SPL offset, frekvenční korekce 31,5 Hz až 16 kHz a poslední test akustiky místnosti. Při načtení nahradí současnou kalibraci.</div>
    </div>`;

  if (referenceDetails) referenceDetails.insertAdjacentElement('afterend', details);
  else aside.appendChild(details);

  const nameInput = details.querySelector('#calibrationProfileName');
  const downloadBtn = details.querySelector('#downloadCalibrationJsonBtn');
  const loadBtn = details.querySelector('#loadCalibrationJsonBtn');
  const fileInput = details.querySelector('#calibrationJsonFile');

  nameInput.value = localStorage.getItem(HLUKOMER_CAL_PROFILE_NAME_KEY) || 'Moje kalibrace';
  nameInput.addEventListener('change', () => {
    const value = nameInput.value.trim() || 'Moje kalibrace';
    nameInput.value = value;
    localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, value);
  });
  downloadBtn.addEventListener('click', () => {
    const value = nameInput.value.trim() || 'Moje kalibrace';
    localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, value);
    hlukomerDownloadCalibration(value);
  });
  loadBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => hlukomerImportCalibrationFile(fileInput.files?.[0], nameInput));
  return details;
}

function hlukomerMedian(values) {
  const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function hlukomerMeanSquare(samples, start, end) {
  start = Math.max(0, Math.floor(start));
  end = Math.min(samples.length, Math.ceil(end));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  return sum / (end - start);
}

function hlukomerRms(samples, start, end) {
  return Math.sqrt(hlukomerMeanSquare(samples, start, end));
}

function hlukomerLinearRegression(points) {
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
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function hlukomerDetectClaps(samples, sampleRate) {
  const frameSize = Math.max(64, Math.round(sampleRate * 0.01));
  const frames = [];
  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    frames.push({
      start,
      rms: hlukomerRms(samples, start, start + frameSize)
    });
  }

  const baselineFrames = frames
    .filter(frame => frame.start / sampleRate >= 0.1 && frame.start / sampleRate <= 0.8)
    .map(frame => frame.rms);
  const noiseRms = hlukomerMedian(baselineFrames) || 0.001;
  const threshold = Math.max(noiseRms * 6, 0.012);
  const earliest = 0.9;
  const latest = samples.length / sampleRate - 1.25;
  const candidates = [];

  for (let i = 2; i < frames.length - 2; i += 1) {
    const t = frames[i].start / sampleRate;
    if (t < earliest || t > latest || frames[i].rms < threshold) continue;
    if (frames[i].rms >= frames[i - 1].rms && frames[i].rms >= frames[i + 1].rms &&
        frames[i].rms >= frames[i - 2].rms && frames[i].rms >= frames[i + 2].rms) {
      candidates.push(frames[i]);
    }
  }

  candidates.sort((a, b) => b.rms - a.rms);
  const selected = [];
  const minGapSamples = sampleRate * 1.35;
  for (const candidate of candidates) {
    if (selected.every(other => Math.abs(other.start - candidate.start) >= minGapSamples)) {
      selected.push(candidate);
      if (selected.length === 3) break;
    }
  }

  selected.sort((a, b) => a.start - b.start);
  return { selected, noiseRms };
}

function hlukomerAnalyzeClap(samples, sampleRate, roughStart) {
  const searchRadius = Math.round(sampleRate * 0.035);
  const searchStart = Math.max(0, roughStart - searchRadius);
  const searchEnd = Math.min(samples.length, roughStart + searchRadius);
  let peakIndex = searchStart;
  let peakAbs = 0;
  for (let i = searchStart; i < searchEnd; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peakAbs) {
      peakAbs = value;
      peakIndex = i;
    }
  }

  const noiseStart = Math.max(0, peakIndex - Math.round(sampleRate * 0.35));
  const noiseEnd = Math.max(noiseStart + 1, peakIndex - Math.round(sampleRate * 0.06));
  const noiseEnergy = Math.max(1e-12, hlukomerMeanSquare(samples, noiseStart, noiseEnd));
  const noiseRms = Math.sqrt(noiseEnergy);
  const peakSnrDb = 20 * Math.log10(Math.max(peakAbs, 1e-8) / Math.max(noiseRms, 1e-8));
  if (!Number.isFinite(peakSnrDb) || peakSnrDb < 24) return null;

  const frameSize = Math.max(64, Math.round(sampleRate * 0.01));
  const tailSamples = Math.min(Math.round(sampleRate * 1.15), samples.length - peakIndex);
  const energies = [];
  for (let offset = 0; offset + frameSize <= tailSamples; offset += frameSize) {
    const e = hlukomerMeanSquare(samples, peakIndex + offset, peakIndex + offset + frameSize);
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
  let minDecay = 0;
  for (let i = 0; i < cumulative.length; i += 1) {
    const db = 10 * Math.log10(Math.max(cumulative[i], 1e-20) / ref);
    minDecay = Math.min(minDecay, db);
    if (db <= -5 && db >= -25) points.push([i * frameSize / sampleRate, db]);
  }

  let rt60Sec = null;
  const fit = hlukomerLinearRegression(points);
  if (fit && fit.slope < -5) {
    const estimate = -60 / fit.slope;
    if (Number.isFinite(estimate) && estimate > 0.08 && estimate < 5) rt60Sec = estimate;
  }
  if (rt60Sec === null && minDecay > -18) rt60Sec = 2.5;
  if (rt60Sec === null) return null;

  const directWindow = Math.max(32, Math.round(sampleRate * 0.004));
  const directStart = Math.max(0, peakIndex - Math.round(directWindow / 2));
  const directRms = hlukomerRms(samples, directStart, directStart + directWindow);
  const reflectionWindow = Math.max(32, Math.round(sampleRate * 0.004));
  const reflectionStart = peakIndex + Math.round(sampleRate * 0.015);
  const reflectionEnd = Math.min(samples.length - reflectionWindow, peakIndex + Math.round(sampleRate * 0.08));
  let reflectionRms = 0;
  const step = Math.max(8, Math.round(reflectionWindow / 2));
  for (let start = reflectionStart; start <= reflectionEnd; start += step) {
    reflectionRms = Math.max(reflectionRms, hlukomerRms(samples, start, start + reflectionWindow));
  }
  const earlyReflectionDb = 20 * Math.log10(Math.max(reflectionRms, 1e-9) / Math.max(directRms, 1e-9));

  return {
    rt60Sec,
    earlyReflectionDb,
    peakSnrDb
  };
}

function hlukomerClassifyRoom(rt60Sec, earlyReflectionDb) {
  const reverb = rt60Sec <= 0.5
    ? { key: 'good', label: 'vhodný' }
    : rt60Sec <= 0.8
      ? { key: 'warn', label: 'zvýšený' }
      : { key: 'bad', label: 'nevhodný' };

  const reflections = earlyReflectionDb <= -12
    ? { key: 'good', label: 'malé' }
    : earlyReflectionDb <= -6
      ? { key: 'warn', label: 'zvýšené' }
      : { key: 'bad', label: 'silné' };

  let overall = 'good';
  if (reverb.key === 'bad' || reflections.key === 'bad') overall = 'bad';
  else if (reverb.key === 'warn' || reflections.key === 'warn') overall = 'warn';

  return { reverb, reflections, overall };
}

function hlukomerRenderRoomResult(result) {
  const results = document.getElementById('roomTestResults');
  const reverbBox = document.getElementById('roomReverbMetric');
  const reflectionBox = document.getElementById('roomReflectionMetric');
  const reverbStatus = document.getElementById('roomReverbStatus');
  const reverbValue = document.getElementById('roomReverbValue');
  const reflectionStatus = document.getElementById('roomReflectionStatus');
  const reflectionValue = document.getElementById('roomReflectionValue');
  const overall = document.getElementById('roomTestOverall');
  if (!results || !result) return;

  const classified = hlukomerClassifyRoom(Number(result.rt60Sec), Number(result.earlyReflectionDb));
  results.hidden = false;
  reverbBox.className = `roomMetric ${classified.reverb.key}`;
  reflectionBox.className = `roomMetric ${classified.reflections.key}`;
  reverbStatus.textContent = classified.reverb.label;
  reverbValue.textContent = `RT ≈ ${Number(result.rt60Sec).toFixed(2)} s`;
  reflectionStatus.textContent = classified.reflections.label;
  reflectionValue.textContent = `časný odraz ≈ ${Number(result.earlyReflectionDb).toFixed(1)} dB`;

  overall.className = `roomTestOverall ${classified.overall}`;
  if (classified.overall === 'good') {
    overall.textContent = 'Místnost je pro referenční kalibraci vhodná.';
  } else if (classified.overall === 'warn') {
    overall.textContent = 'Místnost je použitelná, ale má zvýšený dozvuk nebo odrazy. Pokud můžete, zvolte tlumenější místo dál od stěn.';
  } else {
    overall.textContent = 'Místnost není pro spolehlivou kalibraci vhodná. Zkuste menší nebo tlumenější prostor a sestavu posuňte dál od stěn.';
  }
}

async function hlukomerRunRoomTest() {
  const button = document.getElementById('roomTestBtn');
  const message = document.getElementById('roomTestMessage');
  const progress = document.getElementById('roomTestProgress');
  if (!button || !message || !progress) return;

  const transportStop = document.getElementById('transportStopBtn');
  const nativeStop = document.getElementById('stopBtn');
  if ((transportStop && !transportStop.disabled) || (nativeStop && !nativeStop.disabled)) {
    alert('Nejdřív ukončete běžné měření hluku a potom spusťte test místnosti.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Tento prohlížeč neumí zpřístupnit mikrofon pro test místnosti.');
    return;
  }

  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = 'Probíhá test…';
  message.textContent = 'Telefon nechte na místě měření. Za chvíli tleskněte 3× v místě reproduktoru, vždy s odstupem asi 2 s.';
  progress.textContent = 'Připravuji mikrofon…';

  let stream = null;
  let context = null;
  let source = null;
  let processor = null;
  let silentGain = null;
  let timer = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextCtor();
    await context.resume();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(1024, 1, 1);
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    const chunks = [];
    let totalLength = 0;

    processor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input);
      chunks.push(copy);
      totalLength += copy.length;
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);

    const durationSec = 10;
    const started = performance.now();
    message.textContent = 'Počkejte na výzvu…';
    progress.textContent = '1 s';
    setTimeout(() => {
      if (processor) message.textContent = 'TLESKNĚTE 3× v místě reproduktoru. Mezi tlesknutími nechte asi 2 s.';
    }, 900);

    timer = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      const remaining = Math.max(0, durationSec - elapsed);
      progress.textContent = `${remaining.toFixed(1)} s`;
    }, 100);

    await new Promise(resolve => setTimeout(resolve, durationSec * 1000));
    clearInterval(timer);
    timer = null;
    processor.onaudioprocess = null;

    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    progress.textContent = 'Vyhodnocuji…';
    message.textContent = 'Analyzuji dozvuk a časné odrazy.';
    const detected = hlukomerDetectClaps(samples, context.sampleRate);
    if (detected.selected.length < 3) {
      throw new Error('Nepodařilo se spolehlivě rozpoznat 3 tlesknutí. Zkuste tleskat silněji a s odstupem asi 2 s.');
    }

    const clapResults = detected.selected
      .map(item => hlukomerAnalyzeClap(samples, context.sampleRate, item.start))
      .filter(Boolean);
    if (clapResults.length < 2) {
      throw new Error('Tlesknutí neměla dostatečný odstup od hluku pozadí. Zkuste test zopakovat v tišší místnosti a tleskněte silněji.');
    }

    const rt60Sec = hlukomerMedian(clapResults.map(item => item.rt60Sec));
    const earlyReflectionDb = hlukomerMedian(clapResults.map(item => item.earlyReflectionDb));
    const result = {
      method: 'three-clap-room-screening-v1',
      testedAt: new Date().toISOString(),
      clapsDetected: clapResults.length,
      rt60Sec: Number(rt60Sec.toFixed(3)),
      earlyReflectionDb: Number(earlyReflectionDb.toFixed(2)),
      thresholds: {
        reverberationSec: { goodMax: 0.5, warningMax: 0.8 },
        earlyReflectionDb: { goodMax: -12, warningMax: -6 }
      }
    };
    localStorage.setItem(HLUKOMER_ROOM_TEST_KEY, JSON.stringify(result));
    hlukomerRenderRoomResult(result);
    message.textContent = 'Test dokončen. Hodnocení je orientační kontrola vhodnosti místnosti pro kalibraci.';
    progress.textContent = '3 tlesknutí vyhodnocena';
  } catch (error) {
    message.textContent = error?.message || 'Test místnosti se nepodařilo dokončit.';
    progress.textContent = 'Zkuste test zopakovat.';
  } finally {
    if (timer) clearInterval(timer);
    try { source?.disconnect(); } catch (_) {}
    try { processor?.disconnect(); } catch (_) {}
    try { silentGain?.disconnect(); } catch (_) {}
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch (_) {}
    }
    button.disabled = false;
    button.textContent = oldText;
  }
}

function hlukomerEnsureRoomTestUi() {
  const referenceDetails = document.getElementById('referenceCalibrationPreview');
  const body = referenceDetails?.querySelector('.detailbody');
  if (!body) return null;
  if (document.getElementById('roomAcousticsTest')) return document.getElementById('roomAcousticsTest');

  if (!document.getElementById('roomTestStyles')) {
    const style = document.createElement('style');
    style.id = 'roomTestStyles';
    style.textContent = `
      .roomTestCard{display:grid;gap:8px;padding:10px;border:1px solid #33506a;background:#0d1b2b;border-radius:12px}
      .roomTestTitle{font-size:12px;font-weight:850}
      .roomTestMessage,.roomTestProgress{font-size:11px;color:var(--muted);line-height:1.4}
      .roomTestProgress{font-weight:800;color:var(--accent)}
      .roomTestResults{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .roomMetric{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px}
      .roomMetric span{display:block;font-size:10px;color:var(--muted)}
      .roomMetric strong{display:block;font-size:14px;margin-top:2px}
      .roomMetric small{display:block;font-size:10px;color:var(--muted);margin-top:2px}
      .roomMetric.good strong{color:var(--ok)}
      .roomMetric.warn strong{color:#fbbf24}
      .roomMetric.bad strong{color:var(--danger)}
      .roomTestOverall{padding:8px 9px;border-radius:10px;font-size:11px;line-height:1.4;border:1px solid var(--line)}
      .roomTestOverall.good{background:#102a24;border-color:#23594b}
      .roomTestOverall.warn{background:#302817;border-color:#6c5828}
      .roomTestOverall.bad{background:#351d27;border-color:#713444}
      @media(max-width:560px){.roomTestResults{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  const card = document.createElement('div');
  card.id = 'roomAcousticsTest';
  card.className = 'roomTestCard';
  card.innerHTML = `
    <div class="roomTestTitle">Test místnosti · 3 tlesknutí</div>
    <div class="roomTestMessage" id="roomTestMessage">Telefon nechte na místě budoucího měření. Tleskejte v místě reproduktoru, tedy přibližně 1,50 m od telefonu. Test kontroluje dozvuk i silné časné odrazy.</div>
    <button type="button" class="primary" id="roomTestBtn">Spustit test místnosti</button>
    <div class="roomTestProgress" id="roomTestProgress"></div>
    <div class="roomTestResults" id="roomTestResults" hidden>
      <div class="roomMetric" id="roomReverbMetric"><span>Dozvuk</span><strong id="roomReverbStatus">--</strong><small id="roomReverbValue"></small></div>
      <div class="roomMetric" id="roomReflectionMetric"><span>Odrazy</span><strong id="roomReflectionStatus">--</strong><small id="roomReflectionValue"></small></div>
      <div class="roomTestOverall" id="roomTestOverall" style="grid-column:1/-1"></div>
    </div>
    <div class="calSmall">Pracovní orientační hranice: dozvuk do 0,5 s vhodný, 0,5–0,8 s zvýšený, nad 0,8 s nevhodný. Odrazy se hodnotí relativně k přímému tlesknutí.</div>`;

  const steps = body.querySelector('.calSteps');
  if (steps) steps.insertAdjacentElement('beforebegin', card);
  else body.appendChild(card);
  card.querySelector('#roomTestBtn').addEventListener('click', hlukomerRunRoomTest);

  const previous = hlukomerReadRoomAcoustics();
  if (previous?.rt60Sec != null && previous?.earlyReflectionDb != null) {
    hlukomerRenderRoomResult(previous);
    const testedAt = previous.testedAt ? new Date(previous.testedAt) : null;
    const progress = card.querySelector('#roomTestProgress');
    if (testedAt && !Number.isNaN(testedAt.getTime())) progress.textContent = `Poslední test: ${testedAt.toLocaleString('cs-CZ')}`;
  }
  return card;
}

function hlukomerSetupDetailsState() {
  document.querySelectorAll('aside details').forEach(details => { details.open = false; });
  const savedDetails = document.getElementById('timedSeriesDetails');
  const savedList = document.getElementById('timedMeasurements');
  if (!savedDetails || !savedList || savedList.dataset.autoOpenReady === '1') return;
  savedList.dataset.autoOpenReady = '1';
  let previousCount = savedList.children.length;
  const observer = new MutationObserver(() => {
    const currentCount = savedList.children.length;
    if (currentCount > previousCount) savedDetails.open = true;
    previousCount = currentCount;
  });
  observer.observe(savedList, { childList: true });
}

/* Skript je na konci body, proto UI vytvoříme okamžitě. DOMContentLoaded je jen záloha. */
hlukomerEnsureCalibrationProfileUi();
hlukomerEnsureRoomTestUi();
hlukomerSetupDetailsState();
window.addEventListener('DOMContentLoaded', () => {
  hlukomerEnsureCalibrationProfileUi();
  hlukomerEnsureRoomTestUi();
  hlukomerSetupDetailsState();
});
