# Hlukoměr (PWA)

Tahle PWA používá mikrofon a WebAudio API k měření relativní úrovně hluku (dBFS).
Protože prohlížeče nemají spolehlivou absolutní kalibraci SPL, aplikace umožňuje nastavit
**offset** (kalibraci) a pak zobrazuje „dB SPL“ orientačně.

## Jak spustit
- **Lokálně**: otevři `index.html` přes lokální server (kvůli mikrofonu musí být HTTPS nebo localhost).
  - Windows PowerShell: `python -m http.server` (pokud máš Python)
  - Nebo použij jakýkoli jednoduchý lokální server.
- **GitHub Pages**: nahraj obsah složky jako statický web (HTTPS je automaticky).

## Poznámky
- Na některých telefonech je aktivní AGC (auto gain), které měření zkreslí – aplikace se snaží AGC vypnout,
  ale zařízení to nemusí respektovat.
