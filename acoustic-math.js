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
    let lo = 0;
    let hi = centers.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (centers[mid] <= f) lo = mid;
      else hi = mid;
    }
    const f1 = centers[lo];
    const f2 = centers[hi];
    const t = (lf - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
    return get(f1) + (get(f2) - get(f1)) * t;
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


  function fftInPlace(real, imag) {
    const n = real.length;
    if (!n || n !== imag.length || (n & (n - 1)) !== 0) {
      throw new Error('FFT vyžaduje délku 2^n.');
    }

    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      const wLenR = Math.cos(angle);
      const wLenI = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let wr = 1;
        let wi = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j += 1) {
          const uR = real[i + j];
          const uI = imag[i + j];
          const vIndex = i + j + half;
          const vR = real[vIndex] * wr - imag[vIndex] * wi;
          const vI = real[vIndex] * wi + imag[vIndex] * wr;
          real[i + j] = uR + vR;
          imag[i + j] = uI + vI;
          real[vIndex] = uR - vR;
          imag[vIndex] = uI - vI;
          const nextWr = wr * wLenR - wi * wLenI;
          wi = wr * wLenI + wi * wLenR;
          wr = nextWr;
        }
      }
    }
  }

  function analyzeTimeBlock(samples, sampleRate, options = {}) {
    const input = samples instanceof Float32Array || samples instanceof Float64Array
      ? samples
      : Float32Array.from(samples || []);
    const n = input.length;
    const sr = Number(sampleRate);
    if (!(sr > 0) || n < 2 || (n & (n - 1)) !== 0) return null;

    const centers = Array.isArray(options.centers) && options.centers.length
      ? options.centers.map(Number).filter(Number.isFinite)
      : DEFAULT_OCTAVES;
    const calibration = options.calibration || {};
    const calibrationCenters = Array.isArray(options.calibrationCenters) && options.calibrationCenters.length
      ? options.calibrationCenters.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : centers;
    const analysisMaxHz = Number(options.analysisMaxHz) || 20000;
    const offsetDb = Number(options.offsetDb) || 0;

    let rawRmsPower = 0;
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = Number(input[i]) || 0;
      rawRmsPower += x * x;
      const window = n > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
      real[i] = x * window;
    }
    rawRmsPower /= n;

    fftInPlace(real, imag);

    const binHz = sr / n;
    const maxHz = Math.min(analysisMaxHz, sr / 2);
    let rawSpectrumPower = 0;
    const adjusted = { A: 0, C: 0, Z: 0 };
    const bandA = Object.fromEntries(centers.map(center => [center, 0]));
    const bandZ = Object.fromEntries(centers.map(center => [center, 0]));
    const coverage = Object.fromEntries(centers.map(center => [
      center,
      octaveFullyCovered(center, sr, analysisMaxHz)
    ]));

    const lastBin = Math.min((n >> 1) - 1, Math.floor(maxHz / binHz));
    for (let i = 1; i <= lastBin; i += 1) {
      const freq = i * binHz;
      if (freq < 20) continue;
      const p = real[i] * real[i] + imag[i] * imag[i];
      if (!(p > 0)) continue;

      rawSpectrumPower += p;
      const cal = calibrationDb(freq, calibration, calibrationCenters);
      const pZ = p * Math.pow(10, cal / 10);
      const pA = pZ * Math.pow(10, weightDb(freq, 'A') / 10);
      const pC = pZ * Math.pow(10, weightDb(freq, 'C') / 10);
      adjusted.Z += pZ;
      adjusted.A += pA;
      adjusted.C += pC;

      const center = octaveForFrequency(freq, centers);
      if (center !== null && coverage[center]) {
        bandZ[center] += pZ;
        bandA[center] += pA;
      }
    }

    if (!(rawSpectrumPower > 0) || !(rawRmsPower >= 0)) return null;

    const offsetFactor = Math.pow(10, offsetDb / 10);
    const powers = {};
    for (const type of ['A', 'C', 'Z']) {
      powers[type] = adjusted[type] > 0
        ? rawRmsPower * (adjusted[type] / rawSpectrumPower) * offsetFactor
        : 0;
    }

    const octavePowersA = {};
    const octavePowersZ = {};
    centers.forEach(center => {
      if (!coverage[center]) {
        octavePowersA[center] = null;
        octavePowersZ[center] = null;
        return;
      }
      octavePowersA[center] = adjusted.A > 0 && bandA[center] > 0
        ? powers.A * bandA[center] / adjusted.A
        : 0;
      octavePowersZ[center] = adjusted.Z > 0 && bandZ[center] > 0
        ? powers.Z * bandZ[center] / adjusted.Z
        : 0;
    });

    return {
      durationMs: n / sr * 1000,
      sampleRate: sr,
      fftSize: n,
      rawRmsPower,
      rawDbfs: powerToDb(rawRmsPower),
      powers,
      db: {
        A: powerToDb(powers.A),
        C: powerToDb(powers.C),
        Z: powerToDb(powers.Z)
      },
      octavePowersA,
      octavePowersZ,
      coverage
    };
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
    worstBackgroundPower,
    fftInPlace,
    analyzeTimeBlock
  });
})();
