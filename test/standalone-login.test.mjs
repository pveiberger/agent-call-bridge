import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';

test('standalone form retains a same-origin POST and rejects foreign or opaque origins', async (t) => {
  const origin = 'https://assistant.example';
  const token = randomBytes(32).toString('hex');
  Object.assign(process.env, {
    AGENT_BACKEND: 'nod',
    WEB_AUTH: 'token',
    BRIDGE_WEB_TOKEN: token,
    BRIDGE_CHANNEL_SECRET: '',
    NOD_AUTH_TOKEN: 'fixture',
    PUBLIC_ORIGIN: origin,
    NOD_PUBLIC_URL: origin,
    NOD_BASE_URL: 'http://127.0.0.1',
    STT_BASE_URL: '',
    TTS_ENGINE: 'piper',
  });
  const { app } = await import('../bridge/server.mjs');
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const login = 'http://127.0.0.1:' + app.address().port + '/anruf/login';
  const form = await fetch(login);
  assert.equal(form.status, 200);
  assert.equal(form.headers.get('referrer-policy'), 'same-origin');
  assert.match(await form.text(), /<form method="post">/);
  async function submit(from) {
    return fetch(login, {
      method: 'POST',
      headers: { Origin: from },
      body: new URLSearchParams({ token }),
      redirect: 'manual',
    });
  }
  for (const from of ['null', 'https://elsewhere.example']) {
    const rejected = await submit(from);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  const accepted = await submit(origin);
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('location'), '/anruf/');
  assert.match(
    accepted.headers.get('set-cookie'),
    /; Path=\/anruf; HttpOnly; SameSite=Strict; Secure/,
  );
});
