(() => {
  'use strict';

  const TRACK = {
    id: 'bernio-calibration-track-v1',
    wav: 'calibration/bernio_kalibrace_v1.wav',
    mp3: 'calibration/bernio_kalibrace_v1.mp3',
    durationSec: 150,
    chirpTimesSec: [5, 8, 11],
    chirpDurationSec: 0.03,
    chirpRangeHz: [250, 8000],
    background: [14, 44],
    pink: [45, 105],
    white: [115, 145]
  };

  const ROOM_KEY = 'hlukomer.roomAcousticsTest.v1';
  const $ = id => document.getElementById(id);

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
      sx += x; sy += y; sxx += x * x; sxy += x * y;
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
    for (const c of candidates) {
      if (selected.every(x => Math.abs(x.start - c.start) >= minGap)) {
        selected.push(c);
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
      const v = Math.abs(samples[i]);
      if (v > peakAbs) { peakAbs = v; peak = i; }
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

  function classify(rt, reflectionDb) {
    const reverb = rt <= 0.5 ? ['good', 'vhodný'] : rt <= 0.8 ? ['warn', 'zvýšený'] : ['bad', 'nevhodný'];
    const reflections = reflectionDb <= -12 ? ['good', 'malé'] : reflectionDb <= -6 ? ['warn', 'zvýšené'] : ['bad', 'silné'];
    let overall = 'good';
    if (reverb[0] === 'bad' || reflections[0] === 'bad') overall = 'bad';
    else if (reverb[0] === 'warn' || reflections[0] === 'warn') overall = 'warn';
    return { reverb, reflections, overall };
  }

  function render(result) {
    if (typeof window.hlukomerRenderRoomResult === 'function') {
      window.hlukomerRenderRoomResult(result);
      return;
    }
    const classified = classify(Number(result.rt60Sec), Number(result.earlyReflectionDb));
    const results = $('roomTestResults');
    if (!results) return;
    results.hidden = false;
    $('roomReverbMetric').className = `roomMetric ${classified.reverb[0]}`;
    $('roomReflectionMetric').className = `roomMetric ${classified.reflections[0]}`;
    $('roomReverbStatus').textContent = classified.reverb[1];
    $('roomReflectionStatus').textContent = classified.reflections[1];
    $('roomReverbValue').textContent = `RT ≈ ${Number(result.rt60Sec).toFixed(2)} s`;
    $('roomReflectionValue').textContent = `časný odraz ≈ ${Number(result.earlyReflectionDb).toFixed(1)} dB`;
  }

  async function runTrackRoomTest() {
    const button = $('roomTestBtn');
    const message = $('roomTestMessage');
    const progress = $('roomTestProgress');
    if (!button || !message || !progress) return;

    const transportStop = $('transportStopBtn');
    const nativeStop = $('stopBtn');
    if ((transportStop && !transportStop.disabled) || (nativeStop && !nativeStop.disabled)) {
      alert('Nejdřív ukončete běžné měření hluku.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Tento prohlížeč neumí zpřístupnit mikrofon pro test místnosti.');
      return;
    }

    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = 'Čekám na 3 signály…';
    message.textContent = 'Teď spusťte kalibrační nahrávku na reproduktoru. Telefon čeká na tři krátké měřicí chirpy.';
    progress.textContent = 'Rozpoznáno: 0 / 3';

    let stream = null, context = null, source = null, processor = null, silentGain = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }});
      const Ctx = window.AudioContext || window.webkitAudioContext;
      context = new Ctx();
      await context.resume();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(1024, 1, 1);
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      const chunks = [];
      let totalLength = 0;
      let baseline = [];
      let liveCount = 0;
      let lastHit = -Infinity;
      const started = performance.now();

      processor.onaudioprocess = event => {
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input);
        chunks.push(copy);
        totalLength += copy.length;

        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        const currentRms = Math.sqrt(sum / Math.max(1, input.length));
        const elapsed = (performance.now() - started) / 1000;
        if (elapsed < 2.5) baseline.push(currentRms);
        const base = median(baseline) || 0.001;
        if (elapsed > 2 && currentRms > Math.max(base * 7, 0.008) && elapsed - lastHit > 1.7) {
          liveCount = Math.min(3, liveCount + 1);
          lastHit = elapsed;
          progress.textContent = `Rozpoznáno: ${liveCount} / 3 ${'✓'.repeat(liveCount)}`;
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);

      const maxSec = 16;
      await new Promise(resolve => setTimeout(resolve, maxSec * 1000));
      processor.onaudioprocess = null;

      const samples = new Float32Array(totalLength);
      let offset = 0;
      for (const c of chunks) { samples.set(c, offset); offset += c.length; }

      message.textContent = 'Vyhodnocuji dozvuk a časné odrazy…';
      progress.textContent = 'Analyzuji 3 signály';
      const chirps = detectChirps(samples, context.sampleRate);
      if (chirps.length < 3) throw new Error('Nepodařilo se rozpoznat všechny 3 měřicí signály. Spusťte test znovu a kalibrační nahrávku spusťte až po stisku tlačítka na telefonu.');
      const analyzed = chirps.map(c => analyzeChirp(samples, context.sampleRate, c.start)).filter(Boolean);
      if (analyzed.length < 2) throw new Error('Měřicí signály nebyly dostatečně zřetelné proti hluku pozadí. Zkuste test znovu v tišší místnosti.');

      const rt = median(analyzed.map(x => x.rt60Sec));
      const reflection = median(analyzed.map(x => x.earlyReflectionDb));
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
      render(result);
      message.textContent = 'Test místnosti dokončen. Pokud je dozvuk i odrazy v pořádku, můžete pokračovat měřením hluku pozadí.';
      progress.textContent = '3 / 3 ✓';
    } catch (error) {
      message.textContent = error?.message || 'Test místnosti se nepodařilo dokončit.';
      progress.textContent = 'Zkuste test zopakovat.';
    } finally {
      try { source?.disconnect(); } catch (_) {}
      try { processor?.disconnect(); } catch (_) {}
      try { silentGain?.disconnect(); } catch (_) {}
      stream?.getTracks().forEach(t => t.stop());
      if (context && context.state !== 'closed') { try { await context.close(); } catch (_) {} }
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function ensureStyles() {
    if ($('calibrationTrackStyles')) return;
    const style = document.createElement('style');
    style.id = 'calibrationTrackStyles';
    style.textContent = `
      .calTrackCard{display:grid;gap:9px;padding:10px;border:1px solid #33506a;background:#102538;border-radius:12px}
      .calTrackTitle{font-size:12px;font-weight:850}
      .calTrackDownloads{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      .calTrackDownload{display:flex;flex-direction:column;gap:2px;text-decoration:none;border:1px solid var(--line);background:#152236;color:var(--text);border-radius:11px;padding:9px 10px;font-size:12px;font-weight:800}
      .calTrackDownload.recommended{border-color:#1f7aa4;background:#123d58}
      .calTrackDownload small{font-size:10px;font-weight:600;color:var(--muted)}
      .calTrackTimeline{font-size:10px;line-height:1.5;color:var(--muted)}
      @media(max-width:560px){.calTrackDownloads{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureTrackUi() {
    ensureStyles();
    const details = $('referenceCalibrationPreview');
    const body = details?.querySelector('.detailbody');
    if (!body || $('calibrationTrackCard')) return;

    const card = document.createElement('div');
    card.id = 'calibrationTrackCard';
    card.className = 'calTrackCard';
    card.innerHTML = `
      <div class="calTrackTitle">Kalibrační nahrávka · Bernio v1</div>
      <div class="calSmall">Pro měření místnosti je <strong>WAV doporučený</strong>, protože lépe zachová krátké měřicí signály a jejich odrazy. Pokud váš reproduktor WAV nepřehraje, použijte MP3.</div>
      <div class="calTrackDownloads">
        <a class="calTrackDownload recommended" href="${TRACK.wav}" download>Stáhnout WAV · doporučeno<small>nejlepší pro dozvuk a odrazy</small></a>
        <a class="calTrackDownload" href="${TRACK.mp3}" download>Stáhnout MP3<small>použijte, pokud WAV reproduktor nepřehraje</small></a>
      </div>
      <div class="calTrackTimeline">2:30 min · 3 měřicí chirpy → ticho pro pozadí → růžový šum pro kalibraci → bílý šum pro kontrolu.</div>`;

    const room = $('roomAcousticsTest');
    if (room) room.insertAdjacentElement('beforebegin', card);
    else body.prepend(card);
  }

  function convertRoomTestUi() {
    const card = $('roomAcousticsTest');
    const oldBtn = $('roomTestBtn');
    if (!card || !oldBtn || oldBtn.dataset.trackMode === '1') return;
    const title = card.querySelector('.roomTestTitle');
    if (title) title.textContent = 'Test místnosti · 3 měřicí chirpy';
    const message = $('roomTestMessage');
    if (message) message.textContent = 'Telefon nechte na místě měření a reproduktor 1,50 m od něj. Nejdřív spusťte test na telefonu a potom kalibrační nahrávku na reproduktoru. Telefon sám rozpozná 3 krátké měřicí signály.';
    const note = card.querySelector('.calSmall');
    if (note) note.textContent = 'Test vyhodnotí dobu dozvuku i silné časné odrazy. Pracovní hranice: do 0,5 s vhodný dozvuk, 0,5–0,8 s zvýšený, nad 0,8 s nevhodný.';

    const btn = oldBtn.cloneNode(true);
    btn.dataset.trackMode = '1';
    btn.textContent = 'Spustit test místnosti';
    oldBtn.replaceWith(btn);
    btn.addEventListener('click', runTrackRoomTest);
  }

  function init() {
    ensureTrackUi();
    convertRoomTestUi();
  }

  init();
  window.addEventListener('DOMContentLoaded', init);
})();
