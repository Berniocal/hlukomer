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

/* Ruční SPL kalibrace: bez horního limitu.
   app.js historicky ořezává ručně zadaný offset na 100 dB. Tento hook se
   načítá před app.js, odstraní HTML maximum a u hodnot nad 100 dB zabrání
   starému ořezu; sjednocená Leq vrstva pak použije hodnotu z localStorage. */
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

/* Stav rozbalovacích sekcí.
   Po načtení jsou všechny sekce v panelu Analýza zavřené.
   Uložená měření se sama otevřou pouze při přidání nového měření. */
window.addEventListener('DOMContentLoaded', () => {
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
