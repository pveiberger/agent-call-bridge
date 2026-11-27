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
  assert.ok(requiresProject('Markier das bitte als erledigt.', ''));
  assert.ok(!requiresProject('Damit hätten wir für heute alles erledigt.', ''));
  assert.ok(!requiresProject('Was ist zwei plus zwei?', ''));
  assert.ok(!requiresProject('Was ist Notion?', ''));
  assert.ok(!requiresProject('Welche Aufgaben hat der Bundestag?', ''));
});

async function callRig(t, result = { state: 'reply', text: 'Ist erledigt.' }, callbackQuestion = '') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
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
      this.dc.onmessage({
        data: JSON.stringify({
          type: 'session.created',
          session: {
            tools: [
              {
                type: 'function',
                name: 'ask_nod',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
        }),
      });
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
  const call = {
    callbackQuestion,
    controller: scope,
    stream: { getAudioTracks: () => [track] },
    context: {
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    },
  };
  await realtimeCall({
    call,
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
  const greeting = events.at(-1)?.response;
  assert.equal(greeting?.metadata.stage, 'greeting');
  assert.equal(greeting.tool_choice, 'none');
  if (callbackQuestion) assert.ok(greeting.instructions.includes(callbackQuestion));
  assert.equal(track.enabled, false);
  finish('greeting', greeting.metadata.turn, 'hello', audio);
  assert.equal(track.enabled, false);
  emit({ type: 'output_audio_buffer.stopped', response_id: 'hello' });
  assert.equal(track.enabled, true);
  events.length = 0;
  return {
    mute(value) {
      call.userMuted = value;
      call.onMuteChange();
    },
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

test('an accepted callback routes a short answer into the existing Nod chat', async (t) => {
  const r = await callRig(t, undefined, 'Soll ich den Termin verschieben?');
  r.speak('owner-answer', 'Ja, bitte.');
  await tick();
  assert.equal(r.submissions.length, 1);
  assert.equal(r.submissions[0].body, 'Ja, bitte.');
});

test('manual mute discards a partial turn and survives response playback', async (t) => {
  const r = await callRig(t);
  r.emit({ type: 'input_audio_buffer.speech_started', item_id: 'partial' });
  r.mute(true);
  assert.equal(r.track.enabled, false);
  r.mute(false);
  r.emit({ type: 'input_audio_buffer.committed', item_id: 'partial' });
  r.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'partial',
    transcript: 'Eine neue Aufgabe anlegen.',
  });
  assert.equal(r.submissions.length, 0);
  assert.equal(r.track.enabled, true);
  r.speak('direct', 'Wie viel ist zwei plus zwei?');
  r.emit({ type: 'output_audio_buffer.started', response_id: 'audio' });
  r.mute(true);
  r.mute(false);
  assert.equal(r.track.enabled, false);
  r.mute(true);
  r.finish('answer', 'direct', 'audio', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'audio' });
  assert.equal(r.track.enabled, false);
  r.speak('muted', 'Eine neue Aufgabe anlegen.');
  assert.equal(r.submissions.length, 0);
  r.mute(false);
  assert.equal(r.track.enabled, true);
});

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

test('thirty seconds of silence closes the peer without generating a response', async (t) => {
  const r = await callRig(t);
  t.mock.timers.tick(29_999);
  assert.equal(r.ended(), undefined);
  t.mock.timers.tick(1);
  assert.equal(r.ended()[0], 'idle');
  assert.equal(r.peers[0].closed, true);
  assert.deepEqual(r.events, []);
});

test('a farewell hangs up only once the matching spoken goodbye finishes', async (t) => {
  const r = await callRig(t);
  r.speak('bye', 'Ja, alles klar, danke dir, dann bis später.');
  assert.equal(r.events.at(-1).response.metadata.stage, 'end_call');
  r.emit({ type: 'output_audio_buffer.started', response_id: 'bye-audio' });
  r.finish('end_call', 'bye', 'bye-audio', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'earlier-audio' });
  t.mock.timers.tick(35_000);
  assert.equal(r.ended(), undefined);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'bye-audio' });
  assert.equal(r.ended(), undefined);
  t.mock.timers.tick(200);
  assert.equal(r.ended()[0], 'idle');
  assert.equal(r.scope.signal.aborted, true);
  assert.equal(r.submissions.length, 0);
});

test('holding buys five minutes, then thirty seconds from the end of the check-in', async (t) => {
  const r = await callRig(t);
  r.speak('wait', 'Leg bitte noch nicht auf.');
  assert.equal(r.events.at(-1).response.metadata.stage, 'hold_call');
  r.finish('hold_call', 'wait', 'ack', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'ack' });
  const count = r.events.length;
  t.mock.timers.tick(210_000);
  r.speak('noise', '');
  t.mock.timers.tick(89_999);
  assert.equal(r.events.length, count);
  t.mock.timers.tick(1);
  assert.equal(r.events.at(-1).response.metadata.stage, 'presence');
  const presenceId = r.events.at(-1).response.metadata.turn;
  r.emit({ type: 'output_audio_buffer.started', response_id: 'p1' });
  t.mock.timers.tick(40_000);
  assert.equal(r.ended(), undefined);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'p1' });
  r.finish('presence', presenceId, 'p1', r.audio);
  assert.equal(r.track.enabled, true);
  t.mock.timers.tick(29_999);
  assert.equal(r.ended(), undefined);
  t.mock.timers.tick(1);
  assert.equal(r.ended()[0], 'idle');
});

test('model call controls handle paraphrases and renew a hold, and returning to conversation restores the ordinary timer', async (t) => {
  const r = await callRig(t);
  r.speak('pause', 'Kannst du mir kurz die Leitung offenhalten?');
  assert.deepEqual(
    r.events.at(-1).response.tools.map((tool) => tool.name),
    ['ask_nod', 'end_call', 'hold_call'],
  );
  const tool = [
    {
      type: 'function_call',
      name: 'hold_call',
      call_id: 'pause-tool',
      arguments: '{}',
    },
  ];
  r.finish('answer', 'pause', 'r1', tool);
  const count = r.events.length;
  r.finish('answer', 'pause', 'r1', tool);
  assert.equal(r.events.length, count);
  assert.equal(r.events.at(-2).item.call_id, 'pause-tool');
  r.finish('hold_call', 'pause', 'ack', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'ack' });
  t.mock.timers.tick(299_000);
  r.speak('extend', 'Bleib bitte dran.');
  r.finish('hold_call', 'extend', 'ack2', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'ack2' });
  t.mock.timers.tick(299_000);
  assert.equal(r.ended(), undefined);
  assert.ok(!r.events.some((e) => e.response?.metadata.stage === 'presence'));
  r.speak('back', 'Danke dir.');
  assert.equal(r.events.at(-1).response.metadata.stage, 'answer');
  assert.equal(r.events.at(-1).response.tools, undefined);
  r.finish('answer', 'back', 'normal', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'normal' });
  t.mock.timers.tick(30_000);
  assert.equal(r.ended()[0], 'idle');
});

test('a semantic farewell uses the caller turn and a farewell quoted in a task goes to Nod', async (t) => {
  const r = await callRig(t);
  r.speak('note', 'Lege in Notion die Aufgabe „Bis später“ an.');
  await tick();
  assert.equal(r.submissions.length, 1);
  r.finish('result', 'note', 'saved', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'saved' });
  assert.equal(r.ended(), undefined);
  r.speak(
    'done',
    'Damit hätten wir für heute alles erledigt. Wir hören uns morgen!',
  );
  r.finish('answer', 'done', 'choice', [
    {
      type: 'function_call',
      name: 'end_call',
      call_id: 'end',
      arguments: '{}',
    },
  ]);
  assert.equal(r.events.at(-1).response.metadata.stage, 'end_call');
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'bye' });
  r.finish('end_call', 'done', 'bye', r.audio);
  t.mock.timers.tick(200);
  assert.equal(r.peers[0].closed, true);
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
  r.mute(true);
  r.finish('answer', 'one', 'r1', r.audio);
  r.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
  await tick();
  assert.equal(r.peers.length, 2);
  assert.equal(r.peers[0].closed, true);
  assert.equal(r.track.enabled, false);
  r.mute(false);
  assert.equal(r.track.enabled, true);
  assert.equal(r.submissions.length, 0);
  assert.deepEqual(
    r.events.filter((e) => e.item?.type === 'message').map((e) => e.item.role),
    ['user', 'assistant'],
  );
});
