from pathlib import Path
import math
import subprocess
import shutil
import wave
import numpy as np

ROOT = Path(__file__).resolve().parent
SR = 44100
TOTAL = 150.0


def add_segment(dst, start_s, src):
    i0 = int(round(start_s * SR))
    i1 = min(len(dst), i0 + len(src))
    dst[i0:i1] += src[:i1-i0]


def log_chirp(duration_s=0.03, f0=250.0, f1=8000.0, peak_dbfs=-6.0):
    """Krátký širokopásmový logaritmický chirp pro screening místnosti."""
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
    if color == 'pink':
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(n, 1 / SR)
        shape = np.zeros_like(f)
        shape[1:] = 1 / np.sqrt(f[1:])
        X *= shape
        x = np.fft.irfft(X, n=n)
    x -= np.mean(x)
    x /= max(1e-12, np.sqrt(np.mean(x * x)))
    return x * (10 ** (rms_dbfs / 20))


audio = np.zeros(int(round(TOTAL * SR)), dtype=np.float64)

# 0–5 s: ticho. 5, 8 a 11 s: tři měřicí chirpy.
for t in (5.0, 8.0, 11.0):
    add_segment(audio, t, log_chirp())

# 14–44 s: ticho pro měření pozadí.
# 45–105 s: růžový šum pro vlastní kalibraci.
add_segment(audio, 45.0, shaped_noise(60.0, 'pink', 20261005))

# 105–115 s: přechodové ticho.
# 115–145 s: bílý šum pro nezávislou kontrolu kalibrace.
add_segment(audio, 115.0, shaped_noise(30.0, 'white', 20261006))
# 145–150 s: konečné ticho.

peak = float(np.max(np.abs(audio)))
if peak > 0.98:
    audio *= 0.98 / peak

wav_path = ROOT / 'bernio_kalibrace_v1.wav'
pcm = np.int16(np.clip(audio, -1, 1) * 32767)
with wave.open(str(wav_path), 'wb') as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes(pcm.tobytes())

ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise RuntimeError('ffmpeg nebyl nalezen')
subprocess.run([
    ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', str(wav_path),
    '-codec:a', 'libmp3lame', '-b:a', '192k', '-ar', str(SR), '-ac', '1',
    str(ROOT / 'bernio_kalibrace_v1.mp3')
], check=True)

print('Vytvořeno:', wav_path.name, 'a bernio_kalibrace_v1.mp3')
