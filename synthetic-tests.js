(() => {
  'use strict';

  const M = window.HLUKOMER_MATH;
  const $ = id => document.getElementById(id);

  function close(actual, expected, tolerance = 1e-6) {
    return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  }

  function fmt(v, digits = 3) {
    return Number.isFinite(v) ? Number(v).toFixed(digits).replace('.', ',') : String(v);
  }

  function runTests() {
    const tests = [];
    const add = (name, actual, expected, pass, note = '') => {
      tests.push({ name, actual, expected, pass: Boolean(pass), note });
    };

    const roundtrip = M.powerToDb(M.dbToPower(73.2));
    add('Převod dB → energie → dB', roundtrip, 73.2, close(roundtrip, 73.2, 1e-10));

    const constantLeq = M.leqFromDbDurations([{ db: 60, duration: 10 }]);
    add('Leq konstantních 60 dB po 10 s', constantLeq, 60, close(constantLeq, 60, 1e-10));

    const mixedLeq = M.leqFromDbDurations([{ db: 60, duration: 5 }, { db: 70, duration: 5 }]);
    const mixedExpected = 10 * Math.log10((Math.pow(10, 6) + Math.pow(10, 7)) / 2);
    add('Leq: 5 s 60 dB + 5 s 70 dB', mixedLeq, mixedExpected, close(mixedLeq, mixedExpected, 1e-10), 'Musí vyjít ≈ 67,40 dB, ne 65 dB.');

    const equalSum = M.powerToDb(M.dbToPower(60) + M.dbToPower(60));
    add('Součet dvou stejně silných nezávislých složek', equalSum, 63.0103, close(equalSum, 63.0103, 0.001), 'Očekávaný nárůst je +3,01 dB.');

    const impulseLeq = M.leqFromDbDurations([{ db: 40, duration: 999 }, { db: 100, duration: 1 }]);
    const impulseExpected = 10 * Math.log10((999 * Math.pow(10, 4) + 1 * Math.pow(10, 10)) / 1000);
    add('Krátký impuls 1 ms se v Leq neztratí', impulseLeq, impulseExpected, close(impulseLeq, impulseExpected, 1e-10));

    const a1k = M.weightDb(1000, 'A');
    add('A-vážení při 1 kHz', a1k, 0, Math.abs(a1k) < 0.05, '1 kHz má být prakticky 0 dB.');

    const c1k = M.weightDb(1000, 'C');
    add('C-vážení při 1 kHz', c1k, 0, Math.abs(c1k) < 0.05, '1 kHz má být prakticky 0 dB.');

    const a100 = M.weightDb(100, 'A');
    add('A-vážení při 100 Hz', a100, -19.1, close(a100, -19.1, 0.25));

    const cal = { 500: 0, 1000: 2, 2000: 4 };
    const calExact = M.calibrationDb(1000, cal, [500, 1000, 2000]);
    add('Frekvenční korekce v kalibračním bodě', calExact, 2, close(calExact, 2, 1e-10));

    const calMid = M.calibrationDb(1414.213562, cal, [500, 1000, 2000]);
    add('Logaritmická interpolace korekce mezi 1 a 2 kHz', calMid, 3, close(calMid, 3, 0.001));

    const octave1k = M.octaveForFrequency(1000, [125,250,500,1000,2000,4000]);
    add('1 kHz patří do oktávy 1 kHz', octave1k, 1000, octave1k === 1000);

    const boundary = 1000 * Math.SQRT2;
    const boundaryBand = M.octaveForFrequency(boundary, [500,1000,2000,4000]);
    add('Hraniční frekvence se nezařadí dvakrát', boundaryBand, 2000, boundaryBand === 2000, 'Horní mez nižší oktávy je otevřená, dolní mez vyšší uzavřená.');

    const bg = 1;
    const total20 = bg + bg * 100;
    const snr20 = M.signalToNoiseSnr(total20, bg);
    add('SNR 20 dB po energetickém odečtu pozadí', snr20, 20, close(snr20, 20, 1e-10));

    const total15 = bg + bg * Math.pow(10, 15/10);
    const snr15 = M.signalToNoiseSnr(total15, bg);
    add('SNR 15 dB po energetickém odečtu pozadí', snr15, 15, close(snr15, 15, 1e-10));

    add('Klasifikace SNR 20 dB', M.classifySnr(20).label, 'vhodné', M.classifySnr(20).level === 'good');
    add('Klasifikace SNR 15 dB', M.classifySnr(15).label, 'hraniční', M.classifySnr(15).level === 'warn');
    add('Klasifikace SNR 14,9 dB', M.classifySnr(14.9).label, 'nepoužít', M.classifySnr(14.9).level === 'bad');

    const worstBg = M.worstBackgroundPower(M.dbToPower(-60), M.dbToPower(-55));
    const worstDb = M.powerToDb(worstBg);
    add('Pozadí před/po: použije se horší hodnota', worstDb, -55, close(worstDb, -55, 1e-10));

    const band16k44 = M.octaveFullyCovered(16000, 44100, 20000);
    add('16 kHz oktáva při 44,1 kHz není plně pokrytá', band16k44, false, band16k44 === false);

    const band8k44 = M.octaveFullyCovered(8000, 44100, 20000);
    add('8 kHz oktáva při 44,1 kHz je plně pokrytá', band8k44, true, band8k44 === true);

    const sr = 48000;
    const n = 2048;
    const freq = 937.5;
    const amp = 0.1;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i += 1) samples[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
    const block = M.analyzeTimeBlock(samples, sr, {
      centers: [125,250,500,1000,2000,4000,8000,16000],
      calibration: {},
      analysisMaxHz: 20000,
      offsetDb: 0
    });
    const expectedZ = 20 * Math.log10(amp / Math.sqrt(2));
    add('Audio blok: Z-Leq známého sinu', block?.db?.Z, expectedZ, close(block?.db?.Z, expectedZ, 0.08), 'Testuje stejnou blokovou FFT cestu jako kontinuální Leq.');

    const dominantRatio = block?.octavePowersZ?.[1000] / block?.powers?.Z;
    add('Audio blok: sinus 937,5 Hz skončí v oktávě 1 kHz', dominantRatio, 1, Number.isFinite(dominantRatio) && dominantRatio > 0.98, 'Více než 98 % energie musí být v pásmu 1 kHz.');

    add('Audio blok: neúplná 16kHz oktáva se nepočítá', block?.octavePowersZ?.[16000], null, block?.coverage?.[16000] === false && block?.octavePowersZ?.[16000] === null);

    render(tests);
    return tests;
  }

  function render(tests) {
    const passed = tests.filter(t => t.pass).length;
    const total = tests.length;
    const summary = $('summary');
    summary.className = 'summary ' + (passed === total ? 'good' : 'bad');
    summary.innerHTML = `<strong>${passed} / ${total} testů prošlo</strong><span>${passed === total ? 'Výpočtové jádro je v pořádku.' : 'Některý test selhal – výsledek měření nelze považovat za ověřený.'}</span>`;

    const list = $('testList');
    list.innerHTML = '';
    tests.forEach(test => {
      const row = document.createElement('div');
      row.className = 'test ' + (test.pass ? 'good' : 'bad');
      const actual = typeof test.actual === 'number' ? fmt(test.actual) : String(test.actual);
      const expected = typeof test.expected === 'number' ? fmt(test.expected) : String(test.expected);
      row.innerHTML = `
        <div class="testHead"><span class="icon">${test.pass ? '✓' : '✕'}</span><strong>${test.name}</strong></div>
        <div class="values"><span>Výsledek: <b>${actual}</b></span><span>Očekáváno: <b>${expected}</b></span></div>
        ${test.note ? `<div class="note">${test.note}</div>` : ''}
      `;
      list.appendChild(row);
    });
  }

  $('runTests').addEventListener('click', runTests);
  runTests();
})();
