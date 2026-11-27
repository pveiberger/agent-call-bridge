import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceDetector } from '../web/vad.js';

// A voiced syllable changes in amplitude and spectral content. A steady pure
// tone and a DC step are useful noise fixtures, but do not represent a speaker.
function syllables(rate, frames, level = 0.15) {
  return Float32Array.from({ length: frames * rate / 50 }, (_, i) => {
    const t = i / rate;
    const envelope = 0.12 + 0.88 * Math.sin(2 * Math.PI * 3 * t) ** 2;
    const fundamental = Math.sin(2 * Math.PI * 173 * t);
    const formant = Math.sin(2 * Math.PI * 730 * t);
    return level * Math.min(1, t / 0.035) * envelope * (fundamental + 0.45 * formant);
  });
}

for (const rate of [44_100, 48_000]) {
  test(`browser sends one 16 kHz WAV per spoken turn at ${rate} Hz`, () => {
    const messages = [];
    const detector = new VoiceDetector(rate, (event) => messages.push(event));
    const say = (frames) => detector.feed(syllables(rate, frames));
    const pause = (frames) => detector.feed(new Float32Array(frames * rate / 50));

    detector.arm(true);
    pause(20);
    say(24);
    pause(60);
    const kinds = () =>
      messages.filter((x) => x.type !== 'activity').map((x) => x.type);
    assert.deepEqual(kinds(), ['voice', 'utterance']);
    assert.ok(messages.some((x) => x.type === 'activity'));
    const wav = Buffer.from(messages.at(-1).wav);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.subarray(44).some((byte) => byte !== 0));

    // The previous utterance closed the microphone until playback has ended.
    say(30);
    pause(70);
    assert.deepEqual(kinds(), ['voice', 'utterance']);
    detector.arm(true);
    say(30);
    pause(70);
    assert.deepEqual(kinds(), ['voice', 'utterance', 'voice', 'utterance']);
  });
}

test('transient clicks cannot extend the call; sustained speech tolerates hesitation', () => {
  const events = [];
  const vad = new VoiceDetector(16000, (event) => events.push(event.type));
  const say = (frames) => vad.feed(syllables(16_000, frames));
  const pause = (frames) => vad.feed(new Float32Array(320 * frames));
  vad.arm(true);
  const click = new Float32Array(320);
  click[42] = 0.6;
  vad.feed(click);
  pause(55);
  assert.deepEqual(events, []);
  say(20);
  pause(30); // 600 ms hesitation
  say(12);
  pause(48); // 960 ms hesitation after the speaker has shown a slower cadence
  assert.ok(events.includes('activity'));
  assert.ok(!events.includes('utterance'));
  say(30);
  pause(55);
  assert.equal(events.filter((kind) => kind === 'utterance').length, 1);
});

test('uninterrupted speech is submitted after an 800 ms endpoint pause', () => {
  const events = [];
  const vad = new VoiceDetector(16_000, (event) => events.push(event.type));
  vad.arm(true);
  vad.feed(syllables(16_000, 54));
  vad.feed(new Float32Array(320 * 39));
  assert.ok(!events.includes('utterance'));
  vad.feed(new Float32Array(320));
  assert.equal(events.at(-1), 'utterance');
});

test('stationary fan, broadband noise and clicks cannot keep an unattended microphone active', () => {
  const rate = 16_000;
  for (const kind of ['fan', 'white noise', 'clicks']) {
    const events = [];
    const detector = new VoiceDetector(rate, (event) => events.push(event.type));
    detector.arm(true);
    detector.feed(new Float32Array(rate * 2));
    let state = 55, lowpass = 0;
    for (let frame = 0; frame < 3100; frame++) {
      const samples = Float32Array.from({ length: 320 }, (_, j) => {
        const i = frame * 320 + j;
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const white = state / 2 ** 31 - 1;
        lowpass = 0.85 * lowpass + 0.15 * white;
        if (kind === 'fan') return 0.032 * Math.sin(2 * Math.PI * 145 * i / rate) + 0.015 * lowpass;
        if (kind === 'white noise') return 0.015 * white;
        return i % 10001 === 0 ? 0.5 : 0;
      });
      detector.feed(samples);
    }
    detector.feed(new Float32Array(rate * 2));
    assert.deepEqual(events, [], kind);
    detector.feed(syllables(rate, 55, 0.006));
    detector.feed(new Float32Array(rate * 2));
    assert.ok(events.includes('utterance'), kind + ' followed by quiet speech');
  }
});


test('a tentative pause preserves the exact final audio unless speech continues', () => {
  const rate = 48_000;
  for (const continued of [false, true]) {
    const events = [];
    const detector = new VoiceDetector(rate, (event) => events.push(event), true);
    const say = () => detector.feed(syllables(rate, 26));
    const pause = (frames) => detector.feed(new Float32Array(frames * rate / 50));
    detector.arm(true);
    pause(20);
    say();
    pause(30);
    assert.equal(events.filter((e) => e.type === 'prepare').length, 1);
    assert.equal(events.some((e) => e.type === 'utterance'), false);
    if (continued) say();
    pause(75);
    const prepared = events.filter((e) => e.type === 'prepare');
    const final = events.filter((e) => e.type === 'utterance');
    assert.equal(final.length, 1);
    assert.deepEqual(Buffer.from(prepared.at(-1).wav), Buffer.from(final[0].wav));
    assert.equal(events.some((e) => e.type === 'continued'), continued);
    if (continued) assert.notDeepEqual(Buffer.from(prepared[0].wav), Buffer.from(final[0].wav));
  }
});
