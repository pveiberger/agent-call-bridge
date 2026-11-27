import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { realtimeCall, requiresProject, ringback } from '../web/realtime.js';

test('ringback schedules two 425 Hz pulses across three seconds on the speaker bus', async () => {
  const signal = new AbortController();
  const oscillator = {
    frequency: {},
    connect: (g) => g,
    start: (t) => assert.equal(t, 5),
    stop(t) {
      this.until = t;
    },
    disconnect() {},
  };
  const pulses = [];
  const gain = {
    gain: {
      setValueAtTime() {},
      linearRampToValueAtTime(v, t) {
        pulses.push([v, t]);
      },
    },
    connect() {},
    disconnect() {},
  };
  const ring = ringback(
    {
      currentTime: 5,
      createOscillator: () => oscillator,
      createGain: () => gain,
    },
    signal.signal,
  );
  assert.equal(oscillator.frequency.value, 425);
  assert.equal(oscillator.until, 8);
  assert.deepEqual(pulses, [
    [0.07, 5.015],
    [0, 6],
    [0.07, 7.015],
    [0, 8],
  ]);
  signal.abort();
  await ring;
});

test('Nod handles project names, new tasks and marking tasks complete', () => {
  assert.ok(requiresProject('Was steht in Mein Projekt?', 'Mein Projekt'));
  assert.ok(requiresProject('Lege eine neue Aufgabe für morgen an.', ''));
  assert.ok(requiresProject('Hake die Aufgabe Blumen kaufen ab.', ''));
  assert.ok(requiresProject('Markiere die Aufgabe als erledigt.', ''));
  assert.ok(!requiresProject('Was ist zwei plus zwei?', ''));
  assert.ok(!requiresProject('Was ist Notion?', ''));
  assert.ok(!requiresProject('Welche Aufgaben hat der Bundestag?', ''));
});

async function callRig(t, result = { state: 'reply', text: 'Ist erledigt.' }) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const track = { enabled: true },
    scope = new AbortController(),
    events = [],
    submissions = [],
    peers = [],
    states = [];
  let ended;
  class Peer {
    constructor() {
      peers.push(this);
    }
    createDataChannel() {
      return (this.dc = {
        readyState: 'open',
        send: (json) => events.push(JSON.parse(json)),
        close() {},
      });
    }
    addTrack() {}
    close() {
      this.closed = true;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0' };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    async setRemoteDescription() {
      this.ontrack({ track: {} });
      this.dc.onmessage({ data: JSON.stringify({ type: 'session.created' }) });
    }
  }
  const globals = {
    RTCPeerConnection: Peer,
    MediaStream: class {},
    Audio: class {
      async play() {}
      pause() {}
    },
    fetch: async () => Response.json({ sdp: 'v=0' }),
  };
  for (const [k, v] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: v,
    });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, k, previous)
        : delete globalThis[k],
    );
  }
  t.after(() => scope.abort());
  await realtimeCall({
    call: {
      controller: scope,
      stream: { getAudioTracks: () => [track] },
      context: {
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      },
    },
    ring: Promise.resolve(),
    project: 'Mein Projekt',
    present: (...s) => states.push(s),
    end: (...e) => {
      ended = e;
      scope.abort();
    },
    fail: (m) => {
      throw Error(m);
    },
    request: async (_c, path, opts) => {
      assert.equal(path, 'transcript');
      submissions.push(opts);
      return Response.json({ id: 'turn' });
    },
    readStatus: async () => result,
  });
  await tick();
  const emit = (e) => peers.at(-1).dc.onmessage({ data: JSON.stringify(e) });
  const speak = (item, text) => {
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'input_audio_buffer.committed', item_id: item });
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: item,
      transcript: text,
    });
  };
  const finish = (stage, turn, id, output) =>
    emit({
      type: 'response.done',
      response: { id, status: 'completed', metadata: { stage, turn }, output },
    });
  const audio = [
    {
      type: 'message',
      content: [{ type: 'output_audio', transcript: 'Vier.' }],
    },
  ];
  return {
    scope,
    track,
    events,
    submissions,
    peers,
    states,
    emit,
    speak,
    finish,
    audio,
    ended: () => ended,
  };
}

test('direct answers, approval handoff and duplicate function events use only the owner transcript', async (t) => {
  const r = await callRig(t, { state: 'approval' });
  r.speak('direct', 'Wie viel ist zwei plus zwei?');
  assert.equal(r.events.at(-1).response.tool_choice, undefined);
  assert.equal(r.submissions.length, 0);
  r.finish('answer', 'direct', 'r1', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  assert.equal(r.track.enabled, true);
  const text = 'Hake die Aufgabe Blumen kaufen ab.';
  r.speak('project', text);
  assert.equal(r.events.at(-1).item.name, 'ask_nod');
  const tool = [
    {
      type: 'function_call',
      name: 'ask_nod',
      call_id: 'test-id',
      arguments: '{"text":"unrelated action"}',
    },
  ];
  r.finish('answer', 'project', 'r2', tool);
  r.finish('answer', 'project', 'r2', tool);
  await tick();
  assert.equal(r.submissions.length, 1);
  assert.equal(r.submissions[0].body, text);
  assert.equal(r.ended()[0], 'approval');
  assert.equal(r.peers[0].closed, true);
});

test('one presence question after a minute and hangup thirty seconds after its playback', async (t) => {
  const r = await callRig(t);
  t.mock.timers.tick(60_000);
  assert.equal(r.events.at(-1).response.metadata.stage, 'presence');
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'p1' });
  r.finish('presence', 'presence', 'p1', r.audio);
  assert.equal(r.track.enabled, true);
  t.mock.timers.tick(29_999);
  assert.equal(r.ended(), undefined);
  t.mock.timers.tick(1);
  assert.equal(r.ended()[0], 'idle');
});

test('an implicit task uses only spoken words and reports the result once', async (t) => {
  const r = await callRig(t);
  const text = 'Setz das bitte auf meine Liste.';
  r.speak('list', text);
  const tool = [
    {
      type: 'function_call',
      name: 'ask_nod',
      call_id: 'chosen',
      arguments: '{"request":"do something else"}',
    },
  ];
  r.finish('answer', 'list', 'r1', tool);
  r.finish('answer', 'list', 'r1', tool);
  await tick();
  assert.deepEqual(
    r.submissions.map((s) => s.body),
    [text],
  );
  const result = r.events.find(
    (e) => e.item?.type === 'function_call_output',
  ).item;
  assert.equal(result.call_id, 'chosen');
  assert.equal(JSON.parse(result.output).result, 'Ist erledigt.');
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  r.finish('result', 'list', 'r2', r.audio);
  assert.equal(r.track.enabled, false);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'r2' });
  assert.equal(r.track.enabled, true);
});

test('a long call renews between utterances with bounded history and no repeated action', async (t) => {
  const r = await callRig(t);
  r.emit({ type: 'input_audio_buffer.speech_started' });
  t.mock.timers.tick(53 * 60_000);
  r.speak('one', 'Wie viel ist zwei plus zwei?');
  r.finish('answer', 'one', 'r1', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  await tick();
  assert.equal(r.peers.length, 2);
  assert.equal(r.peers[0].closed, true);
  assert.equal(r.track.enabled, true);
  assert.equal(r.submissions.length, 0);
  assert.deepEqual(
    r.events.filter((e) => e.item?.type === 'message').map((e) => e.item.role),
    ['user', 'assistant'],
  );
});
