/* Dayton iMM-6 / iMM-6C – import individuální frekvenční kalibrace. */
(() => {
  'use strict';

  const STORAGE_PROFILE = 'hlukomer.daytonMic.profile.v1';
  const STORAGE_ENABLED = 'hlukomer.daytonMic.enabled.v1';
  const $ = id => document.getElementById(id);

  let profile = readProfile();
  let enabled = localStorage.getItem(STORAGE_ENABLED) === '1';

  function safeNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function readProfile() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_PROFILE) || 'null');
      if (!parsed || !Array.isArray(parsed.points) || parsed.points.length < 2) return null;
      const points = parsed.points
        .map(point => [safeNumber(point?.[0]), safeNumber(point?.[1])])
        .filter(point => point[0] > 0 && point[1] !== null)
        .sort((a, b) => a[0] - b[0]);
      if (points.length < 2) return null;
      return {
        format: 'dayton-imm-calibration',
        version: 1,
        serial: String(parsed.serial || '').trim(),
        fileName: String(parsed.fileName || '').trim(),
        sensitivity1000HzDb: safeNumber(parsed.sensitivity1000HzDb),
        importedAt: parsed.importedAt || null,
        points
      };
    } catch (_) {
      return null;
    }
  }

  function inferSerial(fileName) {
    const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
    return /^[A-Z]{2,5}\d{3,}$/i.test(base) ? base.toUpperCase() : '';
  }

  function parseDaytonText(text, fileName = '') {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    let sensitivity1000HzDb = null;
    const points = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const sensitivityMatch = line.match(/^\*\s*1000\s*Hz\s*(?:[:=]\s*)?([-+]?\d+(?:[.,]\d+)?)/i);
      if (sensitivityMatch) {
        sensitivity1000HzDb = Number(sensitivityMatch[1].replace(',', '.'));
        continue;
      }

      if (line.startsWith('*') || line.startsWith('#') || line.startsWith(';')) continue;
      const match = line.match(/^([-+]?\d+(?:[.,]\d+)?)\s+([-+]?\d+(?:[.,]\d+)?)/);
      if (!match) continue;

      const freq = Number(match[1].replace(',', '.'));
      const correctionDb = Number(match[2].replace(',', '.'));
      if (Number.isFinite(freq) && freq > 0 && Number.isFinite(correctionDb)) {
        points.push([freq, correctionDb]);
      }
    }

    points.sort((a, b) => a[0] - b[0]);
    const unique = [];
    for (const point of points) {
      const last = unique[unique.length - 1];
      if (last && Math.abs(last[0] - point[0]) < 1e-9) last[1] = point[1];
      else unique.push(point);
    }

    if (unique.length < 20) {
      throw new Error('Soubor neobsahuje dostatek kalibračních bodů Dayton.');
    }
    if (unique[0][0] > 31.5 || unique[unique.length - 1][0] < 16000) {
      throw new Error('Kalibrační soubor nepokrývá dostatečný frekvenční rozsah.');
    }

    return {
      format: 'dayton-imm-calibration',
      version: 1,
      serial: inferSerial(fileName),
      fileName: String(fileName || ''),
      sensitivity1000HzDb: Number.isFinite(sensitivity1000HzDb) ? sensitivity1000HzDb : null,
      importedAt: new Date().toISOString(),
      points: unique
    };
  }

  function persistProfile(nextProfile) {
    profile = nextProfile;
    if (profile) localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
    else localStorage.removeItem(STORAGE_PROFILE);
  }

  function measurementRunning() {
    const transportStop = $('transportStopBtn');
    const nativeStop = $('stopBtn');
    return Boolean((transportStop && !transportStop.disabled) || (nativeStop && !nativeStop.disabled));
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    localStorage.setItem(STORAGE_ENABLED, enabled ? '1' : '0');
    render();
    window.dispatchEvent(new CustomEvent('hlukomer-dayton-calibration-change', {
      detail: { enabled, hasProfile: Boolean(profile) }
    }));
  }

  function isActive() {
    return enabled && Boolean(profile?.points?.length);
  }

  function correctionDb(freq) {
    if (!isActive()) return null;
    const f = Number(freq);
    const points = profile.points;
    if (!(f > 0) || !points.length) return 0;
    if (f <= points[0][0]) return points[0][1];
    if (f >= points[points.length - 1][0]) return points[points.length - 1][1];

    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid][0] <= f) lo = mid;
      else hi = mid;
    }

    const [f1, c1] = points[lo];
    const [f2, c2] = points[hi];
    const t = (Math.log(f) - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
    return c1 + (c2 - c1) * t;
  }

  function getActiveCalibration() {
    if (!isActive()) return null;
    const values = {};
    const centers = [];
    for (const [freq, correction] of profile.points) {
      centers.push(freq);
      values[freq] = correction;
    }
    return {
      source: 'dayton',
      serial: profile.serial || null,
      fileName: profile.fileName || null,
      sensitivity1000HzDb: profile.sensitivity1000HzDb,
      centers,
      values
    };
  }

  function formatFrequency(freq) {
    if (freq >= 1000) return `${Number((freq / 1000).toFixed(1))} kHz`;
    return `${Number(freq.toFixed(1))} Hz`;
  }

  function ensureUi() {
    if ($('daytonMicDetails')) return;

    const technical = $('micProcessingStatus')?.closest('details');
    if (!technical) return;

    const details = document.createElement('details');
    details.id = 'daytonMicDetails';
    details.innerHTML = `
      <summary>Referenční mikrofon Dayton</summary>
      <div class="detailbody">
        <label class="check"><input type="checkbox" id="daytonMicEnabled"> Používám Dayton iMM-6 / iMM-6C</label>
        <div id="daytonMicPanel" class="daytonMicPanel" hidden>
          <div id="daytonMicStatus" class="daytonMicStatus"></div>
          <div class="row">
            <button type="button" id="daytonMicLoadBtn">Nahrát kalibrační soubor</button>
            <button type="button" id="daytonMicRemoveBtn" class="danger" hidden>Odstranit profil</button>
          </div>
          <input type="file" id="daytonMicFile" accept=".txt,text/plain" hidden>
          <div class="calSmall">Použije se kompletní frekvenční křivka z individuálního souboru Dayton. Citlivost při 1 kHz se zatím nepoužívá pro absolutní SPL.</div>
        </div>
      </div>`;

    technical.insertAdjacentElement('beforebegin', details);

    if (!$('daytonMicStyles')) {
      const style = document.createElement('style');
      style.id = 'daytonMicStyles';
      style.textContent = `
        .daytonMicPanel{display:grid;gap:9px}
        .daytonMicStatus{padding:9px 10px;border:1px solid var(--line);background:var(--card2);border-radius:11px;font-size:12px;line-height:1.45;color:var(--muted)}
        .daytonMicStatus.good{border-color:#245f49;background:#123329;color:#b8f3d5}
        .daytonMicStatus.warn{border-color:#756020;background:#3a3015;color:#f8e7a1}
      `;
      document.head.appendChild(style);
    }

    $('daytonMicEnabled')?.addEventListener('change', event => {
      if (measurementRunning()) {
        event.target.checked = enabled;
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      setEnabled(Boolean(event.target.checked));
    });

    $('daytonMicLoadBtn')?.addEventListener('click', () => {
      if (measurementRunning()) {
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      $('daytonMicFile')?.click();
    });

    $('daytonMicFile')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseDaytonText(text, file.name);
        persistProfile(parsed);
        setEnabled(true);
      } catch (error) {
        alert(error?.message || 'Kalibrační soubor se nepodařilo načíst.');
        render();
      }
    });

    $('daytonMicRemoveBtn')?.addEventListener('click', () => {
      if (measurementRunning()) {
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      if (!confirm('Odstranit uložený Dayton kalibrační profil?')) return;
      persistProfile(null);
      setEnabled(false);
    });

    render();
  }

  function render() {
    ensureUi();
    const check = $('daytonMicEnabled');
    const panel = $('daytonMicPanel');
    const status = $('daytonMicStatus');
    const remove = $('daytonMicRemoveBtn');
    if (!check || !panel || !status || !remove) return;

    check.checked = enabled;
    panel.hidden = !enabled;
    remove.hidden = !profile;

    status.className = 'daytonMicStatus';
    if (!enabled) {
      status.textContent = '';
      return;
    }

    if (!profile) {
      status.classList.add('warn');
      status.textContent = 'Nahrajte individuální kalibrační TXT soubor vašeho mikrofonu Dayton.';
      return;
    }

    const first = profile.points[0][0];
    const last = profile.points[profile.points.length - 1][0];
    const identity = profile.serial || profile.fileName || 'Dayton iMM';
    const sensitivity = Number.isFinite(profile.sensitivity1000HzDb)
      ? ` · citlivost 1 kHz ${profile.sensitivity1000HzDb.toFixed(1).replace('.', ',')} dB`
      : '';
    status.classList.add('good');
    status.textContent = `${identity} · ${profile.points.length} bodů · ${formatFrequency(first)}–${formatFrequency(last)}${sensitivity} · frekvenční korekce aktivní`;
  }

  window.HLUKOMER_DAYTON = Object.freeze({
    parseDaytonText,
    getProfile: () => profile ? JSON.parse(JSON.stringify(profile)) : null,
    getActiveCalibration,
    isEnabled: () => enabled,
    isActive,
    correctionDb,
    setEnabled
  });

  ensureUi();
  window.addEventListener('DOMContentLoaded', ensureUi);
})();
