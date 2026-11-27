import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceDetector } from '../web/vad.js';

for (const rate of [44_100, 48_000]) {
  test(`browser sends one 16 kHz WAV per spoken turn at ${rate} Hz`, () => {
    const messages = [];
    const detector = new VoiceDetector(rate, (event) => messages.push(event));
    const voice = Float32Array.from({ length: rate / 50 }, (_, i) =>
      0.18 * Math.sin((2 * Math.PI * 220 * i) / rate),
    );
    const silence = new Float32Array(voice.length);
    const feed = (sample, count) => {
      for (let i = 0; i < count; i++) detector.feed(sample);
    };

    detector.arm(true);
    feed(silence, 20);
    feed(voice, 24);
    feed(silence, 60);
    assert.deepEqual(messages.map((x) => x.type), ['voice', 'utterance']);
    const wav = Buffer.from(messages[1].wav);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.subarray(44).some((byte) => byte !== 0));

    // The previous utterance closed the microphone until playback has ended.
    feed(voice, 30);
    feed(silence, 70);
    assert.equal(messages.length, 2);
    detector.arm(true);
    feed(voice, 30);
    feed(silence, 70);
    assert.deepEqual(messages.slice(2).map((x) => x.type), ['voice', 'utterance']);
  });
}
