import { createHash } from 'node:crypto';
import { Failure, json, jsonPost, multipart } from './http.mjs';

// Hermes accepts explicit OpenAI-format history. OpenClaw routes by session key.
export function compatibleAdapter(env, kind) {
  const turns = new Map(),
    calls = new Map();
  let running = 0;
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
    for (const map of [turns, calls])
      for (const [key, value] of map) if (value.time < cutoff) map.delete(key);
  }, 60_000);
  prune.unref();
  async function run(audio, id, callId, call, turn) {
    try {
      const form = await multipart(
        { model: env.STT_MODEL, language: 'de' },
        audio,
      );
      if (env.STT_API_KEY)
        form.headers.Authorization = 'Bearer ' + env.STT_API_KEY;
      const transcript = await json(env.STT_BASE_URL, '/audio/transcriptions', {
        ...form,
        timeout: 120_000,
      });
      if (!transcript.text?.trim()) throw new Error('empty transcript');
      const user = { role: 'user', content: transcript.text.trim() };
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
    } catch {
      turn.result = {
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
    async submit(audio, id, callId) {
      const hash = createHash('sha256').update(audio).digest('hex'),
        prev = turns.get(id);
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
      void run(audio, id, callId, call, turn);
      return id;
    },
    async poll(id, _auth, _signal, callId) {
      const turn = turns.get(id);
      if (!turn || turn.callId !== callId)
        throw new Failure(404, 'Beitrag nicht gefunden.');
      return turn.result;
    },
  };
}
