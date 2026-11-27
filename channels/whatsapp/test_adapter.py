import asyncio
import hashlib
import hmac
import io
import json
import math
import os
import struct
import time
import unittest
import uuid
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestClient, TestServer
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from adapter import Adapter, Call
from media import IDLE_PROMPT, RATE, encode_wave
from playback import ReplyTrack


def packet():
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"field": "calls", "value": {
        "messaging_product": "whatsapp", "metadata": {"phone_number_id": "business-test"},
        "calls": [{"event": "connect", "direction": "USER_INITIATED", "from": "owner-test",
                   "id": "test-call", "timestamp": str(int(time.time())),
                   "session": {"sdp": "test-offer", "sdp_type": "offer"}}]}}]}]}


class WhatsAppProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_webhook_challenge_signature_routing_and_freshness(self):
        cfg = SimpleNamespace(phone="business-test", owners={"owner-test"}, verify="verify", secret="test-secret")
        adapter = Adapter(cfg)
        delivered = []
        adapter.dispatch = delivered.append
        async with TestClient(TestServer(adapter.app())) as client:
            res = await client.get("/whatsapp/calls", params={"hub.mode": "subscribe", "hub.verify_token": "verify",
                                                              "hub.challenge": "test"})
            self.assertEqual((res.status, await res.text()), (200, "test"))
            self.assertEqual((await client.get("/whatsapp/calls")).status, 403)
            body = json.dumps(packet()).encode()
            self.assertEqual((await client.post("/whatsapp/calls", data=body)).status, 403)
            for change in ({}, {"from": "other"}, {"direction": "BUSINESS_INITIATED"}, {"timestamp": "0"},
                           {"phone_number_id": "wrong"}):
                payload = packet()
                value = payload["entry"][0]["changes"][0]["value"]
                if "phone_number_id" in change:
                    value["metadata"].update(change)
                else:
                    value["calls"][0].update(change)
                body = json.dumps(payload).encode()
                sig = hmac.digest(b"test-secret", body, hashlib.sha256).hex()
                self.assertEqual((await client.post("/whatsapp/calls", data=body, headers={
                    "X-Hub-Signature-256": "sha256=" + sig})).status, 200)
            self.assertEqual(len(delivered), 1)

    async def test_duplicate_connect_and_terminate(self):
        adapter = Adapter(SimpleNamespace(rtc=RTCConfiguration(iceServers=[])))
        item = packet()["entry"][0]["changes"][0]["value"]["calls"][0]
        async def wait(call):
            await call.ended.wait()
        with patch.object(Call, "run", wait):
            adapter.dispatch(item)
            job = adapter.calls[item["id"]].job
            adapter.dispatch(item)
            self.assertIs(job, adapter.calls[item["id"]].job)
            adapter.dispatch(dict(item, event="terminate"))
            await asyncio.gather(job, return_exceptions=True)
            adapter.dispatch(item)
            self.assertFalse(adapter.calls)

    async def test_no_incoming_audio_prompts_then_terminates_meta_call(self):
        cfg = SimpleNamespace(rtc=RTCConfiguration(iceServers=[]))
        call = Call(SimpleNamespace(config=cfg), packet()["entry"][0]["changes"][0]["value"]["calls"][0])
        await call.peer.close()
        call.peer = SimpleNamespace(on=lambda _: lambda f: f, setRemoteDescription=AsyncMock(),
                                    addTrack=lambda _: None, setLocalDescription=AsyncMock(),
                                    createAnswer=AsyncMock(), localDescription=SimpleNamespace(sdp="test"),
                                    close=AsyncMock())
        call.ready.set()
        call.control = AsyncMock()
        call.say = AsyncMock()
        call.converse = AsyncMock()
        with patch("media.IDLE_SECONDS", 0.025), patch("media.REPLY_SECONDS", 0.015):
            await asyncio.wait_for(call.run(), 1)
        call.say.assert_awaited_once_with(IDLE_PROMPT)
        call.converse.assert_not_awaited()
        self.assertEqual([c.args[0] for c in call.control.await_args_list],
                         ["pre_accept", "accept", "terminate"])

    async def test_webrtc_and_conversation(self):
        await self.webrtc_conversation(streaming=False)

    async def test_webrtc_speech_reaches_caller_while_http_is_still_streaming(self):
        await self.webrtc_conversation(streaming=True)

    async def webrtc_conversation(self, streaming):
        """Real ICE, DTLS, SRTP and Opus between two local peers; no external signaling."""
        config = RTCConfiguration(iceServers=[])
        caller = RTCPeerConnection(config)
        microphone = ReplyTrack()
        caller.addTrack(microphone)
        heard = asyncio.Event()
        hearing = None
        async def listen(track):
            while True:
                frame = await track.recv()
                samples = memoryview(bytes(frame.planes[0])).cast("h")
                if max(samples) > 500:
                    heard.set()
        @caller.on("track")
        def track_started(track):
            nonlocal hearing
            hearing = asyncio.create_task(listen(track))
        await caller.setLocalDescription(await caller.createOffer())
        item = {"id": "test-call", "session": {"sdp": caller.localDescription.sdp}}
        call = Call(SimpleNamespace(config=SimpleNamespace(rtc=config)), item)
        actions = []
        accepted = asyncio.Event()
        async def signal(action, answer=None):
            actions.append((action, answer))
            if action == "pre_accept":
                await caller.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
            if action == "accept":
                accepted.set()
        call.control = signal
        tone = [int(11000 * math.sin(2 * math.pi * 220 * i / RATE) * (0.65 + 0.35 * math.sin(i / 283)))
                for i in range(RATE)]
        tone_wave = encode_wave(struct.pack("<" + str(len(tone)) + "h", *tone))
        received = []
        turn = ".".join(str(uuid.uuid4()) for _ in range(3))
        async def bridge(method, path, **kwargs):
            if path == "/channel/utterance":
                with wave.open(io.BytesIO(kwargs["data"]), "rb") as sample:
                    self.assertEqual((sample.getframerate(), sample.getnchannels(), sample.getsampwidth()), (RATE, 1, 2))
                    self.assertGreater(sample.getnframes(), RATE // 2)
                received.append(str(uuid.UUID(kwargs["headers"]["X-Request-Id"])))
                return {"id": turn}
            if path == "/channel/turn/" + turn:
                return {"state": "reply", "text": "[Intern](https://private.example/fixture)", "speechText": "Antwort."}
            self.assertEqual((path, kwargs["json"]), ("/channel/speech", {"text": "Antwort."}))
            return tone_wave
        call.bridge = bridge
        if streaming:
            async def stream(req):
                self.assertEqual(req.headers["Authorization"], "Bearer fixture")
                self.assertEqual(req.headers["X-Call-Id"], call.id)
                self.assertEqual(await req.json(), {"text": "Antwort."})
                response = web.StreamResponse(headers={"Content-Type": "application/octet-stream",
                                                       "X-Audio-Sample-Rate": "24000"})
                await response.prepare(req)
                data = struct.pack("<12000h", *(int(10000 * math.sin(i / 11)) for i in range(12000)))
                await response.write(data[:17])
                await response.write(data[17:])
                await asyncio.wait_for(heard.wait(), 3)
                return response

            app = web.Application()
            app.router.add_post("/channel/speech/stream", stream)
            server = await self.enterAsyncContext(TestServer(app))
            call.adapter.http = await self.enterAsyncContext(ClientSession())
            call.adapter.config.bridge = str(server.make_url("/")).rstrip("/")
            call.adapter.config.bridge_secret = "fixture"
        else:
            call.playback.supported = False
        job = asyncio.create_task(call.run())
        try:
            await asyncio.wait_for(accepted.wait(), 8)
            if not streaming:
                # Transport the fan through the same Opus/DTLS path as caller speech.
                state, low, samples = 55, 0.0, []
                for i in range(2 * RATE):
                    state = (state * 1664525 + 1013904223) & 0xffffffff
                    low = 0.85 * low + 0.15 * (state / 2**31 - 1)
                    value = 0.032 * math.sin(2 * math.pi * 145 * i / RATE) + 0.015 * low
                    samples.append(int(32767 * value))
                await microphone.play(encode_wave(struct.pack("<" + str(len(samples)) + "h", *samples)))
                await asyncio.sleep(1.1)
                self.assertEqual(received, [])
            fixture = os.environ.get("WA_TEST_AUDIO")
            if fixture:
                with open(fixture, "rb") as src:
                    sample = src.read()
            else:
                sample = tone_wave
            await microphone.play(sample)
            await asyncio.wait_for(heard.wait(), 10)
            self.assertEqual(len(received), 1)
            self.assertEqual([x[0] for x in actions], ["pre_accept", "accept"])
            self.assertEqual(actions[0][1], actions[1][1])
        finally:
            call.remote_ended = True
            call.ended.set()
            await job
            if hearing:
                hearing.cancel()
                await asyncio.gather(hearing, return_exceptions=True)
            await caller.close()


if __name__ == "__main__":
    unittest.main()
