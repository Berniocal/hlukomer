/* Připravené profily pro budoucí kalibraci podle referenčního zdroje.
   Funkční kalibrace se doplní až po změření referenčních hodnot konkrétní sestavy. */
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
    // Výrobce uvádí rozsah 120 Hz–18 kHz; 31,5 a 63 Hz proto zatím
    // nepovažujeme za spolehlivou část referenční kalibrace tohoto profilu.
    recommendedOctavesHz: [125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    reference: null
  }
];

const HLUKOMER_CAL_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const HLUKOMER_CAL_PROFILE_NAME_KEY = 'hlukomer.calibrationProfileName.v1';
const HLUKOMER_CAL_REFERENCE_KEY = 'hlukomer.calibrationReferenceSource.v1';

/* Ruční SPL kalibrace: bez horního limitu.
   Tento skript se načítá před app.js, takže u hodnot nad 100 dB zastaví
   původní handler dřív, než by hodnotu ořízl. */
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
  try {
    raw = JSON.parse(localStorage.getItem('hlukomer.freqCalibration.v2') || '{}');
  } catch (_) {
    raw = {};
  }

  return Object.fromEntries(HLUKOMER_CAL_FREQS.map(freq => {
    const value = Number(raw[freq]);
    return [String(freq), Number.isFinite(value) ? value : 0];
  }));
}

function hlukomerCurrentReferenceSource() {
  const select = document.querySelector('#referenceCalibrationPreview select');
  if (select?.value) {
    const profile = (window.HLUKOMER_CALIBRATION_PROFILES || []).find(p => p.id === select.value);
    if (profile) {
      return {
        id: profile.id,
        name: profile.name,
        productCode: profile.productCode || null,
        distanceM: profile.distanceM ?? null,
        primaryNoise: profile.primaryNoise || null
      };
    }
  }

  try {
    const stored = JSON.parse(localStorage.getItem(HLUKOMER_CAL_REFERENCE_KEY) || 'null');
    return stored && typeof stored === 'object' ? stored : null;
  } catch (_) {
    return null;
  }
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
  if (!sourceFreq || typeof sourceFreq !== 'object' || Array.isArray(sourceFreq)) {
    throw new Error('V souboru chybí frekvenční kalibrace.');
  }

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

/* Stav rozbalovacích sekcí + UI pro export/import kalibrace.
   Po načtení jsou všechny sekce v panelu Analýza zavřené.
   Uložená měření se sama otevřou pouze při přidání nového měření. */
window.addEventListener('DOMContentLoaded', () => {
  const referenceDetails = document.getElementById('referenceCalibrationPreview');
  if (referenceDetails && !document.getElementById('calibrationFileDetails')) {
    const details = document.createElement('details');
    details.id = 'calibrationFileDetails';

    const summary = document.createElement('summary');
    summary.textContent = 'Kalibrační profil';

    const body = document.createElement('div');
    body.className = 'detailbody';

    const label = document.createElement('label');
    label.className = 'calSmall';
    label.setAttribute('for', 'calibrationProfileName');
    label.textContent = 'Název profilu';

    const nameInput = document.createElement('input');
    nameInput.id = 'calibrationProfileName';
    nameInput.type = 'text';
    nameInput.value = localStorage.getItem(HLUKOMER_CAL_PROFILE_NAME_KEY) || 'Moje kalibrace';
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim() || 'Moje kalibrace';
      nameInput.value = value;
      localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, value);
    });

    const actions = document.createElement('div');
    actions.className = 'savedActions';

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.textContent = 'Stáhnout kalibraci JSON';
    downloadBtn.addEventListener('click', () => {
      const value = nameInput.value.trim() || 'Moje kalibrace';
      localStorage.setItem(HLUKOMER_CAL_PROFILE_NAME_KEY, value);
      hlukomerDownloadCalibration(value);
    });

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = 'Načíst kalibraci JSON';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    loadBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', () => hlukomerImportCalibrationFile(fileInput.files?.[0], nameInput));

    const note = document.createElement('div');
    note.className = 'calSmall';
    note.textContent = 'JSON obsahuje SPL offset a frekvenční korekce 31,5 Hz až 16 kHz. Při načtení nahradí současnou kalibraci.';

    actions.append(downloadBtn, loadBtn);
    body.append(label, nameInput, actions, fileInput, note);
    details.append(summary, body);
    referenceDetails.insertAdjacentElement('afterend', details);
  }

  document.querySelectorAll('aside details').forEach(details => {
    details.open = false;
  });

  const savedDetails = document.getElementById('timedSeriesDetails');
  const savedList = document.getElementById('timedMeasurements');
  if (!savedDetails || !savedList) return;

  let previousCount = savedList.children.length;

  const observer = new MutationObserver(() => {
    const currentCount = savedList.children.length;
    if (currentCount > previousCount) savedDetails.open = true;
    previousCount = currentCount;
  });

  observer.observe(savedList, { childList: true });
});
