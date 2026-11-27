import asyncio
import io
import math
import struct
import unittest
import uuid
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from pytgcalls import PyTgCalls
from telethon import TelegramClient
from telethon.sessions import MemorySession

from adapter import Adapter, Call, Device, FRAME_BYTES, allowed_users, refuse_outbound
from media import encode_wave
from send_link import call_url


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
        session.ready = True
        await adapter.frames(None, SimpleNamespace(chat_id=123, frames=[SimpleNamespace(frame=bytes(960))]))
        self.assertTrue(session.incoming.empty())
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
                return web.json_response({"state": response_state, "text": "Hallo."})
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
            listening = asyncio.create_task(session.listen())
            await asyncio.sleep(0)
            for tick in range(45):
                samples = [int(6000 * math.sin(2 * math.pi * 190 * (tick * 960 + t) / 48000)
                               + 6000 * math.sin(2 * math.pi * 920 * (tick * 960 + t) / 48000))
                           for t in range(960)]
                frame = SimpleNamespace(frame=struct.pack("<960h", *samples))
                await adapter.frames(None, SimpleNamespace(chat_id=99, frames=[frame]))
            # Send no more PCM. DTX pauses must end the utterance without another word.
            utterance = await asyncio.wait_for(listening, timeout=4)
            self.assertFalse(session.ready)
            self.assertTrue(await session.reply(utterance))
            self.assertEqual(mock_calls.send_frame.await_count, 2)
            for item in mock_calls.send_frame.await_args_list:
                target, device, pcm = item.args
                self.assertEqual((target, device, len(pcm)), (99, Device.MICROPHONE, FRAME_BYTES))
            response_state = "approval"
            self.assertFalse(await session.reply(utterance))
            self.assertEqual([r[0] for r in requests],
                             ["/channel/utterance", "/channel/turn/" + turn_id, "/channel/speech"] * 2)
            self.assertTrue(all(r[1:] == (session.id, "Bearer local-test") for r in requests))


if __name__ == "__main__":
    unittest.main()
