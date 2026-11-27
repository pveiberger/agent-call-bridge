import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as settled } from 'node:timers/promises';
import { playPcmSpeech } from '../web/pcm.js';

function audioClock() {
  const scheduled = [];
  return {
    scheduled,
    currentTime: 5,
    destination: {},
    createBuffer(_channels, length, sampleRate) {
      const pcm = new Float32Array(length);
      return { pcm, sampleRate, getChannelData: () => pcm };
    },
    createBufferSource() {
      return {
        connect() {},
        disconnect() {},
        stop() {
          this.stopped = true;
        },
        start(at) {
          this.at = at;
          scheduled.push(this);
        },
      };
    },
  };
}

function pcmResponse(body) {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Sample-Rate': '24000',
    },
  });
}

test('PCM16 survives odd packet boundaries and short final blocks across sentences', async () => {
  const samples = Int16Array.from(
    { length: 2671 },
    (_, i) => (i % 353) * 120 - 21120,
  );
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, i) => view.setInt16(i * 2, value, true));
  const context = audioClock(),
    requests = [];
  const open = async (text) => {
    requests.push(text);
    return pcmResponse(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 297)
            controller.enqueue(bytes.subarray(i, i + 297));
          controller.close();
        },
      }),
    );
  };
  let starts = 0,
    finished = false;
  const run = playPcmSpeech(
    context,
    new AbortController().signal,
    ['Erstens.', 'Zweitens.'],
    open,
    () => {
      starts++;
    },
  ).then(() => {
    finished = true;
  });
  await settled();
  assert.deepEqual(requests, ['Erstens.', 'Zweitens.']);
  assert.equal(starts, 1);
  assert.equal(finished, false);
  let position = 0;
  for (const source of context.scheduled) {
    assert.equal(source.buffer.sampleRate, 24_000);
    assert.ok(Math.abs(source.at - (5.015 + position / 24_000)) < 1e-9);
    for (const value of source.buffer.pcm) {
      assert.equal(value * 32768, samples[position++ % samples.length]);
    }
    source.onended();
  }
  await run;
  assert.equal(position, samples.length * 2);
});

test('playback bounds its lookahead and abort releases the response reader and all sources', async () => {
  const context = audioClock(),
    abort = new AbortController();
  let cancelled = false;
  const response = pcmResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(24_000 * 2 * 15));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const run = playPcmSpeech(
    context,
    abort.signal,
    ['Antwort'],
    async () => response,
    () => {},
  );
  await settled();
  assert.equal(context.scheduled.length, 24);
  abort.abort();
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(cancelled);
  assert.ok(context.scheduled.every((source) => source.stopped));
  assert.equal(response.body.locked, false);
});

test('malformed partial PCM samples are discarded when the stream ends', async () => {
  const context = audioClock();
  const run = playPcmSpeech(
    context,
    new AbortController().signal,
    ['Test'],
    async () => pcmResponse(new Uint8Array(3)),
    () => {},
  );
  await assert.rejects(run, /Unvollständiger Sprachstrom/);
  assert.equal(context.scheduled.length, 0);
});
