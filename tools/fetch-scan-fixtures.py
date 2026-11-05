"""Fetch a pinned public scan and its supplied transcription for local evaluation.
The image is evaluation data, never bundled into the APK.
"""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'ui-test-out' / 'real-scans'
COMMIT = '7f2417409fb86a4d478122eedc798f5d71e0b9a1'
BASE = f'https://raw.githubusercontent.com/stafazzoli/FarsiOCR/{COMMIT}/data/'
FILES = {
    'sample_farsi.jpeg': 'ef4bf26af07b5c2d237b77de5d2e3d9a0139ff6087e9ac83f8750a6c769a0013',
    'original.docx': 'f4eb8c3883f1b3ed46cefc8bee6b97a707b1eeb5c3df33aa949b957026341d48',
}
DEST.mkdir(parents=True, exist_ok=True)
for name, expected in FILES.items():
    target = DEST / name
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        continue
    with tempfile.NamedTemporaryFile(dir=DEST, delete=False) as temp:
        download = Path(temp.name)
    try:
        subprocess.run(['curl', '-fsSL', '--retry', '2', BASE + name, '-o', str(download)], check=True)
        if hashlib.sha256(download.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Checksum mismatch for {name}')
        download.replace(target)
    finally:
        download.unlink(missing_ok=True)
with ZipFile(DEST / 'original.docx') as archive:
    document = ET.fromstring(archive.read('word/document.xml'))
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
truth = '\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', ns)) for p in document.findall('.//w:p', ns))
if not truth.strip():
    raise ValueError('Reference transcript is empty')
(DEST / 'truth.txt').write_text(truth, encoding='utf-8')
print('Public real-scan fixture and reference verified (SHA-256)')
