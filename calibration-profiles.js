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

/* Ruční SPL kalibrace bez horního limitu 100 dB. */
(() => {
  const offsetInput = document.getElementById('offsetNum');
  if (!offsetInput) return;
  offsetInput.removeAttribute('max');
  offsetInput.addEventListener('change', event => {
    const value = Number(offsetInput.value);
    if (!Number.isFinite(value) || value <= 100) return;
    event.stopImmediatePropagation();
    localStorage.setItem('hlukomer.offsetDB.v2', String(value));
    offsetInput.value = value.toFixed(1);
  });
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
    frequencyCalibrationDb: hlukomerReadFrequencyCalibration(),
    referenceSource: hlukomerCurrentReferenceSource()
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
    referenceSource: data.referenceSource && typeof data.referenceSource === 'object' ? data.referenceSource : null
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
      localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, imported.name);
      if (imported.referenceSource) localStorage.setItem(HLUKOMER_CAL_REFERENCE_KEY, JSON.stringify(imported.referenceSource));
      else localStorage.removeItem(HLUKOMER_CAL_REFERENCE_KEY);
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
      <div class="calSmall">JSON obsahuje SPL offset a frekvenční korekce 31,5 Hz až 16 kHz. Při načtení nahradí současnou kalibraci.</div>
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
hlukomerSetupDetailsState();
window.addEventListener('DOMContentLoaded', () => {
  hlukomerEnsureCalibrationProfileUi();
  hlukomerSetupDetailsState();
});
