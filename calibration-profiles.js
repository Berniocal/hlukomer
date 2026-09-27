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
