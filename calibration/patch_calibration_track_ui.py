from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
index = root / 'index.html'
sw = root / 'sw.js'

text = index.read_text(encoding='utf-8')
needle = '<script src="calibration-profiles.js"></script>'
insert = needle + '\n<script src="calibration-track.js"></script>'
if 'src="calibration-track.js"' not in text:
    if needle not in text:
        raise RuntimeError('V index.html nebyl nalezen calibration-profiles.js')
    text = text.replace(needle, insert, 1)
    index.write_text(text, encoding='utf-8')

text = sw.read_text(encoding='utf-8')
text = re.sub(r'const CACHE = "noise-meter-v\d+";', 'const CACHE = "noise-meter-v17";', text, count=1)
if '"./calibration-track.js"' not in text:
    text = text.replace('  "./calibration-profiles.js",', '  "./calibration-profiles.js",\n  "./calibration-track.js",', 1)
if 'url.pathname.endsWith("/calibration-track.js")' not in text:
    text = text.replace('url.pathname.endsWith("/calibration-profiles.js") ||', 'url.pathname.endsWith("/calibration-profiles.js") || url.pathname.endsWith("/calibration-track.js") ||', 1)
sw.write_text(text, encoding='utf-8')

print('index.html a sw.js připraveny pro calibration-track.js')
