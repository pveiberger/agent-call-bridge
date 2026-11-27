import asyncio
import audioop
import collections
import io
import math
import re
import wave
from array import array
from time import monotonic

import webrtcvad


RATE = 16000
FRAME = RATE // 50
IDLE_SECONDS = 30
HOLD_SECONDS = 300
IDLE_PROMPT = "Bist du noch da?"


def encode_wave(pcm):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return out.getvalue()


def analysis_bands():
    """Fixed 20 ms Hann kernels, aligned with the WhatsApp linked-device speech bands."""
    edges = (1, 3, 5, 8, 11, 16, 23, 32, 45, 63, 90, 125, 160)
    window = [0.5 - 0.5 * math.cos(2 * math.pi * i / (FRAME - 1)) for i in range(FRAME)]
    bands = []
    for left, right in zip(edges, edges[1:]):
        bins = sorted({left, (left + right - 1) // 2, right - 1})
        band = []
        for k in bins:
            for basis in (math.sin, math.cos):
                kernel = array("h", (round(32767 * w * basis(2 * math.pi * k * i / FRAME))
                                     for i, w in enumerate(window)))
                # findfactor is dot(pcm, kernel) / dot(kernel, kernel).
                scale = sum(x * x for x in kernel) / (32767 * FRAME)
                band.append((kernel.tobytes(), scale))
        bands.append(band)
    return bands


BANDS = analysis_bands()


class Utterances:
    """20-ms PCM16 frames; keep the beginning and stop after a natural pause."""

    def __init__(self):
        self.vad = webrtcvad.Vad(2)
        self.recent = collections.deque(maxlen=3)
        self.floor = None
        self.quiet_frames = 0
        self.levels = collections.deque(maxlen=4)
        self.motion = 0
        self.reset()

    def reset(self):
        self.preroll = collections.deque(maxlen=24)
        self.votes = collections.deque(maxlen=4)
        self.frames = []
        self.silence = 0

    def speech(self, pcm):
        # Estimate stationary noise per band. A narrow, loud motor must not
        # conceal changing vowel formants in adjacent bands. PCM stays intact.
        level = audioop.rms(pcm, 2)
        # Help WebRTC detect hushed short answers. Only the analysis is amplified.
        gain = min(3, 350 / max(1, level))
        voiced = self.vad.is_speech(audioop.mul(pcm, 2, gain) if gain > 1 else pcm, RATE)
        if level < 4 or audioop.max(pcm, 2) > 10 * level:
            self.quiet_frames += 1
            self.recent.clear()
            self.levels.clear()
            self.motion = 0
            return False
        # Matched sine/cosine kernels run in C; each pair gives one bin's power.
        energy = [
            2 * sum((audioop.findfactor(pcm, kernel) * scale) ** 2 for kernel, scale in band) / len(band)
            for band in BANDS
        ]
        if self.quiet_frames >= 8:
            self.floor = None
        self.quiet_frames = 0
        self.recent.append(energy)
        self.levels.append(level)
        # Syllable-level variation also preserves soft speech in a quiet room.
        if len(self.levels) == 4:
            first = self.levels[0] + self.levels[1]
            last = self.levels[2] + self.levels[3]
            if max(first, last) > 1.32 * min(first, last):
                self.motion = 9
            else:
                self.motion = max(0, self.motion - 1)
        if len(self.recent) < 3:
            return False
        current = [sum(values) / 3 for values in zip(*self.recent)]
        if self.floor is None:
            self.floor = current
            return False
        ratios = [(value + 0.6) / (floor + 0.6) for value, floor in zip(current, self.floor)]
        # Let the floor rise slowly while a speaker is already talking. This
        # keeps the end of a phrase audible when the voice drops in volume.
        rise = 0.005 if self.frames else 0.036
        for i, (value, floor) in enumerate(zip(current, self.floor)):
            delta = value - floor
            self.floor[i] += 0.042 * delta if delta < 0 else rise * min(delta, 3 * floor + 2)
        threshold, strong = (2.1, 4.0) if self.frames else (2.8, 6.5)
        outstanding = sum(ratio > threshold for ratio in ratios) >= 2 or max(ratios) > strong
        return voiced and (self.motion > 0 or outstanding)

    def push(self, pcm):
        speech = self.speech(pcm)
        if not self.frames:
            self.preroll.append(pcm)
            self.votes.append(speech)
            if sum(self.votes) >= 3:
                self.frames = list(self.preroll)
            return None
        self.frames.append(pcm)
        self.silence = 0 if speech else self.silence + 1
        if self.silence < 36 and len(self.frames) < 2250:
            return None
        audio = encode_wave(b"".join(self.frames))
        self.reset()
        return audio


class CallInput:
    """Only accept incoming mono PCM16 at 16 kHz while waiting for a caller."""

    def __init__(self):
        self.queue = None
        self.hold = False

    @property
    def listening(self):
        return self.queue is not None

    def feed(self, pcm):
        if pcm and self.listening and not self.queue.full():
            self.queue.put_nowait(pcm)

    async def capture(self, seconds):
        detector = Utterances()
        pending = bytearray()
        deadline = monotonic() + seconds
        self.queue = asyncio.Queue(maxsize=128)
        try:
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return None
                # With DTX there may be no more packets after the last syllable.
                # With an entirely quiet caller, sleep until the idle deadline.
                needs_silence = bool(detector.frames or any(detector.votes))
                timeout = min(0.12, remaining) if needs_silence else remaining
                try:
                    async with asyncio.timeout(timeout):
                        pending.extend(await self.queue.get())
                except TimeoutError:
                    if not needs_silence:
                        return None
                    pending.extend(bytes(int(RATE * timeout) * 2))
                while len(pending) >= FRAME * 2:
                    clip = detector.push(bytes(pending[:FRAME * 2]))
                    del pending[:FRAME * 2]
                    if clip:
                        return clip
                    if detector.frames and detector.silence == 0:
                        deadline = monotonic() + IDLE_SECONDS
        finally:
            self.queue = None

    async def listen(self, say):
        hold, self.hold = self.hold, False
        clip = await self.capture(HOLD_SECONDS if hold else IDLE_SECONDS)
        if clip is not None or not hold:
            return clip
        # Microphone input remains gated during the prompt. Start the grace
        # period after playback has finished, even if synthesis took a while.
        async with asyncio.timeout(35):
            await say(IDLE_PROMPT)
        return await self.capture(IDLE_SECONDS)


def spoken_parts(text, first_limit=150, next_limit=420):
    rest = text.strip()
    limit = first_limit
    while len(rest) > limit:
        endings = list(re.finditer(r"[.!?;:](?=\s)|\n", rest[:limit]))
        split = endings[-1].end() if endings else rest.rfind(" ", 0, limit)
        if split < 1:
            split = limit
        yield rest[:split].strip()
        rest = rest[split:].lstrip()
        limit = next_limit
    if rest:
        yield rest


async def speak_parts(text, synthesize, play):
    """Play segments in order and synthesize at most one additional segment."""
    parts = iter(spoken_parts(text))
    first = next(parts, None)
    if first is None:
        return
    audio = await synthesize(first)
    for part in parts:
        upcoming = asyncio.create_task(synthesize(part))
        try:
            await play(audio)
            audio = await upcoming
        finally:
            if not upcoming.done():
                upcoming.cancel()
            await asyncio.gather(upcoming, return_exceptions=True)
    await play(audio)


class SpeechPlayback:
    """Stream replies when supported, or use the existing complete-WAV provider."""

    def __init__(self):
        self.supported = None

    async def speak(self, text, open_stream, rate, play_pcm, synthesize, play_wav):
        announcements = (IDLE_PROMPT, "Hi, hier ist Nod. Wie kann ich dir helfen?")
        if self.supported is not False and text not in announcements:
            for part in spoken_parts(text, 1200, 1200):
                async with open_stream(part) as response:
                    if response.status == 404 and self.supported is None:
                        self.supported = False
                        break
                    if (response.status != 200 or response.content_type != "application/octet-stream"
                            or response.headers.get("X-Audio-Sample-Rate") != "24000"):
                        raise ValueError("Invalid streaming speech response")
                    self.supported = True
                    await self.play_response(response, rate, play_pcm)
            else:
                return
        await speak_parts(text, synthesize, play_wav)

    @staticmethod
    async def play_response(response, rate, play_pcm):
        state = None
        pending = bytearray()
        remainder = b""
        count = 0
        block = rate // 10 * 2
        async for chunk in response.content.iter_chunked(8192):
            count += len(chunk)
            if count > 16 * 1024 * 1024:
                raise ValueError("Oversized streaming speech response")
            data = remainder + chunk
            end = len(data) & ~1
            remainder = data[end:]
            if end:
                pcm, state = audioop.ratecv(data[:end], 2, 1, 24000, rate, state)
                pending.extend(pcm)
            while len(pending) >= block:
                await play_pcm(bytes(pending[:block]))
                del pending[:block]
        if remainder or not count:
            raise ValueError("Incomplete streaming speech response")
        if pending:
            await play_pcm(bytes(pending))


def decoded_pcm(data):
    import av

    if len(data) > 12 * 1024 * 1024:
        raise ValueError("TTS response too large")
    converted = bytearray()
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    with av.open(io.BytesIO(data), format="wav") as source:
        for frame in source.decode(audio=0):
            for output in resampler.resample(frame):
                converted.extend(bytes(output.planes[0])[:output.samples * 2])
    for output in resampler.resample(None):
        converted.extend(bytes(output.planes[0])[:output.samples * 2])
    if not converted:
        raise ValueError("Empty TTS response")
    return bytes(converted)
