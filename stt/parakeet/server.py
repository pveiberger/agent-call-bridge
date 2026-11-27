"""Private German-capable Parakeet transcription endpoint for the call bridge."""

import io
import json
import math
import os
import struct
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import sherpa_onnx
from python_multipart import parse_form
from python_multipart.exceptions import FormParserError
from tokenizers import Tokenizer


MODEL = Path("/opt/parakeet")
MAX_BODY = 4 * 1024 * 1024
RATE = 16_000
MAX_FRAMES = 120 * RATE


def glossary(config, tokenizer, symbols):
    phrases = []
    if len(config) > 1024:
        raise ValueError("STT_HOTWORDS supports at most 1024 characters.")
    for phrase in config.split("|"):
        phrase = " ".join(phrase.split())
        if not phrase:
            continue
        if len(phrase) > 80 or not all(c.isalnum() or c in " -'’" for c in phrase):
            raise ValueError("Use short names separated by | in STT_HOTWORDS.")
        pieces = tokenizer.encode(phrase, add_special_tokens=False).tokens
        if not pieces or not pieces[0].startswith("▁") or any(p not in symbols or p == "<unk>" for p in pieces):
            raise ValueError("An STT_HOTWORDS entry is outside the model vocabulary.")
        phrases.append(" ".join(pieces))
    return "/".join(dict.fromkeys(phrases))


def microphone_audio(content_type, body):
    files = []

    def file_received(upload):
        try:
            if files or upload.field_name != b"file":
                raise ValueError("Expected one audio file.")
            upload.file_object.seek(0)
            files.append(upload.file_object.read())
        finally:
            upload.close()

    parse_form({"Content-Type": content_type.encode("ascii")}, io.BytesIO(body),
               on_field=None, on_file=file_received)
    if len(files) != 1:
        raise ValueError("Missing audio file.")
    with wave.open(io.BytesIO(files[0])) as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, RATE, "NONE"):
            raise ValueError("Expected mono PCM16 WAV at 16 kHz.")
        count = wav.getnframes()
        if not 0 < count <= MAX_FRAMES:
            raise ValueError("Invalid recording length.")
        pcm = wav.readframes(count)
    if len(pcm) != count * 2:
        raise ValueError("Incomplete recording.")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768


class Transcriber:
    def __init__(self):
        tokens = MODEL / "tokens.txt"
        self.boost = glossary(os.getenv("STT_HOTWORDS", ""), Tokenizer.from_file(str(MODEL / "tokenizer.json")),
                              {line.rsplit(" ", 1)[0] for line in tokens.read_text("utf-8").splitlines()})
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(MODEL / "encoder.int8.onnx"), decoder=str(MODEL / "decoder.int8.onnx"),
            joiner=str(MODEL / "joiner.int8.onnx"), tokens=str(tokens),
            num_threads=4, provider="cpu", model_type="nemo_transducer",
            decoding_method="modified_beam_search" if self.boost else "greedy_search",
            hotwords_score=2.0,
        )

    def transcribe(self, audio):
        stream = self.recognizer.create_stream(self.boost or None)
        stream.accept_waveform(RATE, audio)
        self.recognizer.decode_stream(stream)
        result = stream.result
        return {"text": result.text.strip(), "needs_review": needs_review(result.tokens, result.ys_log_probs)}


def needs_review(tokens, log_probs):
    """Token scores are decoder signals, not calibrated word-correctness probabilities."""
    if len(tokens) != len(log_probs):
        return True
    scores = [p for token, p in zip(tokens, log_probs) if any(c.isalnum() for c in token)]
    if not scores or not all(math.isfinite(p) for p in scores):
        return True
    weak = sum(p < math.log(0.60) for p in scores)
    return weak >= 2 or (len(scores) <= 12 and min(scores) < math.log(0.35))


class Handler(BaseHTTPRequestHandler):
    timeout = 15

    def log_message(self, *args):
        pass

    def respond(self, status, value=None):
        body = json.dumps(value or {}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.respond(200, {"status": "ok"})
        self.respond(404)

    def do_POST(self):
        if self.path != "/v1/audio/transcriptions":
            return self.respond(404)
        if (self.headers.get_content_type() != "multipart/form-data" or self.headers.get("Transfer-Encoding")
                or not self.headers.get_param("boundary")):
            return self.respond(415)
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) != 1 or not lengths[0].isdecimal() or len(lengths[0]) > 9:
            return self.respond(411)
        size = int(lengths[0])
        if not 0 < size <= MAX_BODY:
            return self.respond(413)
        if not self.server.worker.acquire(blocking=False):
            return self.respond(503)
        try:
            body = self.rfile.read(size)
            if len(body) != size:
                return self.respond(400)
            try:
                audio = microphone_audio(self.headers["Content-Type"], body)
            except (FormParserError, ValueError, EOFError, wave.Error, OverflowError, struct.error):
                return self.respond(400, {"error": "Expected a complete 16 kHz mono PCM16 WAV."})
            self.respond(200, self.server.asr.transcribe(audio))
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.respond(500, {"error": "Transcription failed."})
        finally:
            self.server.worker.release()


if __name__ == "__main__":
    asr = Transcriber()
    with ThreadingHTTPServer(("0.0.0.0", 8093), Handler) as server:
        server.asr = asr
        server.worker = threading.Lock()
        server.serve_forever()
