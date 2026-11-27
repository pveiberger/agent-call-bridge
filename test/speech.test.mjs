import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { nodAdapter } from '../bridge/nod.mjs';
import {
  speechOutput,
  streamPocketAudio,
  transcriber,
} from '../bridge/speech.mjs';

async function serve(t, handle) {
  const app = http.createServer(handle);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });
  return 'http://127.0.0.1:' + app.address().port;
}

test('custom transcription preserves Nod thread and approvals during inference', async (t) => {
  const state = {
    threadId: randomUUID(),
    messages: [],
    verificationRequests: [],
  };
  const id = randomUUID(),
    turnId = randomUUID();
  let messages = 0;
  const base = await serve(t, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify(state));
    assert.equal(req.url, '/api/messages');
    let input = '';
    for await (const chunk of req) input += chunk;
    assert.deepEqual(JSON.parse(input), {
      threadId: state.threadId,
      clientMessageId: id,
      text: 'Bitte vormerken.',
      chatClearedAt: null,
      attachmentIds: [],
    });
    messages++;
    res.end(JSON.stringify({ messageId: id, turnId }));
  });
  const build = (transcribe) =>
    nodAdapter({ base, authority: 'localhost', transcribe });
  const submit = (a) => a.submit(Buffer.alloc(44), id, randomUUID(), {});
  assert.equal(
    await submit(build(async () => 'Bitte vormerken.')),
    [state.threadId, turnId, id].join('.'),
  );
  await assert.rejects(
    submit(build(async () => '/clear')),
    (e) => e.status === 409,
  );
  await assert.rejects(
    submit(
      build(async () => {
        state.verificationRequests.push({ id: randomUUID() });
        return 'Ja.';
      }),
    ),
    (e) => e.status === 409,
  );
  assert.equal(messages, 1);
});

test('transcriber sends explicit German and vocabulary for the configured model', async (t) => {
  const fields = [];
  const base = await serve(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    fields.push(body);
    res.end(JSON.stringify({ text: ' Hallo ' }));
  });
  for (const model of ['whisper-large-v3-turbo', 'gpt-transcribe']) {
    const run = transcriber({
      STT_BASE_URL: base + '/v1',
      STT_MODEL: model,
      STT_PROMPT: 'Fachwort',
    });
    assert.equal(await run(Buffer.alloc(44)), 'Hallo');
  }
  assert.match(fields[0], /name="language"\r\n\r\nde/);
  assert.match(fields[1], /name="languages\[\]"\r\n\r\nde/);
  assert.ok(fields.every((b) => b.includes('name="prompt"\r\n\r\nFachwort')));
  assert.ok(fields.every((b) => !b.includes('name="audio_ctx"')));
});

function recording(samples) {
  const pcm = Buffer.alloc(samples * 2, 1);
  // Include an odd-sized ancillary chunk with its required padding.
  const header = Buffer.alloc(56);
  header.write('RIFF');
  header.writeUInt32LE(header.length + pcm.length - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('JUNK', 36);
  header.writeUInt32LE(3, 40);
  header.write('data', 48);
  header.writeUInt32LE(pcm.length, 52);
  return Buffer.concat([header, pcm]);
}

test('opt-in whisper.cpp profile uses measured short PCM duration and one full-context retry', async (t) => {
  const calls = [];
  const phrase = 'Könnten Sie bitte den Termin für nächste Woche prüfen? ';
  let replies = [];
  const base = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': req.headers['content-type'] },
    }).formData();
    calls.push({
      window: form.get('audio_ctx'),
      bytes: Buffer.from(await form.get('file').arrayBuffer()),
    });
    res.end(JSON.stringify({ text: replies.shift() ?? 'Ja, ja.' }));
  });
  const run = transcriber({
    STT_BASE_URL: base,
    STT_MODEL: 'whisper-large-v3-turbo',
    STT_WHISPER_SHORT_CONTEXT: 'true',
  });
  const short = recording(6 * 16000);
  const stereo = Buffer.from(short);
  stereo.writeUInt16LE(2, 22);
  const invalid = Buffer.from(short);
  invalid.writeUInt32LE(22, 52);
  const inputs = [
    short,
    recording(6 * 16000 + 1),
    stereo,
    invalid,
    Buffer.alloc(44),
  ];
  for (const wav of inputs) assert.equal(await run(wav), 'Ja, ja.');
  assert.deepEqual(
    calls.map((c) => c.window),
    ['768', '0', '0', '0', '0'],
  );
  assert.deepEqual(
    calls.map((c) => c.bytes),
    inputs,
  );
  calls.length = 0;
  replies = [phrase.repeat(3), 'Den Termin prüfen.'];
  assert.equal(await run(short), 'Den Termin prüfen.');
  assert.deepEqual(
    calls.map((c) => c.window),
    ['768', '0'],
  );
  assert.ok(calls.every((c) => c.bytes.equals(short)));
  calls.length = 0;
  replies = [phrase.repeat(2)];
  assert.equal(await run(short), phrase.repeat(2).trim());
  assert.equal(calls.length, 1);
  calls.length = 0;
  replies = [phrase.repeat(3), phrase.repeat(3)];
  await assert.rejects(run(short), (e) => e.status === 422);
  assert.deepEqual(
    calls.map((c) => c.window),
    ['768', '0'],
  );
});

test('local fast speech checks doubtful short turns once and preserves negation', async (t) => {
  let quickCalls = 0,
    reviewCalls = 0,
    failed = false;
  let first = { text: 'Ist das erledigt?', needs_review: false };
  let reviewed = 'Ist das erledigt?';
  const quickUrl = await serve(t, async (req, res) => {
    req.resume();
    assert.equal(req.headers.authorization, undefined);
    quickCalls++;
    res.writeHead(failed ? 503 : 200);
    res.end(JSON.stringify(first));
  });
  const reviewUrl = await serve(t, (req, res) => {
    req.resume();
    reviewCalls++;
    res.end(JSON.stringify({ text: reviewed }));
  });
  const run = transcriber({
    STT_BASE_URL: reviewUrl,
    STT_MODEL: 'whisper',
    STT_API_KEY: 'private-test-key',
    STT_FAST_BASE_URL: quickUrl,
  });
  const clip = recording(16000);
  assert.equal(await run(clip), first.text);
  assert.equal(reviewCalls, 0);
  first = { text: 'Ist das erledigt?', needs_review: true };
  assert.equal(await run(clip), reviewed);
  reviewed = 'Ist das nicht erledigt?';
  await assert.rejects(run(clip), (e) => e.status === 422);
  first = { text: '', needs_review: true };
  await assert.rejects(run(clip), (e) => e.status === 422);
  assert.equal(reviewCalls, 2);
  failed = true;
  assert.equal(await run(clip), reviewed);
  assert.equal(await run(recording(7 * 16000)), reviewed);
  assert.equal(quickCalls, 5);
  assert.equal(reviewCalls, 4);
});

test('Pocket output finalizes WAV, streams PCM, caches only fixed announcements', async (t) => {
  const wav = Buffer.alloc(56);
  wav.write('RIFF');
  wav.writeUInt32LE(2000000036, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2000000000, 40);
  wav.fill(23, 44);
  let requests = 0;
  const base = await serve(t, (_, res) => {
    requests++;
    res.write(wav.subarray(0, 17));
    setImmediate(() => res.end(wav.subarray(17)));
  });
  const speak = speechOutput({ TTS_ENGINE: 'pocket', TTS_BASE_URL: base });
  for (const text of [
    'Sind Sie noch da? Wenn ja, sprechen Sie jetzt.',
    'Sind Sie noch da? Wenn ja, sprechen Sie jetzt.',
    'Antwort',
    'Antwort',
  ]) {
    const result = await speak(text);
    assert.equal(result.readUInt32LE(40), 12);
    assert.equal(result.readUInt32LE(4), 48);
  }
  assert.equal(requests, 3);
  const chunks = [];
  for await (const chunk of streamPocketAudio(
    base,
    'Antwort',
    new AbortController().signal,
  ))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), wav.subarray(44));
});
