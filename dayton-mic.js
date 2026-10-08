/* Dayton iMM-6 / iMM-6C – import individuální frekvenční kalibrace a výběr vstupu. */
(() => {
  'use strict';

  const STORAGE_PROFILE = 'hlukomer.daytonMic.profile.v1';
  const STORAGE_ENABLED = 'hlukomer.daytonMic.enabled.v1';
  const STORAGE_DEVICE_ID = 'hlukomer.daytonMic.deviceId.v1';
  const STORAGE_DEVICE_LABEL = 'hlukomer.daytonMic.deviceLabel.v1';
  const $ = id => document.getElementById(id);

  let profile = readProfile();
  let enabled = localStorage.getItem(STORAGE_ENABLED) === '1';
  let selectedDeviceId = localStorage.getItem(STORAGE_DEVICE_ID) || '';
  let selectedDeviceLabel = localStorage.getItem(STORAGE_DEVICE_LABEL) || '';
  let availableInputs = [];
  let activeTrackInfo = null;

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

  function persistDevice(deviceId, label) {
    selectedDeviceId = String(deviceId || '');
    selectedDeviceLabel = String(label || '');
    if (selectedDeviceId) localStorage.setItem(STORAGE_DEVICE_ID, selectedDeviceId);
    else localStorage.removeItem(STORAGE_DEVICE_ID);
    if (selectedDeviceLabel) localStorage.setItem(STORAGE_DEVICE_LABEL, selectedDeviceLabel);
    else localStorage.removeItem(STORAGE_DEVICE_LABEL);
    activeTrackInfo = null;
  }

  function measurementRunning() {
    const transportStop = $('transportStopBtn');
    const nativeStop = $('stopBtn');
    return Boolean((transportStop && !transportStop.disabled) || (nativeStop && !nativeStop.disabled));
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    localStorage.setItem(STORAGE_ENABLED, enabled ? '1' : '0');
    activeTrackInfo = null;
    render();
    window.dispatchEvent(new CustomEvent('hlukomer-dayton-calibration-change', {
      detail: { enabled, hasProfile: Boolean(profile), deviceId: selectedDeviceId || null }
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

  function baseAudioConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    };
  }

  function validateBeforeStart() {
    if (!isActive()) return { ok: true };
    if (!selectedDeviceId) {
      return {
        ok: false,
        message: 'Je zapnutý referenční mikrofon Dayton, ale není vybraný zvukový vstup. Otevřete „Referenční mikrofon Dayton“, načtěte dostupné mikrofony a vyberte Dayton.'
      };
    }
    return { ok: true };
  }

  function getAudioConstraints() {
    const constraints = baseAudioConstraints();
    if (isActive() && selectedDeviceId) constraints.deviceId = { exact: selectedDeviceId };
    return constraints;
  }

  function selectedDevice() {
    return availableInputs.find(device => device.deviceId === selectedDeviceId) || null;
  }

  function deviceDisplayName(device, index = 0) {
    const label = String(device?.label || '').trim();
    return label || `Mikrofon ${index + 1}`;
  }

  async function enumerateAudioInputs(requestPermission = false) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error('Tento prohlížeč neumí vypsat dostupné mikrofony.');
    }
    if (measurementRunning()) {
      throw new Error('Nejdřív ukončete probíhající měření.');
    }

    let permissionStream = null;
    try {
      if (requestPermission && navigator.mediaDevices?.getUserMedia) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: baseAudioConstraints() });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableInputs = devices.filter(device => device.kind === 'audioinput');

      if (selectedDeviceId && !availableInputs.some(device => device.deviceId === selectedDeviceId) && selectedDeviceLabel) {
        const byLabel = availableInputs.find(device => device.label && device.label === selectedDeviceLabel);
        if (byLabel) persistDevice(byLabel.deviceId, byLabel.label);
      }

      renderDeviceOptions();
      render();
      return availableInputs.slice();
    } finally {
      permissionStream?.getTracks?.().forEach(track => track.stop());
    }
  }

  function renderDeviceOptions() {
    const select = $('daytonMicDevice');
    if (!select) return;

    const currentId = selectedDeviceId;
    select.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = availableInputs.length
      ? 'Vyberte mikrofon…'
      : 'Nejdřív načtěte mikrofony';
    select.appendChild(placeholder);

    availableInputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = deviceDisplayName(device, index);
      select.appendChild(option);
    });

    if (currentId && availableInputs.some(device => device.deviceId === currentId)) {
      select.value = currentId;
    } else {
      select.value = '';
    }
  }

  function reportActiveTrack(track) {
    if (!isActive()) {
      activeTrackInfo = null;
      render();
      return { ok: true };
    }

    let settings = {};
    try { settings = typeof track?.getSettings === 'function' ? track.getSettings() : {}; }
    catch (_) { settings = {}; }

    const actualId = String(settings.deviceId || '');
    const label = String(track?.label || '').trim() || 'Neznámý mikrofon';
    const idConfirmed = Boolean(actualId && selectedDeviceId);
    const matches = !idConfirmed || actualId === selectedDeviceId;

    activeTrackInfo = {
      label,
      actualId,
      matches,
      idConfirmed
    };
    render();

    return {
      ok: matches,
      label,
      message: matches
        ? null
        : 'Prohlížeč spustil jiný mikrofon, než který je vybraný v nastavení Dayton.'
    };
  }

  function clearActiveTrack() {
    activeTrackInfo = null;
    render();
  }

  function renderProfileStatus() {
    const status = $('daytonMicStatus');
    const remove = $('daytonMicRemoveBtn');
    if (!status || !remove) return;

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

  function renderDeviceStatus() {
    const status = $('daytonMicDeviceStatus');
    if (!status) return;
    status.className = 'daytonMicDeviceStatus';

    if (!enabled) {
      status.textContent = '';
      return;
    }

    if (!selectedDeviceId) {
      status.classList.add('warn');
      status.textContent = 'Zvukový vstup ještě není vybraný.';
      return;
    }

    if (activeTrackInfo) {
      if (!activeTrackInfo.matches) {
        status.classList.add('bad');
        status.textContent = `✕ Aktivní vstup: ${activeTrackInfo.label} · neodpovídá vybranému mikrofonu`;
        return;
      }
      status.classList.add(activeTrackInfo.idConfirmed ? 'good' : 'warn');
      status.textContent = activeTrackInfo.idConfirmed
        ? `✓ Aktivní vstup ověřen: ${activeTrackInfo.label}`
        : `Aktivní vstup: ${activeTrackInfo.label} · prohlížeč neposkytl ID pro úplné ověření`;
      return;
    }

    const device = selectedDevice();
    const label = device ? deviceDisplayName(device, availableInputs.indexOf(device)) : (selectedDeviceLabel || 'vybraný mikrofon');
    status.classList.add('ready');
    status.textContent = `Vybráno: ${label} · ověří se při spuštění měření`;
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

          <div class="daytonDeviceBlock">
            <label for="daytonMicDevice">Používaný mikrofon</label>
            <select id="daytonMicDevice"><option value="">Nejdřív načtěte mikrofony</option></select>
            <button type="button" id="daytonMicRefreshBtn">Načíst dostupné mikrofony</button>
            <div id="daytonMicDeviceStatus" class="daytonMicDeviceStatus"></div>
          </div>

          <div class="row">
            <button type="button" id="daytonMicLoadBtn">Nahrát kalibrační soubor</button>
            <button type="button" id="daytonMicRemoveBtn" class="danger" hidden>Odstranit profil</button>
          </div>
          <input type="file" id="daytonMicFile" accept=".txt,text/plain" hidden>
          <div class="calSmall">Při aktivním Dayton profilu aplikace použije pouze vybraný mikrofon. Pokud vybraný vstup není dostupný, měření se nespustí. Citlivost při 1 kHz se zatím nepoužívá pro absolutní SPL.</div>
        </div>
      </div>`;

    technical.insertAdjacentElement('beforebegin', details);

    if (!$('daytonMicStyles')) {
      const style = document.createElement('style');
      style.id = 'daytonMicStyles';
      style.textContent = `
        .daytonMicPanel{display:grid;gap:10px}
        .daytonMicStatus,.daytonMicDeviceStatus{padding:9px 10px;border:1px solid var(--line);background:var(--card2);border-radius:11px;font-size:12px;line-height:1.45;color:var(--muted)}
        .daytonMicStatus.good,.daytonMicDeviceStatus.good{border-color:#245f49;background:#123329;color:#b8f3d5}
        .daytonMicStatus.warn,.daytonMicDeviceStatus.warn{border-color:#756020;background:#3a3015;color:#f8e7a1}
        .daytonMicDeviceStatus.bad{border-color:#743645;background:#3a2029;color:#ffd2d9}
        .daytonMicDeviceStatus.ready{border-color:#33506a;background:#102538;color:#c8e9f7}
        .daytonDeviceBlock{display:grid;gap:7px;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0d1725}
        .daytonDeviceBlock>label{font-size:11px;color:var(--muted);font-weight:750}
        .daytonDeviceBlock select,.daytonDeviceBlock button{width:100%}
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

    $('daytonMicRefreshBtn')?.addEventListener('click', async event => {
      if (measurementRunning()) {
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      const button = event.currentTarget;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = 'Načítám…';
      try {
        await enumerateAudioInputs(true);
        if (!availableInputs.length) alert('Prohlížeč nenašel žádný mikrofonní vstup.');
      } catch (error) {
        alert(error?.message || 'Mikrofony se nepodařilo načíst.');
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    });

    $('daytonMicDevice')?.addEventListener('change', event => {
      if (measurementRunning()) {
        renderDeviceOptions();
        alert('Nejdřív ukončete probíhající měření.');
        return;
      }
      const device = availableInputs.find(item => item.deviceId === event.target.value);
      persistDevice(device?.deviceId || '', device?.label || '');
      render();
      window.dispatchEvent(new CustomEvent('hlukomer-dayton-device-change', {
        detail: { deviceId: selectedDeviceId || null, label: selectedDeviceLabel || null }
      }));
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
    enumerateAudioInputs(false).catch(() => {});
  }

  function render() {
    ensureUi();
    const check = $('daytonMicEnabled');
    const panel = $('daytonMicPanel');
    if (!check || !panel) return;

    check.checked = enabled;
    panel.hidden = !enabled;
    renderDeviceOptions();
    renderProfileStatus();
    renderDeviceStatus();
  }

  window.HLUKOMER_DAYTON = Object.freeze({
    parseDaytonText,
    getProfile: () => profile ? JSON.parse(JSON.stringify(profile)) : null,
    getActiveCalibration,
    isEnabled: () => enabled,
    isActive,
    correctionDb,
    setEnabled,
    enumerateAudioInputs,
    getSelectedDevice: () => ({
      deviceId: selectedDeviceId || null,
      label: selectedDeviceLabel || null
    }),
    validateBeforeStart,
    getAudioConstraints,
    reportActiveTrack,
    clearActiveTrack
  });

  ensureUi();
  window.addEventListener('DOMContentLoaded', ensureUi);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!measurementRunning()) enumerateAudioInputs(false).catch(() => {});
  });
})();
