"""Run a real-time hands-free call in an isolated Chromium profile.

Requires Python 3.10+, the websockets Python package and desktop Chrome or Chromium.
Use --fixtures with a directory containing three mono PCM16 WAVs named caller.wav
(one spoken utterance), reply.wav and presence.wav. Otherwise build the local
Piper image with "docker build -t agent-call-tts:local ./tts" to generate them.
From the repository root run "python test/browser-soak.py". The
default runs for approximately 64 minutes. "--minutes 0" exercises one real
spoken turn followed by the full 60 + 30 second silence check.

The authenticated loopback fixture supplies a deterministic agent answer and
streams its PCM. No actual
microphone, LLM account, device session, or external assistant is used.
"""

import argparse
import asyncio
from array import array
import contextlib
import ctypes
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
import wave

import websockets


WEB = Path(__file__).resolve().parents[1] / "web"
INTERVAL = 41
PROMPT = "Sind Sie noch da? Wenn ja, sprechen Sie jetzt."


def chrome_binary(value):
    candidates = [
        value, os.getenv("CHROME_BIN"),
        *(shutil.which(name) for name in ("google-chrome", "chromium", "chromium-browser", "chrome")),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        str(Path(os.getenv("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit("Chrome executable not found. Supply --chrome or set CHROME_BIN.")


def fixtures(image):
    # docker create first so a failure in startup or voice generation can always be cleaned up.
    cid = subprocess.check_output([
        "docker", "create", "--pull", "never", "-p", "127.0.0.1::8090", image,
    ], text=True).strip()
    try:
        subprocess.run(["docker", "start", cid], check=True, stdout=subprocess.DEVNULL)
        address = subprocess.check_output(["docker", "port", cid, "8090/tcp"], text=True).strip()
        origin = "http://" + address
        deadline = time.monotonic() + 45
        while True:
            try:
                with urlopen(origin + "/health", timeout=1):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError("Piper did not start")
                time.sleep(0.2)

        def speak(text):
            req = Request(origin + "/synthesize", data=json.dumps({"text": text}).encode(),
                          headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=30) as res:
                return res.read()
        question = speak("Wie viel ist zwei plus zwei? Antworte bitte kurz auf Deutsch.")
        return question, speak("Vier."), speak(PROMPT)
    finally:
        subprocess.run(["docker", "rm", "-f", cid], check=True, stdout=subprocess.DEVNULL)


def samples(wav):
    with wave.open(io.BytesIO(wav)) as audio:
        if audio.getsampwidth() != 2 or audio.getnchannels() != 1:
            raise ValueError("Expected a mono PCM16 fixture")
        return audio.getframerate(), audio.readframes(audio.getnframes())


def microphone_file(path, question, turns):
    rate, pcm = samples(question)
    if not 0 < len(pcm) / (2 * rate) < INTERVAL - 5:
        raise ValueError("caller.wav must contain one utterance shorter than 36 seconds")
    rest = bytes(2 * rate * INTERVAL - len(pcm))
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, rate, 0, "NONE", ""))
        out.writeframes(bytes(2 * rate * 3))
        for _ in range(turns):
            out.writeframes(pcm)
            out.writeframes(rest)
        # Chromium may loop shorter inputs. Keep it silent until well after hangup.
        out.writeframes(bytes(2 * rate * 180))


def pcm24(wav):
    rate, pcm = samples(wav)
    source = array("h")
    source.frombytes(pcm)
    if sys.byteorder != "little":
        source.byteswap()
    output = array("h")
    for i in range(len(source) * 24000 // rate):
        index, fraction = divmod(i * rate, 24000)
        a, b = source[index], source[min(index + 1, len(source) - 1)]
        output.append(round(a + (b - a) * fraction / 24000))
    if sys.byteorder != "little":
        output.byteswap()
    return output.tobytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        # Chrome can reset idle keep-alive sockets while disposing its temporary profile.
        with contextlib.suppress(ConnectionResetError, BrokenPipeError):
            super().handle()

    def log_message(self, *args):
        pass

    def reply(self, data, kind="application/json"):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authenticated(self):
        if self.headers.get("Cookie") != "qa-session=" + self.server.secret:
            self.send_error(401)
            return False
        return True

    def do_GET(self):
        path = self.path
        if path.startswith("/anruf/api/"):
            if not self.authenticated():
                return
            if path == "/anruf/api/session":
                return self.reply(b'{"ok":true,"agent":"Nod","speechStream":true}')
            if path.startswith("/anruf/api/turn/"):
                receipt = path.rsplit("/", 1)[-1]
                if self.server.turns.get(receipt) == self.headers.get("X-Call-Id") and receipt in self.server.turns:
                    return self.reply(b'{"state":"reply","text":"Vier."}')
            return self.send_error(404)
        leaf = path.removeprefix("/anruf/") or "index.html"
        if not path.startswith("/anruf/") or Path(leaf).name != leaf or not (WEB / leaf).is_file():
            return self.send_error(404)
        kind = "text/javascript" if leaf.endswith(".js") else mimetypes.guess_type(leaf)[0]
        self.reply((WEB / leaf).read_bytes(), kind or "application/octet-stream")

    def do_POST(self):
        if not self.authenticated():
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 32_000 * INTERVAL:
            return self.send_error(413)
        data = self.rfile.read(length)
        call = self.headers.get("X-Call-Id", "")
        if not call or (self.server.call and self.server.call != call):
            return self.send_error(409)
        self.server.call = call
        if self.path == "/anruf/api/utterance":
            rate, pcm = samples(data)
            if rate != 16000 or len(pcm) < 3200 or not any(pcm):
                return self.send_error(422)
            receipt = self.headers.get("X-Request-Id", "")
            if not receipt or receipt in self.server.turns:
                return self.send_error(409)
            self.server.turns[receipt] = call
            self.server.last_turn = time.monotonic()
            return self.reply(json.dumps({"id": receipt}).encode())
        text = json.loads(data).get("text")
        if self.path == "/anruf/api/speech" and text == PROMPT:
            self.server.prompts += 1
            return self.reply(self.server.warning, "audio/wav")
        if self.path != "/anruf/api/speech/stream" or text != "Vier.":
            return self.send_error(400)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Audio-Sample-Rate", "24000")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        for start in range(0, len(self.server.answer), 2347):
            block = self.server.answer[start:start + 2347]
            self.wfile.write(f"{len(block):x}\r\n".encode() + block + b"\r\n")
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()
        self.server.answers += 1


class Browser:
    def __init__(self, ws):
        self.ws = ws
        self.seq = 0

    async def call(self, method, **params):
        self.seq += 1
        await self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params}))
        while True:
            reply = json.loads(await asyncio.wait_for(self.ws.recv(), 15))
            if reply.get("id") == self.seq:
                if "error" in reply:
                    raise RuntimeError("Browser operation failed: " + method)
                return reply["result"]

    async def js(self, expression):
        data = await self.call("Runtime.evaluate", expression=expression, returnByValue=True)
        if "exceptionDetails" in data:
            raise RuntimeError("Browser inspection failed")
        return data["result"].get("value")


HOOK = """
window.qa = {phases: [], sources: 0, played: 0, audible: false};
document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
  const phase = document.body.dataset.phase;
  if (qa.phases.at(-1)?.[0] !== phase) qa.phases.push([phase, performance.now()]);
}).observe(document.body, {attributes: true, attributeFilter: ['data-phase']}));
const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (options) => {
  const stream = await acquire(options);
  window.qaTrack = stream.getAudioTracks()[0];
  return stream;
};
const play = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function(...args) {
  if (this.buffer?.length > 1) {
    qa.sources++;
    if (this.buffer.getChannelData(0).some(sample => sample > 0.003)) qa.audible = true;
    this.addEventListener('ended', () => qa.played++, {once: true});
  }
  return play.apply(this, args);
};
"""


async def monitor(page, server, turns, minutes):
    origin = "http://127.0.0.1:" + str(server.server_port)
    async with websockets.connect(page) as ws:
        tab = Browser(ws)
        await tab.call("Page.enable")
        await tab.call("Network.enable")
        cookie = await tab.call("Network.setCookie", url=origin, name="qa-session", value=server.secret,
                                path="/", httpOnly=True, sameSite="Strict")
        if not cookie.get("success"):
            raise RuntimeError("Could not initialize local test session")
        await tab.call("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=1, mobile=True)
        await tab.call("Page.addScriptToEvaluateOnNewDocument", source=HOOK)
        await tab.call("Page.navigate", url=origin + "/anruf/")
        deadline = time.monotonic() + 10
        while not await tab.js("document.body?.dataset.phase === 'idle'"):
            if time.monotonic() >= deadline:
                raise RuntimeError("Call page did not initialize")
            await asyncio.sleep(0.1)
        position = await tab.js("""(() => {
          const button = document.querySelector('#toggle');
          button.scrollIntoView({block: 'center'});
          const bounds = button.getBoundingClientRect();
          return {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
        })()""")
        for event in ("mousePressed", "mouseReleased"):
            await tab.call("Input.dispatchMouseEvent", type=event, button="left", clickCount=1, **position)
        start = time.monotonic()
        next_report = start
        deadline = start + (turns - 1) * INTERVAL + 170
        while time.monotonic() < deadline:
            now = time.monotonic()
            state = await tab.js("""({
              phase: document.body.dataset.phase,
              mic: window.qaTrack?.readyState,
              started: qa.sources,
              ended: qa.played,
              audible: qa.audible,
              captured: qa.phases.filter(([phase]) => phase === 'capturing').length,
              spoken: qa.phases.slice(1).filter(([phase], index) =>
                phase === 'listening' && qa.phases[index][0] === 'speaking').length
            })""")
            if now >= next_report:
                print(f"{now-start:.0f} s, {len(server.turns)} turns, {server.answers} replies, "
                      f"{server.prompts} presence prompts, phase {state['phase']}", flush=True)
                next_report = now + 60
            if state["phase"] == "idle" and state.get("mic") == "ended":
                phases = await tab.js("qa.phases.slice(-4)")
                if [p for p, _ in phases] != ["listening", "speaking", "listening", "idle"]:
                    raise RuntimeError("Unexpected final phase sequence")
                warning = (phases[1][1] - phases[0][1]) / 1000
                hangup = (phases[3][1] - phases[2][1]) / 1000
                if not (59.8 <= warning < 62 and 29.8 <= hangup < 32 and server.prompts == 1
                        and server.answers == len(server.turns) == state["captured"] == turns
                        and state["spoken"] == turns + 1
                        and server.last_turn - start >= minutes * 60 and state["audible"]
                        and state["started"] == state["ended"] and state["started"] > turns):
                    raise RuntimeError("Audio, call duration or idle hangup verification failed")
                print(f"PASS: {turns} spoken turns on one call, presence at {warning:.3f} s, "
                      f"hangup after {hangup:.3f} s. Microphone released.", flush=True)
                # Give Chromium a chance to flush its temporary profile before removing it.
                with contextlib.suppress(Exception):
                    await tab.call("Browser.close")
                return
            stalled = len(server.turns) < turns and now - (server.last_turn or start) > 65
            if stalled or state["phase"] in ("approval", "error") or (server.prompts and len(server.turns) < turns):
                raise RuntimeError("Call stopped receiving the expected fixture")
            await asyncio.sleep(0.5)
        raise RuntimeError("Call did not end within the test window")


def run(args):
    chrome = chrome_binary(args.chrome)
    turns = math.ceil(args.minutes * 60 / INTERVAL) + 1
    if args.fixtures:
        question, answer, warning = [
            (args.fixtures / name).read_bytes() for name in ("caller.wav", "reply.wav", "presence.wav")
        ]
        for wav in (question, answer, warning):
            samples(wav)
    else:
        question, answer, warning = fixtures(args.piper_image)
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)
    try:
        with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            root = Path(tmp)
            server.secret = secrets.token_urlsafe(32)
            server.turns, server.call, server.last_turn = {}, None, None
            server.answers = server.prompts = 0
            server.answer, server.warning = pcm24(answer), warning
            threading.Thread(target=server.serve_forever, daemon=True).start()
            profile, mic = root / "browser", root / "input.wav"
            microphone_file(mic, question, turns)
            proc = subprocess.Popen([
                chrome, "--headless", "--disable-sync", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0",
                f"--user-data-dir={profile}", "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream", f"--use-file-for-fake-audio-capture={mic}", "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                port_file = profile / "DevToolsActivePort"
                deadline = time.monotonic() + 15
                while not port_file.exists():
                    if proc.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("Chromium did not start")
                    time.sleep(0.1)
                port = port_file.read_text().splitlines()[0]
                with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as res:
                    page = next(t["webSocketDebuggerUrl"] for t in json.load(res) if t["type"] == "page")
                asyncio.run(monitor(page, server, turns, args.minutes))
            finally:
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                server.shutdown()
    finally:
        if sys.platform == "win32":
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--minutes", type=float, default=62, help="minimum active call duration before silence")
    parser.add_argument("--chrome", help="Chromium executable path (also CHROME_BIN)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--fixtures", type=Path, help="directory with caller.wav, reply.wav and presence.wav")
    source.add_argument("--piper-image", default="agent-call-tts:local", help="existing local project Piper image")
    args = parser.parse_args()
    if not math.isfinite(args.minutes) or args.minutes < 0:
        parser.error("--minutes must be finite and nonnegative")
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    run(args)
