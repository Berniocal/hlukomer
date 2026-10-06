# Referenční kalibrace hlukoměru

Tato složka obsahuje podklady pro kalibraci webového hlukoměru Bernio podle konkrétního referenčního zdroje.

## Aktuální kalibrační stopa

**Bernio Calibration Track v2**

- referenční formát: `bernio_kalibrace_v2.wav`
- nouzová varianta: `bernio_kalibrace_v2.mp3`
- mono, 44,1 kHz
- délka: **3:35**
- generátor: `generate_calibration_track_v2.py`
- přesné časování a SHA-256: `bernio_kalibrace_v2_casovani.json`

WAV je jediná varianta určená pro budoucí plnohodnotnou referenční kalibraci. MP3 lze použít pro experimentální kontrolu, ale pokud by měla sloužit jako reference, musí mít vlastní naměřené referenční hodnoty.

## Průběh stopy v2

- **0:05, 0:08 a 0:11** – tři krátké chirpy pro screening místnosti
- **0:20–0:35** – slabší růžový šum pro test linearity
- **0:40–0:55** – tentýž růžový šum přesně o **10,0 dB** výš
- **1:00–1:30** – ticho pro pozadí před kalibrací
- **1:30–2:30** – hlavní růžový šum
- **2:30–3:00** – ticho pro pozadí po kalibraci
- **3:00–3:30** – bílý šum pro nezávislou kontrolu
- **3:30–3:35** – konečné ticho

Test linearity používá stejný úsek růžového šumu ve dvou úrovních. Digitální rozdíl je přesně **10,0 dB**. Aplikace hodnotí rozdíl přibližně takto:

- odchylka do **±1 dB** – linearita v pořádku
- odchylka **1–2 dB** – hraniční
- odchylka nad **2 dB** nebo zjištěné klipování – kalibraci nepovolit

Tyto hranice jsou pracovní kritérium pro školní měřicí systém a budou ověřeny při fyzické validaci.

## První referenční profil

**T&G TG-113A (Hadex T615A)**

- vzdálenost reproduktor–telefon: **1,50 m**
- reproduktor a mikrofon telefonu ve stejné výšce, proti sobě
- standardní kalibrační rozsah: **125 Hz–8 kHz**
- **16 kHz** se zatím měří pouze experimentálně a neovlivňuje standardní hodnocení
- pozadí se měří před i po hlavním signálu
- SNR se vyhodnocuje po jednotlivých oktávových pásmech
  - ≥ 20 dB: vhodné
  - 15–20 dB: hraniční
  - < 15 dB: pásmo se nepoužije

Referenční hodnoty LZeq a oktáv pro růžový i bílý šum budou doplněny až po změření konkrétního reproduktoru kalibrovaným referenčním přístrojem při přesně definovaném nastavení hlasitosti.

## Starší stopa

Soubory `bernio_kalibrace_v1.wav`, `bernio_kalibrace_v1.mp3` a jejich časování zůstávají v repozitáři kvůli reprodukovatelnosti starších pokusů. Nový kalibrační průvodce používá v2.
