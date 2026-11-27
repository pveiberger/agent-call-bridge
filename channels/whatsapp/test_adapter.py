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
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from adapter import Adapter, Call
from media import RATE, encode_wave
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

    async def test_webrtc_and_conversation(self):
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
                return {"state": "reply", "text": "Antwort."}
            self.assertEqual((path, kwargs["json"]), ("/channel/speech", {"text": "Antwort."}))
            return tone_wave
        call.bridge = bridge
        job = asyncio.create_task(call.run())
        try:
            await asyncio.wait_for(accepted.wait(), 8)
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
