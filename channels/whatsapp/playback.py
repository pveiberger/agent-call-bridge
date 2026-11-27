import asyncio
import fractions
import time

import av
from aiortc import AudioStreamTrack

from media import FRAME, RATE, decoded_pcm


class ReplyTrack(AudioStreamTrack):
    """Clock the outbound RTP at 20 ms even when the assistant is listening."""

    def __init__(self):
        super().__init__()
        self.audio = b""
        self.offset = 0
        self.drained = asyncio.Event()
        self.drained.set()
        self.origin = None
        self.pts = 0

    async def play(self, data):
        self.audio = decoded_pcm(data)
        self.offset = 0
        self.drained.clear()
        await self.drained.wait()
        await asyncio.sleep(0.35)

    async def recv(self):
        now = time.monotonic()
        if self.origin is None or now - (self.origin + self.pts / RATE) > 0.12:
            self.origin = now - self.pts / RATE
        await asyncio.sleep(max(0, self.origin + self.pts / RATE - now))
        pcm = self.audio[self.offset:self.offset + FRAME * 2]
        self.offset += len(pcm)
        if self.offset >= len(self.audio) and self.audio:
            self.audio = b""
            self.offset = 0
            self.drained.set()
        frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME)
        frame.planes[0].update(pcm.ljust(FRAME * 2, b"\0"))
        frame.pts, frame.sample_rate = self.pts, RATE
        frame.time_base = fractions.Fraction(1, RATE)
        self.pts += FRAME
        return frame
