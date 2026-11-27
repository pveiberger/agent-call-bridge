import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { compatibleAdapter } from '../bridge/compatible.mjs';

test(
  'a long call evicts delivered answers without re-executing their actions',
  { timeout: 60_000 },
  async (t) => {
    const operations = [];
    let transcriptions = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/audio/transcriptions') {
        transcriptions++;
        return res.end(JSON.stringify({ text: 'Erfasse den Beitrag.' }));
      }
      if (req.url === '/v1/chat/completions') {
        const id = req.headers['idempotency-key'];
        operations.push(id);
        return res.end(
          JSON.stringify({ choices: [{ message: { content: id } }] }),
        );
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/v1';
    const adapter = compatibleAdapter(
      {
        AGENT_BASE_URL: base,
        AGENT_API_KEY: 'fixture',
        STT_BASE_URL: base,
        STT_MODEL: 'fixture',
      },
      'hermes',
    );
    const callId = randomUUID(),
      first = randomUUID(),
      otherCall = randomUUID();
    const audio = Buffer.from('spoken fixture');
    async function complete(id) {
      assert.equal(await adapter.submit(audio, id, callId), id);
      let result;
      do {
        t.signal.throwIfAborted();
        await setImmediate();
        result = await adapter.poll(id, {}, undefined, callId);
      } while (result.state === 'working');
      assert.deepEqual(result, { state: 'reply', text: id });
    }

    await complete(first);
    for (let i = 0; i < 501; i++) await complete(randomUUID());
    const gone = (err) => err.status === 410;
    const conflict = (err) => err.status === 409;
    await assert.rejects(
      () => adapter.poll(first, {}, undefined, callId),
      gone,
    );
    assert.equal(await adapter.submit(audio, first, callId), first);
    await assert.rejects(
      () => adapter.poll(first, {}, undefined, callId),
      gone,
    );
    await assert.rejects(
      () => adapter.submit(audio, first, otherCall),
      conflict,
    );
    await assert.rejects(
      () => adapter.submit(Buffer.from('changed recording'), first, callId),
      conflict,
    );
    await assert.rejects(
      () => adapter.poll(first, {}, undefined, otherCall),
      (err) => err.status === 404,
    );

    await complete(randomUUID());
    assert.equal(transcriptions, 503);
    assert.equal(operations.length, 503);
    assert.equal(new Set(operations).size, 503);
  },
);
