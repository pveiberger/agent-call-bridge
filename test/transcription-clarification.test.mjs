import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { compatibleAdapter } from '../bridge/compatible.mjs';
import { nodAdapter } from '../bridge/nod.mjs';
import { transcriber } from '../bridge/speech.mjs';

const ask =
  'Das habe ich akustisch nicht verstanden. Kannst du es noch einmal sagen?';
const phrase = 'Ich möchte den Termin für nächste Woche eintragen. ';
// Valid 16 kHz mono PCM16 so the short-context decoder retry is exercised.
const audio = Buffer.from(
  '524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000001000100',
  'hex',
);

for (const kind of ['nod', 'hermes', 'openclaw']) {
  test(
    kind +
      ' requests one clarification, then accepts new speech on the same call',
    async (t) => {
      const call = randomUUID(),
        retry = randomUUID(),
        threadId = randomUUID(),
        turnId = randomUUID();
      const state = { threadId, messages: [], turns: [] };
      let result = { text: ' ' },
        status = 200,
        stt = 0,
        actions = 0,
        reads = 0;
      const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const data of req) body += data;
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/audio/transcriptions') {
          stt++;
          res.writeHead(status);
          return res.end(JSON.stringify(result));
        }
        if (req.url === '/api/state') {
          reads++;
          return res.end(JSON.stringify(state));
        }
        if (req.url === '/api/messages') {
          actions++;
          const { clientMessageId: id, text } = JSON.parse(body);
          state.messages.push(
            { id, role: 'user', text, turnId },
            {
              role: 'assistant',
              text: 'Erledigt.',
              turnId,
              replyToMessageId: id,
            },
          );
          state.turns.push({ id: turnId, status: 'succeeded' });
          return res.end(JSON.stringify({ messageId: id, turnId }));
        }
        if (req.url === '/chat/completions') {
          actions++;
          return res.end(
            JSON.stringify({
              choices: [{ message: { content: 'Erledigt.' } }],
            }),
          );
        }
        res.writeHead(404).end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const base = 'http://127.0.0.1:' + server.address().port;
      const env = {
        STT_BASE_URL: base,
        STT_MODEL: 'fixture',
        STT_WHISPER_SHORT_CONTEXT: 'true',
        AGENT_BASE_URL: base,
        AGENT_API_KEY: 'fixture',
      };
      const adapter =
        kind === 'nod'
          ? nodAdapter({
              base,
              authority: 'localhost',
              transcribe: transcriber(env),
            })
          : compatibleAdapter(env, kind);
      if (kind === 'nod') t.mock.timers.enable({ apis: ['setTimeout'] });
      const submit = (id, bytes = audio, caller = call) =>
        adapter.submit(bytes, id, caller, {});
      async function poll(receipt) {
        let value;
        do {
          await setImmediate();
          value = await adapter.poll(receipt, {}, undefined, call);
        } while (value.state === 'working');
        return value;
      }
      const receipt = await submit(retry);
      const beforePoll = reads;
      assert.deepEqual(await poll(receipt), { state: 'reply', text: ask });
      assert.equal(
        reads,
        beforePoll,
        'a local reply reveals no upstream chat state',
      );
      assert.equal(stt, 1);
      result = { text: phrase.repeat(3) };
      assert.deepEqual(await poll(await submit(randomUUID())), {
        state: 'reply',
        text: ask,
      });
      assert.equal(
        stt,
        3,
        'two attempts for a looping transcript, one spoken reply',
      );
      assert.equal(actions, 0);
      result = { text: 'Jetzt bitte den Termin eintragen.' };
      assert.equal(await submit(retry), receipt);
      await assert.rejects(
        () => adapter.poll(receipt, {}, undefined, randomUUID()),
        (e) => e.status === 404,
      );
      await assert.rejects(
        () => submit(retry, audio, randomUUID()),
        (e) => e.status === 409,
      );
      await assert.rejects(
        () => submit(retry, Buffer.from('changed')),
        (e) => e.status === 409,
      );
      assert.equal(
        stt,
        3,
        're-delivery must not reach the recognizer or the agent',
      );
      assert.deepEqual(await poll(await submit(randomUUID())), {
        state: 'reply',
        text: 'Erledigt.',
      });
      assert.equal(actions, 1);
      for (const code of [401, 422, 502]) {
        status = code === 502 ? 200 : code;
        result = { error: 'provider problem' }; // A successful response with a malformed schema is also fatal.
        if (kind === 'nod')
          await assert.rejects(
            () => submit(randomUUID()),
            (e) => e.status === code,
          );
        else
          assert.equal((await poll(await submit(randomUUID()))).state, 'error');
      }
      assert.equal(actions, 1);
      if (kind === 'nod') {
        t.mock.timers.tick(60 * 60_000);
        await assert.rejects(
          () => adapter.poll(receipt, {}, undefined, call),
          (e) => e.status === 404,
        );
      }
      status = 200;
      for (const [spoken, expected] of [
        ['Ja, alles klar, danke dir, dann bis später.', 'end_call'],
        ['Kannst du bitte noch kurz dranbleiben?', 'hold_call'],
        ['Danke dir.', undefined],
        ['Lege die Aufgabe „Bis später“ an.', undefined],
      ]) {
        result = { text: spoken };
        const id = randomUUID();
        const baseline = actions;
        const local = await adapter.submit(audio, id, call, {}, undefined, true);
        const answer = await poll(local);
        assert.equal(answer.callAction, expected);
        assert.equal(actions - baseline, expected ? 0 : 1);
        if (expected) {
          assert.equal(await adapter.submit(audio, id, call, {}, undefined, true), local);
          await assert.rejects(() => adapter.poll(local, {}, undefined, randomUUID()));
        }
      }
    },
  );
}
