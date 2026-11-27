import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { waitForCompletion, waitForNod } from '../bridge/turn-wait.mjs';

const working = { state: 'working' };

async function listen(t, handler) {
  const app = http.createServer(handler);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.closeAllConnections();
    return new Promise((resolve) => app.close(resolve));
  });
  return 'http://127.0.0.1:' + app.address().port;
}

test('Nod refresh wakes a pending turn, preserves authorization and never delivers an upstream draft', async (t) => {
  let lookups = 0,
    ready = false,
    notified = false,
    closed;
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  const url = await listen(t, (req, res) => {
    assert.equal(req.url, '/api/events');
    assert.equal(req.headers.host, 'nod.example');
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.on('close', closed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"delta","text":"unfinished"}\n\n');
    res.write('data: {"type":"refresh"}\n\n');
    const timer = setInterval(() => {
      if (lookups === 0 || notified) return;
      notified = ready = true;
      res.write('data: {"type":"ref');
      setImmediate(() => res.write('resh"}\r\n\r\n'));
    }, 5);
    res.on('close', () => clearInterval(timer));
  });
  const poll = async () => {
    lookups++;
    return ready ? { state: 'approval', text: 'Im Chat bestätigen.' } : working;
  };
  assert.deepEqual(
    await waitForNod(
      url,
      { Host: 'nod.example', Authorization: 'Bearer fixture' },
      new AbortController().signal,
      poll,
      working,
    ),
    { state: 'approval', text: 'Im Chat bestätigen.' },
  );
  await ended;
  assert.equal(lookups, 2);
});

test('an older Nod can still be polled and client hangup closes an open event stream', async (t) => {
  const missing = await listen(t, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  assert.equal(
    await waitForNod(
      missing,
      {},
      new AbortController().signal,
      assert.fail,
      working,
    ),
    working,
  );
  const stop = new AbortController();
  let closed;
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  const stream = await listen(t, (_req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': hello\n\n');
    setImmediate(() => stop.abort());
  });
  await assert.rejects(
    waitForNod(stream, {}, stop.signal, assert.fail, working),
    { name: 'AbortError' },
  );
  await ended;
  await waitForCompletion(Promise.resolve(), new AbortController().signal);
  await assert.rejects(waitForCompletion(new Promise(() => {}), stop.signal), {
    name: 'AbortError',
  });
});
