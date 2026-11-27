"""Fetch the German Piper voice at build time. Inference runs entirely offline."""

import hashlib
import urllib.request
from pathlib import Path

revision = "5ec43b186ef915a195d3ddbcfd9916e76c503c3f"
source = f"https://huggingface.co/rhasspy/piper-voices/resolve/{revision}/de/de_DE/thorsten/medium"
files = {
    "de_DE-thorsten-medium.onnx": "fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f",
    "de_DE-thorsten-medium.onnx.json": "e5bb7410dcbbcc0be6f4544f6bc66612b315ab5cb3099ec44bb46d860bc7cca9",
    "MODEL_CARD": "c638118fb06eb07d59e60270097c250cf2de81a037320a8a6306fec652ad13b0",
}

directory = Path("/opt/stimme")
directory.mkdir()
for filename, expected in files.items():
    digest = hashlib.sha256()
    with urllib.request.urlopen(f"{source}/{filename}?download=true", timeout=120) as response:
        with (directory / filename).open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError(f"Unexpected checksum for {filename}")
