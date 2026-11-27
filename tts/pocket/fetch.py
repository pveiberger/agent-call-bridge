"""Install the German Pocket TTS preset and its CPU runtime at image build time."""

import hashlib
import re
import shutil
import tarfile
from pathlib import Path
from urllib.request import urlopen

root = Path("/opt/voice")
root.mkdir()
release = "https://github.com/kyutai-labs/pocket-tts/releases/download/v4.0.1"
model = ("https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/"
         "1e08e6a23401048648a9fdcfde2f89348215c2a7/languages/german")


def download(name, url, checksum):
    path = root / name
    with urlopen(url, timeout=120) as response, path.open("wb") as out:
        shutil.copyfileobj(response, out)
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != checksum:
            raise ValueError("Unexpected checksum for " + name)
    return path


package = "pocket-tts-3.3.0-x86_64-unknown-linux-gnu"
archive = download("binary.tgz", f"{release}/{package}.tar.gz",
                   "9abff0aa138a804e44052952d8c3bdaae247fb267ca8f4b83fe178897d1a0559")
with tarfile.open(archive) as bundle:
    for name in ("pocket-tts", "LICENSE"):
        with bundle.extractfile(f"{package}/{name}") as src, (root / name).open("wb") as dst:
            shutil.copyfileobj(src, dst)
(root / "pocket-tts").chmod(0o755)
archive.unlink()
download("model.safetensors", model + "/model.safetensors?download=true",
         "9fe42605604832349e3f495177bde56b77ae8fee73b2ed4b63236092ccde7621")
download("juergen.safetensors", model + "/embeddings/juergen.safetensors?download=true",
         "65104a25b2aa797c50b2cee555cb75deb6abba10169168b95857227a054126d1")
download("tokenizer.json", model + "/tokenizer.json",
         "2d77849811e3d1b6ae80e5b11b203f57e1847901104d8a0573b34f46f8dddb53")
config = download("german.yaml",
                  "https://raw.githubusercontent.com/kyutai-labs/pocket-tts/v4.0.1/pocket_tts/config/german.yaml",
                  "6e871faf965703751273b6b7878867dd40dd5796991f868742607741bcb78df9")
contents = config.read_text()
for key, filename in [("weights_path", "model.safetensors"),
                      ("weights_path_without_voice_cloning", "model.safetensors"),
                      ("tokenizer_path", "tokenizer.json")]:
    contents, count = re.subn(rf"(?m)^( *{key}:) hf://.*$", rf"\1 {root / filename}", contents)
    if count != 1:
        raise ValueError("Unexpected German model configuration")
config.write_text(contents)
