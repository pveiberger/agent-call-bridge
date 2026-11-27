import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate as settled } from 'node:timers/promises';

const prompt = 'Sind Sie noch da? Wenn ja, sprechen Sie jetzt.';

// Exercise the page's actual start button, worklet messages, HTTP requests and
// playback completion. The clock advances independently of microphone callbacks.
async function browser(t, getTurn, streamSpeech, intercept, devices = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new EventTarget();
  document.body = { dataset: {} };
  const elements = new Map();
  document.getElementById = (id) => {
    if (!elements.has(id))
      elements.set(id, Object.assign(new EventTarget(), { setAttribute() {} }));
    return elements.get(id);
  };
  const track = Object.assign(new EventTarget(), {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const requests = [],
    playing = [];
  let worklet,
    elapsed = 0;
  const audioNode = () => ({ connect: (next) => next, disconnect() {} });
  class Context {
    destination = {};
    get currentTime() {
      return elapsed / 1000;
    }
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    async resume() { await devices.resume?.(this); }
    async close() {
      this.state = 'closed';
    }
    createMediaStreamSource() {
      return audioNode();
    }
    createBiquadFilter() {
      return { ...audioNode(), frequency: {} };
    }
    createGain() {
      return { ...audioNode(), gain: {} };
    }
    createBuffer(_channels, length) {
      const samples = new Float32Array(length);
      return { unlock: length === 1, getChannelData: () => samples };
    }
    createBufferSource() {
      return {
        ...audioNode(),
        start() {
          if (!this.buffer.unlock) playing.push(this);
        },
        stop() {
          this.onended?.();
        },
      };
    }
    async decodeAudioData(bytes) {
      return { text: new TextDecoder().decode(bytes) };
    }
  }
  class Worklet {
    constructor() {
      worklet = Object.assign(this, audioNode());
      this.port = { postMessage() {}, close() {} };
    }
  }
  const window = Object.assign(new EventTarget(), {
    isSecureContext: true,
    AudioContext: Context,
    AudioWorkletNode: Worklet,
  });
  async function fetch(url, options) {
    const route = url.slice('/anruf/api/'.length);
    requests.push({
      route,
      body: options?.body,
      callId: options?.headers?.['X-Call-Id'],
    });
    const override = intercept?.(route, options);
    if (override) return override;
    if (route === 'speech/stream') return streamSpeech();
    const json = async () => {
      if (route === 'session')
        return {
          ok: true,
          agent: 'Nod',
          chatUrl: '/',
          speechStream: !!streamSpeech,
        };
      if (route === 'utterance') return { id: 'fixture-turn' };
      if (route === 'turn/fixture-turn') return getTurn();
      throw Error('Unexpected route: ' + route);
    };
    return {
      ok: true,
      json,
      async arrayBuffer() {
        assert.equal(route, 'speech');
        return new TextEncoder().encode(JSON.parse(options.body).text).buffer;
      },
    };
  }
  for (const [key, value] of Object.entries({
    document,
    window,
    location: { origin: 'https://fixture.example' },
    fetch,
    AudioWorkletNode: Worklet,
    performance: { now: () => elapsed },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          await devices.microphone?.();
          return stream;
        },
      },
    },
  })) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      saved
        ? Object.defineProperty(globalThis, key, saved)
        : delete globalThis[key],
    );
  }
  let client, state;
  if (devices.embedded) {
    const { createCallClient } = await import('../web/call-client.js');
    client = createCallClient({ onState: (next) => { state = next; } });
  } else {
    await import('../web/call.js?session=' + randomUUID());
    await settled();
    document.getElementById('toggle').dispatchEvent(new Event('click'));
    await settled();
  }
  const finishAudio = async () => {
    const source = playing.shift();
    assert.ok(source, 'expected audio playback');
    source.onended();
    await settled();
  };
  return {
    track,
    requests,
    client,
    playing,
    finishAudio,
    phase: () => state?.phase ?? document.body.dataset.phase,
    emit: (type) =>
      worklet.port.onmessage({ data: { type, wav: new ArrayBuffer(50) } }),
    async advance(ms) {
      elapsed += ms;
      t.mock.timers.tick(ms);
      await settled();
    },
    elapseWithoutTimers(ms) {
      elapsed += ms;
    },
    visibility(hidden) {
      document.hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    spoken: () =>
      requests
        .filter((r) => r.route === 'speech')
        .map((r) => JSON.parse(r.body).text),
    hangup: () =>
      document.getElementById('toggle').dispatchEvent(new Event('click')),
  };
}

test('preloading the in-chat call is passive and disposing releases a microphone granted after navigation', async (t) => {
  let grant;
  let microphoneRequests = 0;
  const call = await browser(t, null, null, null, {
    embedded: true,
    microphone() {
      microphoneRequests++;
      return new Promise((resolve) => { grant = resolve; });
    },
  });
  assert.equal(call.requests.length, 0);
  assert.equal(microphoneRequests, 0);
  void call.client.start();
  void call.client.start();
  await settled();
  assert.equal(microphoneRequests, 1);
  assert.equal(call.requests.filter((request) => request.route === 'session').length, 1);
  call.client.dispose();
  grant();
  await settled();
  assert.equal(call.track.stopped, true);
  await call.client.start();
  assert.equal(microphoneRequests, 1);
});

test('muting pending microphone access holds local capture through playback', async (t) => {
  let grant;
  const call = await browser(t, () => ({ state: 'reply', text: 'Vier.' }), null, null, {
    embedded: true,
    microphone: () => new Promise((resolve) => { grant = resolve; }),
  });
  const started = call.client.start();
  await settled();
  call.client.setMuted(true);
  grant();
  await started;
  assert.equal(call.track.enabled, false);
  call.emit('utterance');
  assert.ok(!call.requests.some(r => r.route === 'utterance'));
  call.client.setMuted(false);
  assert.equal(call.track.enabled, true);
  call.emit('utterance');
  await settled();
  assert.equal(call.phase(), 'speaking');
  call.client.setMuted(true);
  call.client.setMuted(false);
  assert.equal(call.track.enabled, false);
  call.client.setMuted(true);
  await call.finishAudio();
  await call.advance(180);
  assert.equal(call.phase(), 'listening');
  assert.equal(call.track.enabled, false);
  call.client.stop();
  assert.ok(call.track.stopped);
});

test('a stalled audio output releases its context and gives a speaker hint before requesting the microphone', async (t) => {
  let context, resolveOutput;
  let micRequests = 0;
  const call = await browser(t, null, null, null, {
    resume(ctx) {
      context = ctx;
      ctx.state = 'suspended';
      return new Promise((resolve) => { resolveOutput = resolve; });
    },
    microphone() { micRequests++; },
  });
  await call.advance(9_999);
  assert.equal(call.phase(), 'starting');
  await call.advance(1);
  assert.equal(call.phase(), 'error');
  assert.match(document.getElementById('detail').textContent, /Lautsprecher oder Kopfhörer/);
  assert.equal(context.state, 'closed');
  resolveOutput();
  await settled();
  assert.equal(micRequests, 0);
  assert.equal(call.phase(), 'error');
});

test('a brief audio route change preserves the call and a persistent interruption releases the mic', async (t) => {
  let context;
  const call = await browser(t, null, null, null, { resume(ctx) { context = ctx; } });
  context.state = 'interrupted';
  context.onstatechange();
  await call.advance(600);
  context.state = 'running';
  context.onstatechange();
  await call.advance(1000);
  assert.equal(call.phase(), 'listening');
  assert.equal(call.track.stopped, false);
  context.state = 'suspended';
  context.onstatechange();
  await call.advance(1000);
  assert.equal(call.phase(), 'idle');
  assert.equal(call.track.stopped, true);
  assert.equal(context.state, 'closed');
});

test('the audio output deadline leaves a pending microphone permission prompt open', async (t) => {
  let grant;
  const call = await browser(t, null, null, null, {
    microphone() { return new Promise((resolve) => { grant = resolve; }); },
  });
  await call.advance(120_000);
  assert.equal(call.phase(), 'starting');
  grant();
  await settled();
  assert.equal(call.phase(), 'listening');
  call.hangup();
});

test('silence with no audio frames prompts once, then releases the microphone after 30 listening seconds', async (t) => {
  const call = await browser(t);
  await call.advance(59_999);
  assert.equal(call.phase(), 'listening');
  assert.deepEqual(call.spoken(), []);
  await call.advance(1);
  assert.deepEqual(call.spoken(), [prompt]);
  assert.equal(call.track.enabled, false);
  await call.advance(120_000); // Timer waits for the actual end of playback.
  assert.equal(call.phase(), 'speaking');
  await call.finishAudio();
  await call.advance(160); // Speaker echo guard.
  await call.advance(29_999);
  assert.equal(call.track.enabled, true);
  assert.equal(call.track.stopped, false);
  await call.advance(1);
  assert.equal(call.phase(), 'idle');
  assert.equal(call.track.stopped, true);
  await call.advance(3_600_000);
  assert.deepEqual(call.spoken(), [prompt]);
  assert.ok(
    !call.requests.some(
      (r) => r.route === 'utterance' || r.route.startsWith('turn/'),
    ),
  );
});

test('browser speaks the bridge audio text and keeps the original reply on screen', async (t) => {
  const text = '[Plan](https://example.org/private-identifier)';
  const call = await browser(t, () => ({
    state: 'reply',
    text,
    speechText: 'Plan',
  }));
  call.emit('utterance');
  await settled();
  assert.deepEqual(call.spoken(), ['Plan']);
  assert.equal(document.getElementById('answer').textContent, text);
  call.hangup();
});

test('one transient GET at session and turn preserves the call, microphone and one submitted utterance', async (t) => {
  let sessions = 0,
    polls = 0;
  const retry = (route, options) => {
    if (route === 'session' && options.headers && ++sessions === 1)
      throw new TypeError('connection interrupted before receiving headers');
    if (route.startsWith('turn/') && ++polls === 1)
      return {
        ok: true,
        async json() {
          throw new TypeError('connection interrupted reading body');
        },
      };
  };
  const call = await browser(
    t,
    () => ({ state: 'reply', text: 'Ich bin da.' }),
    null,
    retry,
  );
  assert.equal(call.phase(), 'starting');
  await call.advance(300);
  assert.equal(call.phase(), 'listening');
  call.emit('utterance');
  await settled();
  assert.equal(call.phase(), 'working');
  await call.advance(300);
  assert.equal(call.phase(), 'speaking');
  assert.deepEqual(call.spoken(), ['Ich bin da.']);
  await call.finishAudio();
  await call.advance(160);
  assert.equal(call.phase(), 'listening');
  assert.equal(call.track.enabled, true);
  assert.equal(call.track.stopped, false);
  const activeRequests = call.requests.filter((r) => r.callId);
  assert.equal(new Set(activeRequests.map((r) => r.callId)).size, 1);
  assert.deepEqual(
    activeRequests.map((r) => r.route),
    [
      'session',
      'session',
      'utterance',
      'turn/fixture-turn',
      'turn/fixture-turn',
      'speech',
    ],
  );
  call.hangup();
});

for (const status of [401, 403, 502, 503, 504]) {
  test(
    'permanent GET failure ' + status + ' reaches the UI with bounded attempts',
    async (t) => {
      const fail = (route) =>
        route.startsWith('turn/') &&
        Response.json({ error: 'Statusfehler im Test.' }, { status });
      const call = await browser(t, null, null, fail);
      call.emit('utterance');
      await settled();
      if (status >= 500) assert.equal(call.phase(), 'working');
      await call.advance(300);
      assert.equal(call.phase(), 'error');
      assert.match(
        document.getElementById('detail').textContent,
        status === 401 ? /Melde dich an/ : /Statusfehler/,
      );
      assert.equal(
        call.requests.filter((r) => r.route.startsWith('turn/')).length,
        status >= 500 ? 2 : 1,
      );
      assert.equal(call.track.stopped, true);
      assert.deepEqual(call.spoken(), []);
    },
  );
}

test('hangup cancels the pending status retry', async (t) => {
  const call = await browser(
    t,
    null,
    null,
    (route) => route.startsWith('turn/') && Response.json({}, { status: 503 }),
  );
  call.emit('utterance');
  await settled();
  call.hangup();
  await call.advance(5000);
  assert.equal(call.phase(), 'idle');
  assert.equal(
    call.requests.filter((r) => r.route.startsWith('turn/')).length,
    1,
  );
  assert.equal(call.track.stopped, true);
});

test('a failed utterance POST is never replayed', async (t) => {
  const call = await browser(
    t,
    null,
    null,
    (route) => route === 'utterance' && Response.json({}, { status: 502 }),
  );
  call.emit('utterance');
  await settled();
  await call.advance(5000);
  assert.equal(call.phase(), 'error');
  assert.equal(call.requests.filter((r) => r.route === 'utterance').length, 1);
  assert.deepEqual(call.spoken(), []);
});

test('answering the prompt resets inactivity; slow tools and playback never use listening time', async (t) => {
  let reply;
  const answer = Array(4)
    .fill('Ich lese dir die mit dem Team vereinbarten Aufgaben vor.')
    .join(' ');
  const call = await browser(
    t,
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  await call.advance(60_000);
  await call.finishAudio();
  await call.advance(160);
  await call.advance(29_500);
  call.emit('voice');
  call.emit('activity');
  await call.advance(600);
  assert.equal(call.phase(), 'capturing');
  call.emit('utterance');
  await settled();
  assert.equal(call.phase(), 'working');
  await call.advance(3_600_001);
  assert.equal(call.phase(), 'working');
  reply({ state: 'reply', text: answer });
  await settled();
  assert.equal(call.phase(), 'speaking');
  assert.equal(call.playing.length, 1);
  assert.equal(
    call.spoken().length,
    3,
    'second reply segment fetched during first playback',
  );
  await call.advance(120_000);
  await call.finishAudio();
  await call.finishAudio();
  await call.advance(160);
  assert.equal(call.phase(), 'listening');
  await call.advance(60_000);
  assert.equal(call.playing[0].buffer.text, prompt);
  assert.equal(
    call.spoken().filter((s) => s === prompt).length,
    1,
    'use already synthesized prompt',
  );
  call.hangup();
  await settled();
  await call.advance(120_000);
  assert.equal(call.phase(), 'idle');
  assert.equal(call.track.stopped, true);
});

test('an active conversation can last over an hour without prompting or reconnecting', async (t) => {
  let polls = 0;
  const call = await browser(t, () =>
    ++polls % 2 ? { state: 'working' } : { state: 'reply', text: 'Ja.' },
  );
  for (let turn = 0; turn < 66; turn++) {
    await call.advance(56_000);
    call.emit('voice');
    call.emit('activity');
    call.emit('utterance');
    await settled();
    await call.advance(299);
    assert.equal(call.phase(), 'working');
    await call.advance(1);
    await call.finishAudio();
    await call.advance(160);
    assert.equal(call.phase(), 'listening');
  }
  assert.ok(!call.spoken().includes(prompt));
  assert.equal(call.spoken().length, 66);
  assert.equal(call.track.stopped, false);
  call.hangup();
  assert.ok(call.track.stopped);
});

test('a tab switch keeps the call open and recovers missed silence deadlines exactly once', async (t) => {
  const call = await browser(t);
  call.visibility(true);
  assert.equal(call.phase(), 'listening');
  assert.ok(!call.track.stopped);
  call.elapseWithoutTimers(67_000);
  call.visibility(false);
  call.visibility(false);
  await settled();
  assert.deepEqual(call.spoken(), [prompt]);
  await call.finishAudio();
  await call.advance(160);
  call.visibility(true);
  call.elapseWithoutTimers(31_000);
  call.visibility(false);
  assert.equal(call.phase(), 'idle');
  assert.ok(call.track.stopped);
  await call.advance(90_000);
  assert.deepEqual(call.spoken(), [prompt]);
});

test('streaming starts before EOF; partial audio is never resubmitted to another speech endpoint', async (t) => {
  let writer;
  const response = new Response(
    new ReadableStream({
      start(c) {
        writer = c;
      },
    }),
    {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Sample-Rate': '24000',
      },
    },
  );
  const call = await browser(
    t,
    () => ({ state: 'reply', text: 'Das ist die Antwort.' }),
    () => response,
  );
  call.emit('utterance');
  await settled();
  writer.enqueue(new Uint8Array(4800));
  await settled();
  assert.equal(call.phase(), 'speaking');
  assert.equal(call.playing.length, 1);
  assert.equal(call.track.enabled, false);
  writer.error(new Error('Network interrupted during audio'));
  await settled();
  assert.equal(call.phase(), 'error');
  assert.ok(call.track.stopped);
  assert.deepEqual(
    call.requests
      .filter((r) => r.route.startsWith('speech'))
      .map((r) => r.route),
    ['speech/stream'],
  );
});
