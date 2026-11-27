import asyncio
import io
import math
import struct
import unittest
import uuid
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from pytgcalls import PyTgCalls
from telethon import TelegramClient
from telethon.sessions import MemorySession

from adapter import Adapter, Call, Device, FRAME_BYTES, allowed_users, refuse_outbound
from media import FRAME, IDLE_PROMPT, RATE, Utterances, encode_wave, speak_parts
from send_link import call_url


def noise_frames(kind, rate, count):
    """Shared 145 Hz fan, deterministic broadband noise, and isolated click scenarios."""
    state, low = 17, 0.0
    length = rate // 50
    for tick in range(count):
        samples = []
        for j in range(length):
            i = tick * length + j
            state = (state * 1664525 + 1013904223) & 0xffffffff
            white = state / 2**31 - 1
            low = 0.85 * low + 0.15 * white
            if kind == "fan":
                sample = 0.032 * math.sin(2 * math.pi * 145 * i / rate) + 0.015 * low
            elif kind == "white":
                sample = 0.015 * white
            else:
                sample = 0.5 if i % 10001 == 0 else 0
            samples.append(int(32767 * sample))
        yield samples


class TelegramTests(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_registration_and_incoming_only(self):
        native = PyTgCalls(TelegramClient(MemorySession(), 1, "a" * 32), workers=2)
        native._app.request_call = refuse_outbound
        adapter = Adapter(native, None, allowed_users("99, 123"), "", "")
        adapter.register()
        with self.assertRaises(RuntimeError):
            await native._app.request_call(99)
        await adapter.incoming_call(None, SimpleNamespace(chat_id=5))
        self.assertIsNone(adapter.active)
        session = Call(adapter, 99)
        adapter.active = session
        await adapter.incoming_call(None, SimpleNamespace(chat_id=123))
        self.assertIs(adapter.active, session)
        session.input.queue = asyncio.Queue()
        await adapter.frames(None, SimpleNamespace(chat_id=123, frames=[SimpleNamespace(frame=bytes(960))]))
        self.assertTrue(session.input.queue.empty())
        for invalid in ("", "user-name", "-1000", "1,", "0"):
            with self.assertRaises(ValueError):
                allowed_users(invalid)
        self.assertEqual(call_url("https://voice.example/anruf"), "https://voice.example/anruf/")
        for invalid in ("http://voice.example/anruf", "https://voice.example/anruf/?token=test"):
            with self.assertRaises(ValueError):
                call_url(invalid)

    async def test_recording_and_playback(self):
        requests = []
        turn_id = ".".join(str(uuid.uuid4()) for _ in range(3))
        response_state = "reply"
        mock_calls = SimpleNamespace(send_frame=AsyncMock())

        async def gateway(req):
            requests.append((req.path, req.headers.get("X-Call-Id"), req.headers.get("Authorization")))
            if req.path == "/channel/utterance":
                uuid.UUID(req.headers["X-Request-Id"])
                with wave.open(io.BytesIO(await req.read())) as incoming:
                    self.assertEqual((incoming.getframerate(), incoming.getnchannels()), (16_000, 1))
                    self.assertGreater(incoming.getnframes(), 4_000)
                return web.json_response({"id": turn_id})
            if req.path == "/channel/turn/" + turn_id:
                return web.json_response({"state": response_state, "text": "[Intern](https://private.example/fixture)",
                                          "speechText": "Hallo."})
            if req.path == "/channel/speech/stream":
                raise web.HTTPNotFound()
            self.assertEqual(req.path, "/channel/speech")
            payload = await req.json()
            self.assertEqual(payload["text"], "Hallo." if response_state == "reply" else
                             "Bitte öffne den Hauptchat, um die Freigabe zu prüfen.")
            return web.Response(body=encode_wave(bytes(640)))

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", gateway)
        async with TestServer(app) as server, ClientSession() as http:
            adapter = Adapter(mock_calls, http, {99}, str(server.make_url("/")), "local-test")
            session = adapter.active = Call(adapter, 99)
            listening = asyncio.create_task(session.input.listen(session.speak))
            await asyncio.sleep(0)
            for tick in range(45):
                samples = [int((0.13 + 0.87 * math.sin((tick * 960 + t) / 2900) ** 2)
                               * (6000 * math.sin(2 * math.pi * 190 * (tick * 960 + t) / 48000)
                                  + 6000 * math.sin(2 * math.pi * 920 * (tick * 960 + t) / 48000)))
                           for t in range(960)]
                frame = SimpleNamespace(frame=struct.pack("<960h", *samples))
                await adapter.frames(None, SimpleNamespace(chat_id=99, frames=[frame]))
            # Send no more PCM. DTX pauses must end the utterance without another word.
            utterance = await asyncio.wait_for(listening, timeout=4)
            self.assertFalse(session.input.listening)
            self.assertTrue(await session.reply(utterance))
            self.assertEqual(mock_calls.send_frame.await_count, 2)
            for item in mock_calls.send_frame.await_args_list:
                target, device, pcm = item.args
                self.assertEqual((target, device, len(pcm)), (99, Device.MICROPHONE, FRAME_BYTES))
            response_state = "approval"
            self.assertFalse(await session.reply(utterance))
            self.assertEqual([r[0] for r in requests],
                             ["/channel/utterance", "/channel/turn/" + turn_id, "/channel/speech/stream",
                              "/channel/speech", "/channel/utterance", "/channel/turn/" + turn_id, "/channel/speech"])
            self.assertTrue(all(r[1:] == (session.id, "Bearer local-test") for r in requests))

    async def test_streamed_speech_sends_telegram_frames_before_synthesis_finishes(self):
        heard = asyncio.Event()
        frames = []

        async def send(_user, _device, frame):
            frames.append(frame)
            if any(frame):
                heard.set()

        async def gateway(req):
            self.assertEqual(req.headers["Authorization"], "Bearer fixture")
            self.assertEqual((await req.json())["text"], "Ein kurzer Test.")
            response = web.StreamResponse(headers={
                "Content-Type": "application/octet-stream", "X-Audio-Sample-Rate": "24000"})
            await response.prepare(req)
            pcm = struct.pack("<h", 500) * 4800
            await response.write(pcm[:13])
            await response.write(pcm[13:])
            await asyncio.wait_for(heard.wait(), 2)
            await response.write(pcm)
            return response

        app = web.Application()
        app.router.add_post("/channel/speech/stream", gateway)
        async with TestServer(app) as server, ClientSession() as http:
            call = Call(Adapter(SimpleNamespace(send_frame=send), http, {99}, str(server.make_url("/")), "fixture"), 99)
            await call.speak("Ein kurzer Test.")
        self.assertEqual(len(frames), 40)
        self.assertTrue(all(len(frame) == FRAME_BYTES for frame in frames))
        self.assertEqual(b"".join(frames)[:-2], (struct.pack("<h", 500) * (19200 - 1)))

    async def test_idle_call_warns_and_leaves_without_submitting_silence(self):
        calls = SimpleNamespace(play=AsyncMock(), record=AsyncMock(), leave_call=AsyncMock())
        session = Call(Adapter(calls, None, {99}, "", ""), 99)
        session.speak = AsyncMock()
        session.reply = AsyncMock()
        with patch("media.IDLE_SECONDS", 0.025), patch("media.REPLY_SECONDS", 0.015):
            await asyncio.wait_for(session.run(), 1)
        self.assertEqual([c.args[0] for c in session.speak.await_args_list],
                         ["Hallo, du kannst jetzt sprechen.", IDLE_PROMPT])
        session.reply.assert_not_awaited()
        calls.leave_call.assert_awaited_once_with(99)

    def test_stationary_noise_cannot_confirm_a_turn_or_refresh_the_deadline(self):
        for kind in ("fan", "white", "click"):
            detector = Utterances()
            for samples in noise_frames(kind, RATE, 62 * 50):
                self.assertIsNone(detector.push(struct.pack("<" + str(FRAME) + "h", *samples)), kind)
                self.assertFalse(detector.frames, kind)

    async def test_motor_noise_allows_reminder_then_quiet_answer_over_telegram_audio(self):
        adapter = Adapter(SimpleNamespace(), None, {99}, "", "")
        call = adapter.active = Call(adapter, 99)
        warned = asyncio.Event()
        clock = 0

        async def say(text):
            self.assertEqual(text, IDLE_PROMPT)
            warned.set()

        async def feed(samples):
            frame = SimpleNamespace(frame=struct.pack("<960h", *samples))
            await adapter.frames(None, SimpleNamespace(chat_id=99, frames=[frame]))
            await asyncio.sleep(0)

        with patch("media.monotonic", new=lambda: clock):
            listening = asyncio.create_task(call.input.listen(say))
            await asyncio.sleep(0)
            for frame in noise_frames("fan", 48000, 122):
                clock += 0.5
                await feed(frame)
                if warned.is_set():
                    break
            await asyncio.wait_for(warned.wait(), 1)
            self.assertTrue(call.input.listening)
            clock += 28
            for tick in range(26):
                def sample(j):
                    t = (tick * 960 + j) / 48000
                    gain = min(1, t / 0.06) * (0.2 + 0.8 * math.sin(16 * t) ** 2)
                    return int(280 * gain * (math.sin(2 * math.pi * 175 * t)
                                            + 0.65 * math.sin(2 * math.pi * 890 * t)))
                await feed([sample(j) for j in range(960)])
            # No more packets. DTX must still flush the reply before the grace expires.
            self.assertTrue((await asyncio.wait_for(listening, 3)).startswith(b"RIFF"))

    async def test_long_call_resumes_after_reminder_and_counts_only_listening_time(self):
        clock = 0
        turns = asyncio.Queue()
        spoken = asyncio.Queue()
        calls = SimpleNamespace(play=AsyncMock(), record=AsyncMock(), leave_call=AsyncMock())
        session = Call(Adapter(calls, None, {99}, "", ""), 99)

        async def speak(text):
            nonlocal clock
            self.assertFalse(session.input.listening)
            spoken.put_nowait(text)
            clock += 5  # The grace period starts after the announcement.

        async def reply(audio):
            nonlocal clock
            self.assertTrue(audio.startswith(b"RIFF"))
            self.assertFalse(session.input.listening)
            turns.put_nowait(True)
            clock += 65  # Long-running agent work takes no caller time.
            return True

        session.speak, session.reply = speak, reply
        samples = [int(9000 * (0.15 + 0.85 * math.sin(i / 980) ** 2) * math.sin(2 * math.pi * i * 220 / 16000)) for i in range(8_000)]
        voice = struct.pack("<8000h", *samples) + bytes(32000 * 2)
        quiet = bytes(640)
        with patch("media.monotonic", new=lambda: clock):
            async with asyncio.timeout(8):
                job = asyncio.create_task(session.run())
                await spoken.get()  # Greeting.
                for _ in range(70):
                    clock += 55
                    session.input.feed(voice)
                    await turns.get()
                self.assertGreater(clock, 2 * 3600)
                self.assertTrue(spoken.empty())
                clock += 59
                session.input.feed(quiet)
                await asyncio.sleep(0)
                self.assertTrue(spoken.empty())
                clock += 1
                session.input.feed(quiet)
                self.assertEqual(await spoken.get(), IDLE_PROMPT)
                clock += 29
                session.input.feed(voice)
                await turns.get()
                clock += 60
                session.input.feed(quiet)
                self.assertEqual(await spoken.get(), IDLE_PROMPT)
                clock += 29
                session.input.feed(quiet)
                await asyncio.sleep(0)
                self.assertFalse(job.done())
                clock += 1
                session.input.feed(quiet)
                await job
        calls.leave_call.assert_awaited_once_with(99)

    async def test_next_speech_segment_is_synthesized_during_playback(self):
        synthesized, played = [], []
        next_started = asyncio.Event()
        first = "Der erste Satz."
        second = "Und noch ein Wort. " * 9

        async def synthesize(text):
            synthesized.append(text)
            if len(synthesized) > 1:
                next_started.set()
            return text.encode()

        async def play(audio):
            played.append(audio.decode())
            if len(played) == 1:
                await asyncio.wait_for(next_started.wait(), 1)

        await speak_parts(first + " " + second, synthesize, play)
        self.assertEqual(synthesized, played)
        self.assertEqual(" ".join(played), (first + " " + second).strip())


if __name__ == "__main__":
    unittest.main()
