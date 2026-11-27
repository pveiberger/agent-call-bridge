import collections
import io
import wave

import webrtcvad


RATE = 16000
FRAME = RATE // 50


def encode_wave(pcm):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return out.getvalue()


class Utterances:
    """20-ms PCM16 frames; keep the beginning and stop after a natural pause."""

    def __init__(self):
        self.vad = webrtcvad.Vad(2)
        self.reset()

    def reset(self):
        self.preroll = collections.deque(maxlen=12)
        self.votes = collections.deque(maxlen=4)
        self.frames = []
        self.silence = 0

    def push(self, pcm):
        speech = self.vad.is_speech(pcm, RATE)
        if not self.frames:
            self.preroll.append(pcm)
            self.votes.append(speech)
            if sum(self.votes) >= 3:
                self.frames = list(self.preroll)
            return None
        self.frames.append(pcm)
        self.silence = 0 if speech else self.silence + 1
        if self.silence < 43 and len(self.frames) < 2250:
            return None
        audio = encode_wave(b"".join(self.frames))
        self.reset()
        return audio


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
