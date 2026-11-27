import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { compatibleAdapter } from '../bridge/compatible.mjs';
import { nodAdapter } from '../bridge/nod.mjs';
import { webOrigins } from '../bridge/http.mjs';

async function fixture(t, handle) {
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    try {
      const value = await handle(req, Buffer.concat(parts), res);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    } catch (e) {
      res.writeHead(400);
      res.end();
      throw e;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}
async function waitReply(adapter, id, callId) {
  for (let n = 0; n < 80; n++) {
    const result = await adapter.poll(id, {}, undefined, callId);
    if (result.state !== 'working') return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for local fixture');
}
test('spoken task creation and completion use normal Nod message intake and honor pending approvals', async (t) => {
  const threadId = randomUUID();
  const posted = [];
  let pending = false;
  const base = await fixture(t, (req, body) => {
    if (req.url === '/api/state') return {
      threadId, chatClearedAt: null,
      messages: pending ? [{ approval: { state: 'pending' } }] : [],
    };
    assert.equal(req.url, '/api/messages');
    assert.equal(req.headers['x-nod-input-mode'], 'voice-call');
    const message = JSON.parse(body);
    assert.equal(message.threadId, threadId);
    posted.push(message.text);
    return { messageId: message.clientMessageId, turnId: randomUUID() };
  });
  const adapter = nodAdapter({ base, authority: new URL(base).host });
  const create = 'Erstelle die Aufgabe Testdruck prüfen.';
  const complete = 'Hake die Aufgabe Testdruck prüfen ab.';
  for (const text of [create, complete]) {
    const id = randomUUID();
    const receipt = await adapter.submitTranscript(text, id, {}, undefined);
    assert.equal(receipt.split('.')[2], id);
  }
  pending = true;
  await assert.rejects(adapter.submitTranscript(complete, randomUUID(), {}, undefined), { status: 409 });
  await assert.rejects(adapter.submitTranscript('/clear', randomUUID(), {}, undefined), { status: 400 });
  assert.deepEqual(posted, [create, complete]);
});
for (const kind of ['hermes', 'openclaw']) {
  test(kind + ' speech input, context, retry and call isolation', async (t) => {
    const requests = [];
    const url = await fixture(t, (req, data) => {
      if (req.url === '/v1/audio/transcriptions') {
        assert.match(data.toString(), /name="language"\r\n\r\nde/);
        return { text: 'Welche Zahl folgt auf drei?' };
      }
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer fixture');
      requests.push({ payload: JSON.parse(data), headers: req.headers });
      return {
        choices: [{ finish_reason: 'stop', message: { content: 'Vier.' } }],
      };
    });
    const a = compatibleAdapter(
      {
        AGENT_BASE_URL: url + '/v1',
        AGENT_API_KEY: 'fixture',
        STT_BASE_URL: url + '/v1',
        STT_MODEL: 'whisper',
      },
      kind,
    );
    const audio = Buffer.from('test audio payload'),
      id = randomUUID(),
      callId = randomUUID();
    assert.equal(await a.submit(audio, id, callId), id);
    assert.equal(await a.submit(audio, id, callId), id);
    assert.deepEqual(await waitReply(a, id, callId), {
      state: 'reply',
      text: 'Vier.',
    });
    await assert.rejects(
      () => a.poll(id, {}, undefined, randomUUID()),
      (e) => e.status === 404,
    );
    await assert.rejects(
      () => a.submit(Buffer.from('different'), id, callId),
      (e) => e.status === 409,
    );
    const next = await a.submit(audio, randomUUID(), callId);
    await waitReply(a, next, callId);
    assert.equal(requests.length, 2);
    if (kind === 'hermes')
      assert.equal(requests[1].payload.messages.at(-2).content, 'Vier.');
    else
      assert.equal(
        requests[0].headers['x-openclaw-session-key'],
        requests[1].headers['x-openclaw-session-key'],
      );
  });
}
test('Nod retains the regular owner turn and never answers a pending approval', async (t) => {
  const threadId = randomUUID(),
    turnId = randomUUID(),
    messageId = randomUUID();
  const state = { threadId, messages: [], turns: [], verificationRequests: [] };
  const base = await fixture(t, (req, data) => {
    assert.equal(req.headers.host, 'agent.example');
    assert.equal(req.headers.cookie, 'nod-access-4310=fixture');
    if (req.url === '/api/state') return state;
    assert.equal(req.url, '/api/messages/audio');
    assert.match(data.toString(), new RegExp(messageId));
    return { turnId, messageId, threadId };
  });
  const a = nodAdapter({ base, authority: 'agent.example' }),
    auth = { Cookie: 'nod-access-4310=fixture' };
  const id = await a.submit(
    Buffer.from('audio'),
    messageId,
    randomUUID(),
    auth,
  );
  state.messages = [
    { role: 'user', id: messageId, turnId },
    { role: 'assistant', turnId, text: 'Vier.', replyToMessageId: messageId },
    { role: 'assistant', turnId: randomUUID(), text: 'Other conversation' },
  ];
  state.turns = [{ id: turnId, status: 'succeeded' }];
  assert.deepEqual(await a.poll(id, auth), { state: 'reply', text: 'Vier.' });
  state.turns = [];
  assert.equal((await a.poll(id, auth)).state, 'error');
  state.turns = [
    { id: turnId, status: 'running', createdAt: new Date().toISOString() },
  ];
  assert.equal((await a.poll(id, auth)).state, 'working');
  state.turns[0] = { id: turnId, status: 'queued' };
  state.messages[0].createdAt = new Date().toISOString();
  assert.equal((await a.poll(id, auth)).state, 'working');
  state.messages[0].createdAt = new Date(
    Date.now() - 11 * 60_000,
  ).toISOString();
  assert.match((await a.poll(id, auth)).text, /im Chat/);
  assert.equal((await a.poll(id, auth)).state, 'error');
  state.messages[1].approval = { state: 'pending' };
  assert.equal((await a.poll(id, auth)).state, 'approval');
  await assert.rejects(
    () => a.submit(Buffer.from('audio'), randomUUID(), randomUUID(), auth),
    (e) => e.status === 409,
  );
});

test('Nod checks its owner session even with a nonempty cookie', async (t) => {
  let session = { user: null };
  const base = await fixture(t, (req) => {
    assert.equal(req.url, '/api/session');
    assert.equal(req.headers.cookie, 'nod-access-4310=fixture');
    return session;
  });
  const a = nodAdapter({ base, authority: 'agent.example' });
  const auth = { Cookie: 'nod-access-4310=fixture' };
  for (const invalid of [
    { user: null },
    { ok: true },
    { user: { id: '  ' } },
  ]) {
    session = invalid;
    await assert.rejects(
      () => a.check(auth),
      (e) => e.status === 401,
    );
  }
  session = { user: { id: 'owner' } };
  await a.check(auth);
});

test('all Nod cookie routes require a private upstream and an authenticated owner', async (t) => {
  const threadId = randomUUID(),
    turnId = randomUUID(),
    messageId = randomUUID();
  const pollPath = 'turn/' + [threadId, turnId, messageId].join('.');
  const origin = 'https://agent.example';
  const ownerCookie = 'nod-access-4310=fixture';
  const state = {
    threadId,
    messages: [
      { id: messageId, role: 'user', turnId },
      { role: 'assistant', turnId, text: 'Vier.' },
    ],
    turns: [{ id: turnId, status: 'succeeded' }],
  };
  let anonymousStatus = 200;
  const signedRequests = [];
  let anonymousRequests = 0;
  const base = await fixture(t, (req, _body, res) => {
    assert.equal(req.headers.host, 'agent.example');
    assert.equal(req.headers.authorization, undefined);
    if (!req.headers.cookie) {
      assert.equal(req.url, '/api/session');
      anonymousRequests++;
      res.statusCode = anonymousStatus;
      return { user: { id: 'owner' } };
    }
    signedRequests.push(req.url);
    if (req.headers.cookie !== ownerCookie) {
      res.statusCode = 401;
      return {};
    }
    if (req.url === '/api/session') return { user: { id: 'owner' } };
    assert.equal(req.url, '/api/state');
    return state;
  });
  assert.throws(() =>
    nodAdapter({
      base: base.replace('//', '//fixture@'),
      authority: 'agent.example',
    }),
  );

  const env = {
    AGENT_BACKEND: 'nod',
    WEB_AUTH: 'nod',
    PUBLIC_ORIGIN: origin,
    NOD_PUBLIC_URL: origin,
    NOD_BASE_URL: base,
    NOD_PORT: '4310',
    BRIDGE_CHANNEL_SECRET: '',
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { app } = await import('../bridge/server.mjs');
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const api = 'http://127.0.0.1:' + app.address().port + '/anruf/api/';
  const headers = {
    Origin: origin,
    Cookie: ownerCookie,
    'X-Call-Id': randomUUID(),
    'X-Request-Id': randomUUID(),
    'Content-Type': 'audio/wav',
  };
  const routes = [
    ['session', 'GET'],
    [pollPath, 'GET'],
    ['speech', 'POST'],
    ['utterance', 'POST'],
  ];
  for (const [path, method] of routes) {
    const response = await fetch(api + path, { method, headers });
    assert.equal(response.status, 503, path);
    assert.match((await response.json()).error, /Zugriffssperre/);
  }
  assert.equal(anonymousRequests, 4);
  assert.deepEqual(signedRequests, []);
  for (const status of [302, 404, 500]) {
    anonymousStatus = status;
    assert.equal((await fetch(api + pollPath, { headers })).status, 503);
  }
  assert.deepEqual(signedRequests, []);
  for (const status of [401, 403]) {
    anonymousStatus = status;
    const response = await fetch(api + pollPath, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: 'reply', text: 'Vier.' });
  }
  assert.deepEqual(signedRequests, [
    '/api/session',
    '/api/state',
    '/api/session',
    '/api/state',
  ]);
  const original = '[Arzttermin](https://example.org/privater-kalender) am 23. Juni.';
  state.messages[1].text = original;
  const formatted = await fetch(api + pollPath, { headers });
  assert.deepEqual(await formatted.json(), {
    state: 'reply', text: original, speechText: 'Arzttermin am 23. Juni.',
  });
  assert.equal(
    (
      await fetch(api + pollPath, {
        headers: { ...headers, Cookie: 'nod-access-4310=invalid' },
      })
    ).status,
    401,
  );
  assert.equal(signedRequests.at(-1), '/api/session');
  anonymousStatus = 200;
  assert.equal((await fetch(api + pollPath, { headers })).status, 503);
});

test('compatible adapter limits in-flight jobs across calls and releases failed and successful slots', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let healthy = false;
  const url = await fixture(t, async (req) => {
    if (req.url === '/audio/transcriptions') {
      await gate;
      return healthy ? { text: 'Hallo.' } : { error: 'provider unavailable' };
    }
    return {
      choices: [{ finish_reason: 'stop', message: { content: 'Hallo.' } }],
    };
  });
  const a = compatibleAdapter(
    {
      AGENT_BASE_URL: url,
      AGENT_API_KEY: 'fixture',
      STT_BASE_URL: url,
      STT_MODEL: 'test',
    },
    'hermes',
  );
  const audio = Buffer.from('audio');
  const ids = Array.from({ length: 5 }, () => ({
    id: randomUUID(),
    call: randomUUID(),
  }));
  const submit = ({ id, call }) => a.submit(audio, id, call);
  try {
    await Promise.all(ids.slice(0, 4).map(submit));
    assert.equal(await submit(ids[0]), ids[0].id);
    await assert.rejects(
      () => a.submit(audio, randomUUID(), ids[0].call),
      (e) => e.status === 409,
    );
    await assert.rejects(
      () => submit(ids[4]),
      (e) => e.status === 429,
    );
  } finally {
    release();
  }
  for (const { id, call } of ids.slice(0, 4))
    assert.equal((await waitReply(a, id, call)).state, 'error');
  healthy = true;
  await Promise.all(
    ids
      .slice(0, 4)
      .map(({ call }) =>
        a
          .submit(audio, randomUUID(), call)
          .then((id) => waitReply(a, id, call)),
      ),
  );
  assert.equal(await submit(ids[4]), ids[4].id);
  assert.equal((await waitReply(a, ids[4].id, ids[4].call)).state, 'reply');
});

test('browser origin requires secure remote transport and an exact Nod cookie origin', () => {
  for (const origin of [
    'http://127.0.0.1:8091',
    'http://127.0.0.2:8091',
    'http://[::1]:8091',
    'http://localhost:8091',
    'https://agent.example',
  ]) {
    assert.equal(webOrigins(origin, undefined, true).origin, origin);
  }
  assert.deepEqual(
    webOrigins('https://agent.example:443', 'https://agent.example/', true),
    { origin: 'https://agent.example', authority: 'agent.example' },
  );
  assert.equal(
    webOrigins('https://voice.example', 'https://agent.example:8443', false)
      .authority,
    'agent.example:8443',
  );
  for (const origin of [
    'http://agent.example',
    'http://192.0.2.1',
    'https://user:pass@agent.example',
    'https://agent.example/path',
    'https://agent.example/?x',
    'https://agent.example/#token',
    'ftp://agent.example',
  ]) {
    assert.throws(() => webOrigins(origin, undefined, false));
  }
  for (const nodOrigin of [
    'http://agent.example',
    'https://another.example',
    'https://agent.example:8443',
  ]) {
    assert.throws(() => webOrigins('https://agent.example', nodOrigin, true));
  }
});


test('tentative transcripts never submit work and are reusable only for the exact bytes and caller', async (t) => {
  const threadId = randomUUID(), turnId = randomUUID(), call = randomUUID();
  const audio = Buffer.from('first clause'), extended = Buffer.from('first clause with a correction');
  let transcriptions = 0, verificationRequests = [];
  const submitted = [];
  const base = await fixture(t, (req, body) => {
    if (req.url === '/api/state') return { threadId, messages: [], verificationRequests };
    assert.equal(req.url, '/api/messages');
    assert.equal(req.headers['x-nod-input-mode'], 'voice-call');
    const message = JSON.parse(body);
    submitted.push(message.text);
    return { messageId: message.clientMessageId, turnId };
  });
  const a = nodAdapter({ base, authority: 'localhost', transcribe: async (bytes) => {
    transcriptions++;
    return bytes.toString();
  } });
  const owner = { Cookie: 'first' };
  for (const [final, auth, expectedCalls] of [[audio, owner, 1], [extended, owner, 2], [audio, { Cookie: 'second' }, 2]]) {
    const id = randomUUID(), channel = randomUUID(), count = submitted.length, callsBefore = transcriptions;
    await a.prepare(audio, id, channel, owner);
    assert.equal(submitted.length, count);
    await a.submit(final, id, channel, auth);
    assert.equal(submitted.at(-1), final.toString());
    assert.equal(transcriptions - callsBefore, expectedCalls);
  }
  const id = randomUUID();
  await a.prepare(audio, id, call, owner);
  verificationRequests = [{}];
  await assert.rejects(a.submit(audio, id, call, owner), { status: 409 });
  assert.equal(submitted.length, 3);
});
