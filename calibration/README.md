# Referenční kalibrace hlukoměru

Tato složka je připravená pro budoucí kalibraci podle konkrétních referenčních reproduktorů.

## První profil

**T&G TG-113A (Hadex T615A)**

- vzdálenost reproduktor–telefon: **1,50 m**
- reproduktor a mikrofon telefonu ve stejné výšce, proti sobě
- před kalibračním signálem: **5 s měření ticha**
- hlavní kalibrace: **25 s růžového šumu**
- bílý šum: kontrolní měření
- po dokončení se porovná kalibrační signál s předchozím pozadím
  - rozdíl ≥ 20 dB: vhodné podmínky
  - rozdíl 15–20 dB: varování
  - rozdíl < 15 dB: kalibrace se neuloží a aplikace doporučí přesun do tiššího prostředí

## Připravené soubory

Do této složky jsou určeny soubory:

- `ruzovy_sum_2min.mp3`
- `bily_sum_2min.mp3`

Parametry připravených souborů: 120 s, mono, 44,1 kHz, MP3 192 kb/s.

Referenční hodnoty Leq A/C/Z a oktáv se doplní až po změření konkrétního reproduktoru referenčním hlukoměrem při přesně definovaném nastavení hlasitosti.

TG-113A má podle výrobce udávaný rozsah 120 Hz–18 kHz, proto se pro tento profil počítá jako spolehlivá část kalibrace především s pásmy od 125 Hz výš. 31,5 Hz a 63 Hz se nebudou bez ověření používat jako referenční korekce.
