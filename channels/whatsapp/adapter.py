import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

import aiohttp
import av
from aiohttp import web
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError

from media import FRAME, RATE, Utterances
from playback import ReplyTrack


def setting(name):
    filename = os.environ.get(name + "_FILE")
    return Path(filename).read_text().strip() if filename else os.environ.get(name, "").strip()


class Config:
    def __init__(self):
        self.phone = setting("WA_PHONE_NUMBER_ID")
        self.owners = {s.strip().removeprefix("+") for s in setting("WA_ALLOWED_SENDERS").split(",") if s.strip()}
        self.token = setting("WA_ACCESS_TOKEN")
        self.secret = setting("WA_APP_SECRET")
        self.verify = setting("WA_VERIFY_TOKEN")
        self.version = setting("WA_GRAPH_VERSION")
        self.bridge = (setting("BRIDGE_URL") or "http://bridge:8091").rstrip("/")
        self.bridge_secret = setting("BRIDGE_CHANNEL_SECRET")
        if not re.fullmatch(r"[0-9]+", self.phone) or not re.fullmatch(r"v[0-9]+\.[0-9]+", self.version):
            raise ValueError("Set WA_PHONE_NUMBER_ID and WA_GRAPH_VERSION")
        if not self.owners or not all(re.fullmatch(r"[0-9]{6,15}|bsuid:[A-Za-z0-9_.:-]{1,128}", s) for s in self.owners):
            raise ValueError("Set WA_ALLOWED_SENDERS to the authorized caller identifiers")
        if not all((self.secret, self.verify, self.token, self.bridge_secret)):
            raise ValueError("Set webhook, Graph API and bridge credentials")
        if urlsplit(self.bridge).scheme not in ("http", "https"):
            raise ValueError("Invalid bridge URL")
        servers = json.loads(setting("WA_ICE_SERVERS_JSON") or "[]")
        self.rtc = RTCConfiguration(iceServers=[RTCIceServer(**s) for s in servers])


def authenticated_events(payload, config):
    if not isinstance(payload, dict) or payload.get("object") != "whatsapp_business_account":
        return
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            if (change.get("field") != "calls" or value.get("messaging_product") != "whatsapp"
                    or (value.get("metadata") or {}).get("phone_number_id") != config.phone):
                continue
            for call in value.get("calls") or []:
                if not isinstance(call, dict) or not isinstance(call.get("id"), str) or not 1 <= len(call["id"]) <= 250:
                    continue
                if call.get("event") == "terminate":
                    yield call
                    continue
                if call.get("direction") != "USER_INITIATED" or call.get("event") != "connect":
                    continue
                sender = str(call.get("from", "")).removeprefix("+")
                scoped = "bsuid:" + str(call.get("from_user_id", ""))
                if sender not in config.owners and scoped not in config.owners:
                    continue
                try:
                    age = time.time() - int(call["timestamp"])
                except (KeyError, ValueError, TypeError):
                    continue
                offer = call.get("session") or {}
                if -30 <= age <= 65 and offer.get("sdp_type") == "offer" and isinstance(offer.get("sdp"), str):
                    yield call


def spoken_parts(text):
    # The bridge accepts 1,600 characters per request. Prefer complete sentences.
    text = text.strip()
    while text:
        if len(text) <= 500:
            yield text
            break
        cuts = [m.end() for m in re.finditer(r"[.!?](?=\s)|\n", text[:500])]
        space = text.rfind(" ", 0, 500)
        end = cuts[-1] if cuts else (space if space > 0 else 500)
        yield text[:end].strip()
        text = text[end:].strip()


class Call:
    def __init__(self, adapter, event):
        self.adapter = adapter
        self.external_id = event["id"]
        self.id = str(uuid.uuid4())
        self.offer = event["session"]["sdp"]
        self.peer = RTCPeerConnection(adapter.config.rtc)
        self.track = ReplyTrack()
        self.ended = asyncio.Event()
        self.ready = asyncio.Event()
        self.remote_ended = False
        self.accepted = False
        self.receiver = None
        self.turn = None
        self.job = None

    async def control(self, action, answer=None):
        cfg = self.adapter.config
        body = {"messaging_product": "whatsapp", "call_id": self.external_id, "action": action}
        if answer is not None:
            body["session"] = {"sdp_type": "answer", "sdp": answer}
        url = f"https://graph.facebook.com/{cfg.version}/{cfg.phone}/calls"
        async with self.adapter.http.post(url, json=body, allow_redirects=False,
                                          timeout=aiohttp.ClientTimeout(total=8, connect=4),
                                          headers={"Authorization": "Bearer " + cfg.token}) as res:
            if res.status != 200 or (await res.json()).get("success") is not True:
                raise RuntimeError(f"Graph call control returned HTTP {res.status}")

    async def run(self):
        try:
            @self.peer.on("connectionstatechange")
            async def connection_changed():
                if self.peer.connectionState == "connected":
                    self.ready.set()
                if self.peer.connectionState in ("closed", "failed"):
                    self.ended.set()

            @self.peer.on("track")
            def audio(track):
                if track.kind == "audio" and self.receiver is None:
                    self.receiver = asyncio.create_task(self.receive(track))

            await self.peer.setRemoteDescription(RTCSessionDescription(sdp=self.offer, type="offer"))
            self.peer.addTrack(self.track)
            await self.peer.setLocalDescription(await self.peer.createAnswer())
            answer = self.peer.localDescription.sdp
            await self.control("pre_accept", answer)
            await asyncio.wait_for(self.ready.wait(), 22)
            await self.control("accept", answer)
            self.accepted = True
            await asyncio.wait_for(self.ended.wait(), 2 * 3600)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning("Call ended during processing (%s)", type(exc).__name__)
        finally:
            tasks = [t for t in (self.receiver, self.turn) if t is not None]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.track.stop()
            await self.peer.close()
            if not self.remote_ended:
                with contextlib.suppress(Exception):
                    await self.control("terminate" if self.accepted else "reject")

    async def receive(self, incoming):
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        fifo = av.AudioFifo()
        detector = Utterances()
        try:
            while True:
                frame = await incoming.recv()
                frame.pts = None
                for converted in resampler.resample(frame):
                    fifo.write(converted)
                while fifo.samples >= FRAME:
                    frame = fifo.read(FRAME)
                    if not self.accepted or (self.turn and not self.turn.done()):
                        detector.reset()
                        continue
                    clip = detector.push(bytes(frame.planes[0])[:FRAME * 2])
                    if clip:
                        self.turn = asyncio.create_task(self.converse(clip))
        except MediaStreamError:
            pass
        except Exception as exc:
            logging.warning("Incoming audio ended (%s)", type(exc).__name__)
        finally:
            self.ended.set()

    async def bridge(self, method, path, **kwargs):
        cfg = self.adapter.config
        headers = {"Authorization": "Bearer " + cfg.bridge_secret, "X-Call-Id": self.id}
        headers.update(kwargs.pop("headers", {}))
        async with self.adapter.http.request(method, cfg.bridge + path, headers=headers,
                                             allow_redirects=False, **kwargs) as res:
            if res.status not in (200, 201, 202):
                raise RuntimeError(f"Bridge HTTP {res.status}")
            return await res.read() if path == "/channel/speech" else await res.json()

    async def say(self, text):
        for part in spoken_parts(text):
            raw = await self.bridge("POST", "/channel/speech", json={"text": part})
            await self.track.play(raw)

    async def converse(self, clip):
        try:
            async with asyncio.timeout(360):
                sent = await self.bridge("POST", "/channel/utterance", data=clip, headers={
                    "Content-Type": "audio/wav", "X-Request-Id": str(uuid.uuid4())})
                turn_id = sent["id"]
                if not isinstance(turn_id, str) or not 0 < len(turn_id) <= 1024 or turn_id in (".", ".."):
                    raise ValueError("Invalid bridge turn identifier")
                turn_path = "/channel/turn/" + quote(turn_id, safe="")
                while True:
                    item = await self.bridge("GET", turn_path)
                    if item["state"] != "working":
                        break
                    await asyncio.sleep(0.9)
                if item["state"] == "approval":
                    await self.say("Dein Assistent braucht deine Bestätigung. Bitte öffne seinen Chat.")
                elif item["state"] == "reply" and item.get("text"):
                    await self.say(item["text"])
                else:
                    raise RuntimeError("No reply")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logging.warning("Voice turn incomplete (%s)", type(exc).__name__)
            with contextlib.suppress(Exception):
                async with asyncio.timeout(20):
                    await self.say("Die Antwort konnte gerade nicht übertragen werden.")


class Adapter:
    def __init__(self, config):
        self.config = config
        self.calls = {}
        self.recent = {}
        self.http = None

    def dispatch(self, item):
        key = item["id"]
        active = self.calls.get(key)
        now = time.monotonic()
        self.recent = {k: expiry for k, expiry in self.recent.items() if expiry > now}
        if item["event"] == "terminate":
            self.recent[key] = now + 120
            if active and not active.remote_ended:
                active.remote_ended = True
                active.job.cancel()
            return
        if self.calls or key in self.recent:
            return
        call = Call(self, item)
        self.calls[key] = call
        self.recent[key] = now + 120
        call.job = asyncio.create_task(call.run())
        call.job.add_done_callback(lambda _: self.calls.pop(key, None))

    async def verify(self, req):
        supplied = req.query.get("hub.verify_token", "")
        if req.query.get("hub.mode") != "subscribe" or not hmac.compare_digest(
                self.config.verify.encode(), supplied.encode()):
            raise web.HTTPForbidden()
        return web.Response(text=req.query.get("hub.challenge", ""))

    async def webhook(self, req):
        raw = await req.read()
        expected = "sha256=" + hmac.digest(self.config.secret.encode(), raw, hashlib.sha256).hex()
        actual = req.headers.get("X-Hub-Signature-256", "")
        if not hmac.compare_digest(expected.encode(), actual.encode()):
            raise web.HTTPForbidden()
        try:
            events = list(authenticated_events(json.loads(raw), self.config))
        except (ValueError, AttributeError, TypeError):
            raise web.HTTPBadRequest() from None
        for item in events:
            self.dispatch(item)
        return web.Response(text="OK")

    async def lifespan(self, _app):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=140, connect=8)) as self.http:
            yield
            jobs = [call.job for call in list(self.calls.values())]
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)

    def app(self):
        app = web.Application(client_max_size=256 * 1024)
        app.cleanup_ctx.append(self.lifespan)
        app.router.add_get("/whatsapp/calls", self.verify)
        app.router.add_post("/whatsapp/calls", self.webhook)
        return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    web.run_app(Adapter(Config()).app(), host="0.0.0.0", port=8092, access_log=None, print=None)
