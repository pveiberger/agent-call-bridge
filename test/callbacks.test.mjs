import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCallbacks, pendingCallback } from '../bridge/callbacks.mjs';

const minute = 60_000;
const message = {
  id: 'question',
  role: 'assistant',
  createdAt: new Date(0).toISOString(),
  text: 'Dringende Rückfrage: Soll ich den Termin verschieben?',
};
const state = { threadId: 'thread', messages: [message] };
test('only a recent, urgent, unanswered owner question can ring', () => {
  assert.equal(pendingCallback(state, 5 * minute - 1), undefined);
  assert.equal(pendingCallback(state, 60 * minute), undefined);
  assert.deepEqual(pendingCallback(state, 5 * minute), {
    id: 'thread.question',
    question: 'Soll ich den Termin verschieben?',
  });
  for (const text of [
    'Wann passt es dir?',
    'Dringend: Die Bahn fährt.',
    'Die Nachricht lautet: Dringend: Anrufen?',
  ]) {
    assert.equal(
      pendingCallback(
        { ...state, messages: [{ ...message, text }] },
        5 * minute,
      ),
      undefined,
    );
  }
  for (const change of [
    { messages: [message, { role: 'user', text: 'Schon erledigt.' }] },
    { tasks: [{ questionMessageId: 'question', status: 'done' }] },
    { messages: [message, { approval: { state: 'pending' } }] },
    { verificationRequests: [{}] },
    {
      messages: [{ ...message, answerChoices: ['Ja', 'Nein'] }],
      pendingAnswerChoiceMessageIds: [],
    },
  ])
    assert.equal(
      pendingCallback({ ...state, ...change }, 5 * minute),
      undefined,
    );
});
test('an explicitly requested event can ring promptly, with a reason and within its window', () => {
  const event = {
    ...message,
    text: 'Angeforderter Anruf: Dein Beispieltermin wurde abgesagt.',
  };
  const eventState = { ...state, messages: [event] };
  assert.equal(
    pendingCallback(eventState, 0).question,
    'Dein Beispieltermin wurde abgesagt.',
  );
  assert.equal(pendingCallback(eventState, -1), undefined);
  assert.equal(pendingCallback(eventState, 60 * minute), undefined);
  assert.equal(
    pendingCallback(
      { ...state, messages: [{ ...message, text: 'Angeforderter Anruf:' }] },
      10,
    ),
    undefined,
  );
});
test('one preferred receiver claims the question once across concurrent polls and restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nod-callback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbfile = join(dir, 'attempts.sqlite');
  let now = 5 * minute;
  const create = () =>
    createCallbacks('whatsapp-linked,telegram,browser', dbfile, () => now);
  const load = async () => state;
  let db = create();
  assert.deepEqual(await db.next('browser', load), {});
  now += minute;
  assert.deepEqual(await db.next('whatsapp-linked', async () => ({})), {});
  assert.deepEqual(await db.next('telegram', load), {});
  assert.deepEqual(await db.next('browser', load), {});
  now += minute;
  const offers = await Promise.all([
    db.next('browser', load),
    db.next('browser', load),
  ]);
  assert.equal(offers.filter((x) => x.question).length, 1);
  db.close();
  db = create();
  assert.deepEqual(await db.next('whatsapp-linked', load), {});
  db.close();
});

test('only an authenticated same-origin browser or private adapter can consult the callback bridge', async (t) => {
  const origin = 'https://nod.example';
  const secret = randomBytes(32).toString('hex');
  let stateReads = 0;
  const previous = Date.now() - 5 * minute;
  const upstream = createServer((req, res) => {
    if (
      req.headers.cookie !== 'nod-access-4310=fixture' &&
      req.headers.authorization !== 'Bearer fixture'
    ) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/session')
      return res.end(JSON.stringify({ user: { id: 'owner' } }));
    if (req.url === '/api/state') {
      stateReads++;
      return res.end(
        JSON.stringify({
          ...state,
          messages: [
            { ...message, createdAt: new Date(previous).toISOString() },
          ],
        }),
      );
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  Object.assign(process.env, {
    AGENT_BACKEND: 'nod',
    WEB_AUTH: 'nod',
    NOD_PORT: '4310',
    CALL_REALTIME: 'true',
    PUBLIC_ORIGIN: origin,
    NOD_PUBLIC_URL: origin,
    NOD_BASE_URL: 'http://127.0.0.1:' + upstream.address().port,
    NOD_AUTH_TOKEN: 'fixture',
    BRIDGE_CHANNEL_SECRET: secret,
    CALLBACK_CHANNELS: 'browser,telegram',
    CALLBACK_DB: ':memory:',
    STT_BASE_URL: '',
    TTS_ENGINE: 'piper',
  });
  const { app } = await import('../bridge/server.mjs');
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const post = (path, headers) =>
    fetch('http://127.0.0.1:' + app.address().port + path, {
      method: 'POST',
      headers,
    });
  const path = '/anruf/api/callback/browser';
  const headers = { Origin: origin, Cookie: 'nod-access-4310=fixture' };
  assert.equal((await post(path, { Origin: origin })).status, 401);
  assert.equal(
    (await post(path, { ...headers, Origin: 'https://other.example' })).status,
    403,
  );
  assert.equal((await post('/channel/callback/telegram', {})).status, 401);
  assert.equal(stateReads, 0);
  assert.equal(
    (await (await post(path, headers)).json()).id,
    'thread.question',
  );
  assert.deepEqual(await (await post(path, headers)).json(), {});
  assert.deepEqual(
    await (
      await post('/channel/callback/telegram', {
        Authorization: 'Bearer ' + secret,
      })
    ).json(),
    {},
  );
});
