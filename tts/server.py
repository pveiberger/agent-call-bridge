"""Internal German TTS for the authenticated Nod call backend."""

import io
import json
import logging
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig

VOICE_PATH = Path("/opt/stimme/de_DE-thorsten-medium.onnx")
MAX_CHARS = 1600
MAX_BODY = 16384
synthesizing = threading.Lock()


def load_voice():
    onnxruntime.disable_telemetry_events()
    onnxruntime.set_default_logger_severity(3)
    config = PiperConfig.from_dict(json.loads(VOICE_PATH.with_suffix(".onnx.json").read_text()))
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    session = onnxruntime.InferenceSession(str(VOICE_PATH), sess_options=options,
                                            providers=["CPUExecutionProvider"])
    return PiperVoice(session=session, config=config)


def phrases(text):
    # Limit the longest neural inference even for long text without punctuation.
    remaining = " ".join(text.split())
    while len(remaining) > 240:
        boundaries = list(re.finditer(r"[.!?;,:](?:\s|$)", remaining[:241]))
        split = boundaries[-1].end() if boundaries else remaining.rfind(" ", 0, 241)
        if split < 1:
            split = 240
        yield remaining[:split].strip()
        remaining = remaining[split:].lstrip()
    if remaining:
        yield remaining


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, *unused):
        # Neither utterance text nor request URLs belong in host logs.
        pass

    def respond(self, status, body=b"", content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        self.respond(200 if self.path == "/health" else 404)

    def do_POST(self):
        if self.path != "/synthesize":
            return self.respond(404)
        if self.headers.get_content_type() != "application/json":
            return self.respond(415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.respond(413 if length > MAX_BODY else 400)
            data = json.loads(self.rfile.read(length))
            text = data.get("text") if isinstance(data, dict) else None
            if not isinstance(text, str) or not text.strip() or "\x00" in text:
                return self.respond(400)
            if len(text) > MAX_CHARS:
                return self.respond(413)
        except (ValueError, RecursionError):
            return self.respond(400)
        if not synthesizing.acquire(blocking=False):
            return self.respond(503)
        try:
            audio = io.BytesIO()
            with wave.open(audio, "wb") as wav:
                wav.setparams((1, 2, voice.config.sample_rate, 0, "NONE", "not compressed"))
                for phrase in phrases(text):
                    for chunk in voice.synthesize(phrase):
                        wav.writeframesraw(chunk.audio_int16_bytes)
                if wav.getnframes() == 0:
                    return self.respond(422)
            self.respond(200, audio.getvalue(), "audio/wav")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            # Library exception strings may contain words from the input.
            self.respond(500)
        finally:
            synthesizing.release()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    voice = load_voice()
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
