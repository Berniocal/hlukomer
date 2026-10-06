/* Sdílené akustické výpočty pro Hlukoměr i syntetické testy. */
(() => {
  'use strict';

  const DEFAULT_OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const OCTAVE_FACTOR = Math.SQRT2;

  function dbToPower(db) {
    const value = Number(db);
    return Number.isFinite(value) ? Math.pow(10, value / 10) : 0;
  }

  function powerToDb(power) {
    const value = Number(power);
    return value > 0 ? 10 * Math.log10(value) : -Infinity;
  }

  function leqFromEnergy(energy, duration) {
    const e = Number(energy);
    const t = Number(duration);
    return e > 0 && t > 0 ? powerToDb(e / t) : NaN;
  }

  function leqFromDbDurations(segments) {
    let energy = 0;
    let duration = 0;
    for (const segment of segments || []) {
      const db = Number(segment?.db);
      const dt = Number(segment?.duration);
      if (!Number.isFinite(db) || !(dt > 0)) continue;
      energy += dbToPower(db) * dt;
      duration += dt;
    }
    return leqFromEnergy(energy, duration);
  }

  function energyAverageDb(values) {
    const valid = (values || []).filter(Number.isFinite);
    if (!valid.length) return NaN;
    return powerToDb(valid.reduce((sum, db) => sum + dbToPower(db), 0) / valid.length);
  }

  function weightDb(freq, type) {
    const f = Number(freq);
    if (!(f > 0)) return -120;
    if (type === 'Z') return 0;
    const f2 = f * f;
    const c12200 = 12200 * 12200;
    if (type === 'C') {
      const rc = (c12200 * f2) / ((f2 + 20.6 * 20.6) * (f2 + c12200));
      return 20 * Math.log10(Math.max(rc, 1e-20)) + 0.06;
    }
    const num = c12200 * f2 * f2;
    const den = (f2 + 20.6 * 20.6)
      * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
      * (f2 + c12200);
    return 20 * Math.log10(Math.max(num / den, 1e-20)) + 2.0;
  }

  function calibrationDb(freq, calibration, centers = DEFAULT_OCTAVES) {
    const f = Number(freq);
    if (!(f > 0) || !Array.isArray(centers) || !centers.length) return 0;
    const get = center => {
      const value = Number(calibration?.[center] ?? calibration?.[String(center)]);
      return Number.isFinite(value) ? value : 0;
    };
    if (f <= centers[0]) return get(centers[0]);
    if (f >= centers[centers.length - 1]) return get(centers[centers.length - 1]);

    const lf = Math.log(f);
    for (let i = 0; i < centers.length - 1; i += 1) {
      const f1 = centers[i];
      const f2 = centers[i + 1];
      if (f >= f1 && f <= f2) {
        const t = (lf - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
        return get(f1) + (get(f2) - get(f1)) * t;
      }
    }
    return 0;
  }

  function octaveBounds(center) {
    const c = Number(center);
    return { low: c / OCTAVE_FACTOR, high: c * OCTAVE_FACTOR };
  }

  function isFrequencyInOctave(freq, center) {
    const f = Number(freq);
    const { low, high } = octaveBounds(center);
    return f >= low && f < high;
  }

  function octaveForFrequency(freq, centers = DEFAULT_OCTAVES) {
    for (const center of centers) {
      if (isFrequencyInOctave(freq, center)) return center;
    }
    return null;
  }

  function octaveFullyCovered(center, sampleRate, analysisMaxHz = 20000) {
    const nyquist = Number(sampleRate) / 2;
    if (!(nyquist > 0)) return false;
    const maxHz = Math.min(nyquist, Number(analysisMaxHz) || nyquist);
    return octaveBounds(center).high <= maxHz;
  }

  function sourcePowerFromTotalAndBackground(totalPower, backgroundPower) {
    const total = Number(totalPower);
    const bg = Number(backgroundPower);
    if (!(total > 0) || !(bg >= 0)) return 0;
    return Math.max(0, total - bg);
  }

  function signalToNoiseSnr(totalPower, backgroundPower) {
    const bg = Number(backgroundPower);
    const source = sourcePowerFromTotalAndBackground(totalPower, backgroundPower);
    if (!(source > 0) || !(bg > 0)) return -Infinity;
    return powerToDb(source / bg);
  }

  function classifySnr(snr) {
    const value = Number(snr);
    if (value >= 20) return { level: 'good', label: 'vhodné' };
    if (value >= 15) return { level: 'warn', label: 'hraniční' };
    return { level: 'bad', label: 'nepoužít' };
  }

  function worstBackgroundPower(beforePower, afterPower) {
    return Math.max(Number(beforePower) || 0, Number(afterPower) || 0);
  }

  window.HLUKOMER_MATH = Object.freeze({
    DEFAULT_OCTAVES,
    OCTAVE_FACTOR,
    dbToPower,
    powerToDb,
    leqFromEnergy,
    leqFromDbDurations,
    energyAverageDb,
    weightDb,
    calibrationDb,
    octaveBounds,
    isFrequencyInOctave,
    octaveForFrequency,
    octaveFullyCovered,
    sourcePowerFromTotalAndBackground,
    signalToNoiseSnr,
    classifySnr,
    worstBackgroundPower
  });
})();
