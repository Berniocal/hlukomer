from pathlib import Path
import hashlib
import json
import math
import shutil
import subprocess
import wave

import numpy as np

ROOT = Path(__file__).resolve().parent
SR = 44100
TOTAL = 215.0
LINEARITY_EXPECTED_DB = 10.0
LINEARITY_LOW_DBFS = -24.0
LINEARITY_HIGH_DBFS = -14.0


def add_segment(dst, start_s, src):
    i0 = int(round(start_s * SR))
    i1 = min(len(dst), i0 + len(src))
    dst[i0:i1] += src[: i1 - i0]


def log_chirp(duration_s=0.03, f0=250.0, f1=8000.0, peak_dbfs=-6.0):
    n = int(round(duration_s * SR))
    t = np.arange(n) / SR
    k = math.log(f1 / f0) / duration_s
    phase = 2 * np.pi * f0 * (np.exp(k * t) - 1) / k
    x = np.sin(phase)
    fade_n = max(1, int(0.003 * SR))
    env = np.ones(n)
    env[:fade_n] = np.sin(np.linspace(0, np.pi / 2, fade_n)) ** 2
    env[-fade_n:] = np.cos(np.linspace(0, np.pi / 2, fade_n)) ** 2
    return x * env * (10 ** (peak_dbfs / 20))


def shaped_noise(duration_s, color, seed, rms_dbfs=-18.0):
    n = int(round(duration_s * SR))
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    if color == "pink":
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(n, 1 / SR)
        shape = np.zeros_like(f)
        shape[1:] = 1 / np.sqrt(f[1:])
        X *= shape
        x = np.fft.irfft(X, n=n)
    x -= np.mean(x)
    x /= max(1e-12, np.sqrt(np.mean(x * x)))
    return x * (10 ** (rms_dbfs / 20))


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


audio = np.zeros(int(round(TOTAL * SR)), dtype=np.float64)

# 0-16 s: screening místnosti.
for t in (5.0, 8.0, 11.0):
    add_segment(audio, t, log_chirp())

# Test linearity: tentýž 15s růžový šum ve dvou přesně známých úrovních.
linearity_base = shaped_noise(15.0, "pink", 20261007, LINEARITY_LOW_DBFS)
linearity_high = linearity_base * (10 ** (LINEARITY_EXPECTED_DB / 20))
add_segment(audio, 20.0, linearity_base)
add_segment(audio, 40.0, linearity_high)

# 60-90 s: ticho pro pozadí před kalibrací.
# 90-150 s: hlavní růžový šum.
add_segment(audio, 90.0, shaped_noise(60.0, "pink", 20261005, -18.0))

# 150-180 s: ticho pro pozadí po kalibraci.
# 180-210 s: bílý šum pro nezávislou kontrolu.
add_segment(audio, 180.0, shaped_noise(30.0, "white", 20261006, -18.0))
# 210-215 s: konečné ticho.

peak = float(np.max(np.abs(audio)))
if peak >= 0.99:
    raise RuntimeError(f"Stopa by klipovala: peak={peak:.6f}. Upravte úrovně, neprovádějte globální normalizaci.")

wav_path = ROOT / "bernio_kalibrace_v2.wav"
pcm = np.int16(np.clip(audio, -1, 1) * 32767)
with wave.open(str(wav_path), "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes(pcm.tobytes())

ffmpeg = shutil.which("ffmpeg")
if not ffmpeg:
    raise RuntimeError("ffmpeg nebyl nalezen")

mp3_path = ROOT / "bernio_kalibrace_v2.mp3"
subprocess.run([
    ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
    "-i", str(wav_path),
    "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", str(SR), "-ac", "1",
    str(mp3_path)
], check=True)

timing = {
    "version": "Bernio Calibration Track v2",
    "trackId": "bernio-calibration-track-v2",
    "sampleRateHz": SR,
    "channels": 1,
    "durationSec": TOTAL,
    "linearity": {
        "expectedDifferenceDb": LINEARITY_EXPECTED_DB,
        "lowRmsDbfs": LINEARITY_LOW_DBFS,
        "highRmsDbfs": LINEARITY_HIGH_DBFS,
        "sameNoiseSamples": True,
        "goodToleranceDb": 1.0,
        "warningToleranceDb": 2.0
    },
    "timeline": [
        {"from": 0, "to": 5, "content": "ticho"},
        {"at": 5.0, "content": "chirp 1", "sweepHz": [250, 8000], "durationMs": 30},
        {"at": 8.0, "content": "chirp 2", "sweepHz": [250, 8000], "durationMs": 30},
        {"at": 11.0, "content": "chirp 3", "sweepHz": [250, 8000], "durationMs": 30},
        {"from": 20, "to": 35, "content": "růžový šum - slabší", "rmsDbfs": LINEARITY_LOW_DBFS, "purpose": "test linearity"},
        {"from": 40, "to": 55, "content": "tentýž růžový šum - hlasitější", "rmsDbfs": LINEARITY_HIGH_DBFS, "purpose": "test linearity"},
        {"from": 60, "to": 90, "content": "ticho", "purpose": "pozadí před kalibrací"},
        {"from": 90, "to": 150, "content": "růžový šum", "rmsDbfs": -18.0, "purpose": "kalibrace"},
        {"from": 150, "to": 180, "content": "ticho", "purpose": "pozadí po kalibraci"},
        {"from": 180, "to": 210, "content": "bílý šum", "rmsDbfs": -18.0, "purpose": "kontrola kalibrace"},
        {"from": 210, "to": 215, "content": "ticho / konec"}
    ],
    "notes": [
        "WAV je jediný plnohodnotný referenční formát pro budoucí automatickou kalibraci.",
        "MP3 je pouze nouzová varianta a musí mít vlastní referenční data, pokud má být někdy používán jako reference.",
        "Test linearity porovnává tentýž růžový šum se známým rozdílem přesně 10,0 dB.",
        "Stopa se při generování globálně nenormalizuje; překročení bezpečného peaku generování zastaví."
    ],
    "files": {
        "wav": {"name": wav_path.name, "sha256": sha256(wav_path)},
        "mp3": {"name": mp3_path.name, "sha256": sha256(mp3_path)}
    }
}

(ROOT / "bernio_kalibrace_v2_casovani.json").write_text(
    json.dumps(timing, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8"
)

print("Vytvořeno:", wav_path.name, mp3_path.name)
print("Peak:", peak)
print("Linearity delta:", LINEARITY_EXPECTED_DB, "dB")
