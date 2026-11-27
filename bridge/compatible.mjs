import { createHash } from 'node:crypto';
import { waitForCompletion } from './turn-wait.mjs';
import { Failure, json, jsonPost } from './http.mjs';
import { transcriber, UnclearTranscription } from './speech.mjs';
import { nativeCallReply } from '../web/call-intent.js';

// Hermes accepts explicit OpenAI-format history. OpenClaw routes by session key.
export function compatibleAdapter(env, kind) {
  const turns = new Map(),
    calls = new Map();
  // Keep compact receipts after evicting a delivered answer. A retry must
  // never execute an assistant action a second time during the replay window.
  const delivered = new Map();
  let running = 0;
  const transcribe = transcriber(env);
  for (const name of [
    'AGENT_BASE_URL',
    'AGENT_API_KEY',
    'STT_BASE_URL',
    'STT_MODEL',
  ]) {
    if (!env[name]) throw new Error('Missing ' + name);
  }
  const model =
    env.AGENT_MODEL || (kind === 'hermes' ? 'hermes-agent' : 'openclaw');
  const prune = setInterval(() => {
    const cutoff = Date.now() - 60 * 60_000;
    for (const map of [turns, calls, delivered])
      for (const [key, value] of map) if (value.time < cutoff) map.delete(key);
  }, 60_000);
  prune.unref();
  async function run(audio, id, callId, call, turn, native) {
    try {
      const user = { role: 'user', content: await transcribe(audio) };
      const control = native && nativeCallReply(user.content);
      if (control) {
        turn.result = control;
        return;
      }
      const headers = {
        Authorization: 'Bearer ' + env.AGENT_API_KEY,
        'Idempotency-Key': id,
      };
      if (kind === 'openclaw')
        headers['x-openclaw-session-key'] = 'voice-' + callId;
      const prompt = [
        {
          role: 'system',
          content:
            'Dies ist ein deutschsprachiges Telefongespräch. Antworte kurz und mündlich auf Deutsch.',
        },
        ...call.history,
        user,
      ];
      const result = await json(env.AGENT_BASE_URL, '/chat/completions', {
        ...jsonPost({ model, messages: prompt, stream: false }, headers),
        timeout: 300_000,
      });
      const choice = result.choices?.[0],
        text = choice?.message?.content;
      if (
        ['error', 'cancelled', 'content_filter'].includes(
          choice?.finish_reason,
        ) ||
        typeof text !== 'string' ||
        !text.trim()
      )
        throw new Error('no usable answer');
      if (kind === 'hermes')
        call.history = [
          ...call.history,
          user,
          { role: 'assistant', content: text },
        ].slice(-16);
      turn.result = { state: 'reply', text };
    } catch (error) {
      turn.result =
        error instanceof UnclearTranscription
          ? {
              state: 'reply',
              text: error.message,
            }
          : {
              state: 'error',
              text: 'Spracherkennung oder Assistent konnte den Beitrag nicht verarbeiten.',
            };
    } finally {
      running--;
      call.busy = false;
      call.time = turn.time = Date.now();
    }
  }
  return {
    async submit(audio, id, callId, _auth, _signal, native = false) {
      const hash = createHash('sha256').update(audio).digest('hex'),
        prev = turns.get(id) || delivered.get(id);
      if (prev) {
        if (prev.callId !== callId || prev.hash !== hash)
          throw new Failure(409, 'Beitrags-ID bereits belegt.');
        return id;
      }
      const call = calls.get(callId) || {
        history: [],
        busy: false,
        time: Date.now(),
      };
      if (call.busy)
        throw new Failure(409, 'Für diesen Anruf läuft schon eine Antwort.');
      if (turns.size >= 500) {
        for (const [oldId, old] of turns) {
          if (!old.read) continue;
          delivered.set(oldId, {
            callId: old.callId,
            hash: old.hash,
            time: old.time,
          });
          turns.delete(oldId);
          break;
        }
      }
      if (
        running >= 4 ||
        turns.size >= 500 ||
        (calls.size >= 160 && !calls.has(callId))
      )
        throw new Failure(429, 'Der Dienst ist ausgelastet.');
      call.busy = true;
      calls.set(callId, call);
      const turn = {
        hash,
        callId,
        time: Date.now(),
        result: { state: 'working' },
      };
      turns.set(id, turn);
      running++;
      turn.done = run(audio, id, callId, call, turn, native);
      return id;
    },
    async waitForTurn(id, auth, signal, callId) {
      const turn = turns.get(id);
      if (turn?.callId === callId) await waitForCompletion(turn.done, signal);
      return this.poll(id, auth, signal, callId);
    },
    async poll(id, _auth, _signal, callId) {
      const turn = turns.get(id);
      if (!turn && delivered.get(id)?.callId === callId)
        throw new Failure(
          410,
          'Dieser bereits zugestellte Beitrag ist abgelaufen.',
        );
      if (!turn || turn.callId !== callId)
        throw new Failure(404, 'Beitrag nicht gefunden.');
      if (turn.result.state !== 'working') turn.read = true;
      return turn.result;
    },
  };
}
