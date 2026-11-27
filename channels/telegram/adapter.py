"""Inbound one-to-one Telegram user calls for the assistant voice bridge."""

import argparse
import asyncio
import audioop
import contextlib
import io
import logging
import os
import re
import time
import uuid
import wave
from urllib.parse import quote

import aiohttp
from pytgcalls import PyTgCalls, filters
from pytgcalls.types import CallConfig, ChatUpdate, Device, Direction
from pytgcalls.types import ExternalMedia, MediaStream, RecordStream
from pytgcalls.types.raw import AudioParameters
from telethon import TelegramClient

from media import FRAME, RATE, Utterances

CALL_RATE = 48_000
CALL_AUDIO = AudioParameters(bitrate=CALL_RATE, channels=1)
FRAME_BYTES = CALL_RATE // 100 * 2
SESSION_FILE = "/session/calls"
log = logging.getLogger("telegram-calls")


def allowed_users(value):
    users = value.strip().split(",")
    if not all(re.fullmatch(r"[1-9][0-9]{0,18}", user.strip()) for user in users):
        raise ValueError("TELEGRAM_ALLOWED_CALLERS requires positive numeric Telegram user IDs.")
    return frozenset(int(user) for user in users)


def spoken_parts(text):
    rest = " ".join(text.split())
    while len(rest) > 450:
        endings = list(re.finditer(r"[.!?;:]\s", rest[:450]))
        split = endings[-1].end() if endings else rest.rfind(" ", 0, 450)
        if split < 1:
            split = 450
        yield rest[:split].strip()
        rest = rest[split:].lstrip()
    if rest:
        yield rest


def telegram_pcm(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
            raise ValueError("Expected mono PCM16 WAV.")
        if not 8000 <= wav.getframerate() <= 96000 or wav.getnframes() > 12_000_000:
            raise ValueError("Invalid speech audio.")
        pcm = wav.readframes(wav.getnframes())
        return audioop.ratecv(pcm, 2, 1, wav.getframerate(), CALL_RATE, None)[0]


async def refuse_outbound(*_args, **_kwargs):
    # In the pinned SDK play()/record() may otherwise dial the peer when an
    # incoming call ends between its event and the media source setup.
    raise RuntimeError("This adapter only accepts incoming calls.")


class Call:
    def __init__(self, adapter, user):
        self.adapter = adapter
        self.user = user
        self.id = str(uuid.uuid4())
        self.ready = False
        self.remote_ended = False
        self.job = None
        self.incoming = asyncio.Queue(maxsize=128)

    async def bridge(self, method, path, **options):
        headers = {"Authorization": "Bearer " + self.adapter.secret, "X-Call-Id": self.id}
        headers.update(options.pop("headers", {}))
        async with self.adapter.http.request(method, self.adapter.bridge_url + path, headers=headers,
                                             allow_redirects=False, **options) as response:
            if response.status != 200:
                raise RuntimeError(f"Bridge returned {response.status}.")
            return await response.read() if path == "/channel/speech" else await response.json()

    async def speak(self, text):
        for part in spoken_parts(text):
            raw = await self.bridge("POST", "/channel/speech", json={"text": part})
            pcm = telegram_pcm(raw)
            next_frame = time.monotonic()
            for pos in range(0, len(pcm), FRAME_BYTES):
                await asyncio.sleep(max(0, next_frame - time.monotonic()))
                frame = pcm[pos:pos + FRAME_BYTES].ljust(FRAME_BYTES, b"\0")
                await self.adapter.calls.send_frame(self.user, Device.MICROPHONE, frame)
                next_frame = max(next_frame + 0.01, time.monotonic())
        await asyncio.sleep(0.32)

    async def reply(self, audio):
        sent = await self.bridge("POST", "/channel/utterance", data=audio, headers={
            "Content-Type": "audio/wav", "X-Request-Id": str(uuid.uuid4()),
        })
        turn = sent["id"]
        if not isinstance(turn, str) or not turn or len(turn) > 512 or turn in (".", ".."):
            raise ValueError("Invalid bridge turn ID.")
        while True:
            result = await self.bridge("GET", "/channel/turn/" + quote(turn, safe=""))
            if result["state"] == "working":
                await asyncio.sleep(0.85)
                continue
            if result["state"] == "approval":
                await self.speak("Bitte öffne den Hauptchat, um die Freigabe zu prüfen.")
                return False
            if result["state"] == "reply" and result.get("text"):
                await self.speak(result["text"])
                return True
            raise RuntimeError("The assistant could not return a reply.")

    async def listen(self):
        detector = Utterances()
        pending = bytearray()
        state = None
        while not self.incoming.empty():
            self.incoming.get_nowait()
        self.ready = True
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(self.incoming.get(), timeout=0.15)
                except TimeoutError:
                    # DTX can omit frames during pauses. Deliver the equivalent
                    # silence to VAD so a caller never needs a second sound.
                    frame = bytes(CALL_RATE * 15 // 100 * 2)
                converted, state = audioop.ratecv(frame, 2, 1, CALL_RATE, RATE, state)
                pending.extend(converted)
                while len(pending) >= FRAME * 2:
                    utterance = detector.push(bytes(pending[:FRAME * 2]))
                    del pending[:FRAME * 2]
                    if utterance:
                        return utterance
        finally:
            self.ready = False

    async def run(self):
        connected = False
        try:
            async with asyncio.timeout(55):
                await self.adapter.calls.play(self.user, MediaStream(ExternalMedia.AUDIO, CALL_AUDIO),
                                              CallConfig(timeout=30))
                await self.adapter.calls.record(self.user, RecordStream(True, CALL_AUDIO))
            connected = True
            await self.speak("Hallo, du kannst jetzt sprechen.")
            while True:
                audio = await self.listen()
                async with asyncio.timeout(360):
                    if not await self.reply(audio):
                        break
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("Call ended (%s)", type(error).__name__)
            if connected and not self.remote_ended:
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(12):
                        await self.speak("Öffne bitte den Hauptchat. Die Sprachverbindung ist unterbrochen.")
        finally:
            self.ready = False
            if not self.remote_ended:
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(8):
                        await self.adapter.calls.leave_call(self.user)


class Adapter:
    def __init__(self, calls, http, users, bridge_url, secret):
        self.calls = calls
        self.http = http
        self.users = users
        self.bridge_url = bridge_url.rstrip("/")
        self.secret = secret
        self.active = None

    async def incoming_call(self, _calls, update):
        if update.chat_id not in self.users or self.active is not None:
            return
        session = Call(self, update.chat_id)
        self.active = session
        session.job = asyncio.create_task(session.run())

        def finished(_job):
            if self.active is session:
                self.active = None
        session.job.add_done_callback(finished)

    async def ended(self, _calls, update):
        session = self.active
        if session and session.user == update.chat_id and session.job:
            session.remote_ended = True
            session.job.cancel()

    async def frames(self, _calls, update):
        session = self.active
        if not session or not session.ready or session.user != update.chat_id:
            return
        for item in update.frames:
            if item.frame and len(item.frame) % 2 == 0 and not session.incoming.full():
                session.incoming.put_nowait(item.frame)

    def register(self):
        self.calls.on_update(filters.chat_update(ChatUpdate.Status.INCOMING_CALL))(self.incoming_call)
        self.calls.on_update(filters.chat_update(ChatUpdate.Status.LEFT_CALL))(self.ended)
        self.calls.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))(self.frames)


async def main(command):
    os.umask(0o077)
    user_client = TelegramClient(SESSION_FILE, int(os.environ["TELEGRAM_API_ID"]),
                                 os.environ["TELEGRAM_API_HASH"])
    if command == "login":
        try:
            await user_client.start()
            if (await user_client.get_me()).bot:
                raise ValueError("A dedicated Telegram user account is required.")
            print("User session saved. Keep the session volume private.")
        finally:
            await user_client.disconnect()
        return
    users = allowed_users(os.environ["TELEGRAM_ALLOWED_CALLERS"])
    secret = os.environ["BRIDGE_CHANNEL_SECRET"]
    if len(secret) < 32:
        raise ValueError("Set the bridge channel secret (at least 32 characters).")
    try:
        await user_client.connect()
        if not await user_client.is_user_authorized():
            raise ValueError("Run the interactive login command first.")
        identity = await user_client.get_me()
        if identity.bot or identity.id in users:
            raise ValueError("Use a dedicated receiver user distinct from the allowed caller.")
        calls = PyTgCalls(user_client, workers=2)
        calls._app.request_call = refuse_outbound
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=100)) as http:
            adapter = Adapter(calls, http, users, os.getenv("BRIDGE_BASE_URL", "http://bridge:8091"), secret)
            adapter.register()
            await calls.start()
            try:
                await user_client.run_until_disconnected()
            finally:
                if adapter.active and adapter.active.job:
                    adapter.active.job.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await adapter.active.job
    finally:
        await user_client.disconnect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "login"), nargs="?", default="run")
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main(parser.parse_args().command))
