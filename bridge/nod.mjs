import { createHash } from 'node:crypto';
import { Failure, json, jsonPost, multipart, request, uuid } from './http.mjs';
import { clarification, UnclearTranscription } from './speech.mjs';
import { waitForNod } from './turn-wait.mjs';

export function nodAdapter({ base, authority, transcribe }) {
  const upstream = new URL(base);
  if (upstream.username || upstream.password)
    throw Error('NOD_BASE_URL must not include credentials');
  // Keep only the binding for a rejected recording. Its spoken reply does
  // not enter Nod's chat or cause any tool use. A retried upload is idempotent.
  const clarifications = new Map();
  const preparations = new Map();
  const privateInputPending = (state) => state.verificationRequests?.length ||
    state.messages?.some((m) => m.approval?.state === 'pending');
  function audioBinding(audio, auth) {
    return createHash('sha256').update(auth.Cookie || auth.Authorization || '').update('\0').update(audio).digest('hex');
  }
  function clarificationReceipt(messageId, callId, audio, remember = false) {
    const prior = clarifications.get(messageId);
    if (!prior && !remember) return;
    const hash = createHash('sha256').update(audio).digest('hex');
    if (prior) {
      if (prior.callId !== callId || prior.hash !== hash)
        throw new Failure(409, 'Beitrags-ID bereits belegt.');
    } else {
      clarifications.set(messageId, { callId, hash });
      setTimeout(() => clarifications.delete(messageId), 60 * 60_000).unref();
    }
    return 'clarify.' + messageId;
  }
  function api(path, auth, options = {}) {
    return json(base, path, {
      ...options,
      headers: { Host: authority, ...auth, ...options.headers },
    });
  }
  async function submitMessage(route, payload, messageId, threadId, auth, signal) {
    const receipt = await api(route, auth, {
      ...payload, headers: { ...payload.headers, 'X-Nod-Input-Mode': 'voice-call' },
      signal, timeout: 135_000,
    });
    if (receipt.verificationStatus || receipt.messageId !== messageId || !uuid.test(receipt.turnId))
      throw new Failure(409, 'Diese Eingabe bitte direkt in Nod prüfen.');
    return [threadId, receipt.turnId, messageId].join('.');
  }
  async function requirePrivateSession(signal) {
    try {
      await request(base, '/api/session', {
        headers: { Host: authority, 'Cache-Control': 'no-cache' },
        signal,
        timeout: 5_000,
        limit: 32_768,
      });
    } catch (error) {
      if (error instanceof Failure && [401, 403].includes(error.status)) return;
    }
    throw new Failure(
      503,
      'Die Zugriffssperre von Nod konnte nicht bestätigt werden.',
    );
  }
  return {
    async submitTranscript(text, messageId, auth, signal) {
      if (typeof text !== 'string' || !text.trim() || text.length > 12000 || text.trimStart().startsWith('/'))
        throw new Failure(400, 'Ungültiger gesprochener Beitrag.');
      const state = await api('/api/state', auth, { signal });
      if (privateInputPending(state))
        throw new Failure(409, 'In Nod wartet eine Freigabe oder private Eingabe. Bitte öffne den Chat.');
      const body = jsonPost({ clientMessageId: messageId, threadId: state.threadId,
        chatClearedAt: state.chatClearedAt ?? null, text: text.trim(), attachmentIds: [] });
      return submitMessage('/api/messages', body, messageId, state.threadId, auth, signal);
    },
    async check(auth, signal, verifyCookieAccess = false) {
      if (verifyCookieAccess) await requirePrivateSession(signal);
      const session = await api('/api/session', auth, { signal });
      if (typeof session?.user?.id !== 'string' || !session.user.id.trim()) {
        throw new Failure(401, 'Bitte bei Nod anmelden.');
      }
    },
    async prepare(audio, messageId, callId, auth, signal) {
      if (!transcribe || audio.length > 192_044 || preparations.size >= 4 || preparations.has(callId)) return;
      const entry = { id: messageId, hash: audioBinding(audio, auth) };
      const forget = () => {
        if (preparations.get(callId) === entry) preparations.delete(callId);
      };
      preparations.set(callId, entry);
      const timer = setTimeout(forget, 8_000);
      timer.unref();
      entry.result = (async () => {
        const state = await api('/api/state', auth, { signal });
        if (privateInputPending(state)) return;
        return transcribe(audio, signal);
      })().then(text => ({ text }), error => ({ error }));
      const result = await entry.result;
      if (signal?.aborted || (!result.text && !(result.error instanceof UnclearTranscription))) {
        clearTimeout(timer);
        forget();
      }
    },
    async submit(audio, messageId, callId, auth, signal) {
      const localId = clarificationReceipt(messageId, callId, audio);
      if (localId) return localId;
      const state = await api('/api/state', auth, { signal });
      if (privateInputPending(state)) {
        throw new Failure(
          409,
          'In Nod wartet eine Freigabe oder private Eingabe. Bitte öffne den Chat.',
        );
      }
      const message = {
        clientMessageId: messageId,
        threadId: state.threadId,
        chatClearedAt: state.chatClearedAt ?? null,
        text: '',
        attachmentIds: [],
      };
      let route = '/api/messages/audio';
      let payload;
      if (transcribe) {
        let transcript;
        try {
          const prepared = preparations.get(callId);
          const matches = prepared?.id === messageId && prepared.hash === audioBinding(audio, auth);
          const result = matches ? await prepared.result : undefined;
          if (matches) preparations.delete(callId);
          signal?.throwIfAborted();
          if (result?.error instanceof UnclearTranscription) throw result.error;
          transcript = result?.text ?? await transcribe(audio, signal);
        } catch (error) {
          if (!(error instanceof UnclearTranscription)) throw error;
          return clarificationReceipt(messageId, callId, audio, true);
        }
        // Text-only chat commands have different semantics than a voice note.
        if (transcript.startsWith('/'))
          throw new Failure(409, 'Bitte gib Chatbefehle direkt im Chat ein.');
        const current = await api('/api/state', auth, { signal });
        if (
          current.threadId !== state.threadId ||
          current.chatClearedAt !== state.chatClearedAt ||
          privateInputPending(current)
        )
          throw new Failure(
            409,
            'Der Chat hat sich geändert. Bitte öffne Nod.',
          );
        route = '/api/messages';
        payload = jsonPost({ ...message, text: transcript });
      } else {
        payload = await multipart({ message: JSON.stringify(message) }, audio);
      }
      return submitMessage(route, payload, messageId, state.threadId, auth, signal);
    },
    waitForTurn(id, auth, signal, callId, initial) {
      return waitForNod(
        base,
        { Host: authority, ...auth, Accept: 'text/event-stream' },
        signal,
        () => this.poll(id, auth, signal, callId),
        initial,
      );
    },
    async poll(id, auth, signal, callId) {
      const parts = id.split('.');
      if (parts.length === 2 && parts[0] === 'clarify') {
        const local = clarifications.get(parts[1]);
        if (!local || local.callId !== callId)
          throw new Failure(404, 'Gespräch nicht gefunden.');
        return { state: 'reply', text: clarification };
      }
      if (parts.length !== 3 || !parts.every((x) => uuid.test(x)))
        throw new Failure(404, 'Gespräch nicht gefunden.');
      const [threadId, originalTurn, messageId] = parts;
      const state = await api('/api/state', auth, { signal });
      if (state.threadId !== threadId)
        return {
          state: 'error',
          text: 'Der ursprüngliche Chat wurde beendet.',
        };
      const index = state.messages.findIndex(
        (m) => m.id === messageId && m.role === 'user',
      );
      if (index < 0)
        return {
          state: 'error',
          text: 'Der Beitrag ist im aktuellen Chat nicht mehr sichtbar.',
        };
      const turnId = state.messages[index].turnId || originalTurn;
      const turn = state.turns.find((t) => t.id === turnId);
      const following = state.messages
        .slice(index + 1)
        .filter((m) => m.role === 'assistant');
      const explicit = following.filter(
        (m) => m.replyToMessageId === messageId,
      );
      const messages = explicit.length
        ? explicit
        : following.filter(
            (m) =>
              m.turnId === turnId &&
              (!m.replyToMessageId || m.replyToMessageId === messageId),
          );
      if (
        state.verificationRequests?.some((v) => v.turnId === turnId) ||
        messages.some((m) => m.approval?.state === 'pending')
      ) {
        return {
          state: 'approval',
          text: 'Nod braucht deine Bestätigung oder eine private Eingabe im Chat.',
        };
      }
      if (!turn)
        return {
          state: 'error',
          text: 'Der Bearbeitungsstand dieses Beitrags ist nicht mehr sichtbar. Bitte öffne den Nod-Chat.',
        };
      if (['queued', 'running'].includes(turn.status)) {
        const started = Date.parse(
          turn.createdAt || state.messages[index].createdAt,
        );
        if (!Number.isFinite(started) || Date.now() - started > 10 * 60_000) {
          return {
            state: 'error',
            text: 'Nod bearbeitet den Beitrag möglicherweise noch. Den weiteren Verlauf findest du im Chat.',
          };
        }
        return { state: 'working' };
      }
      if (['cancelled', 'failed'].includes(turn.status))
        return {
          state: 'error',
          text: 'Nod hat den Beitrag nicht abgeschlossen. Details stehen im Chat.',
        };
      const text = messages
        .map((m) => m.text?.trim())
        .filter(Boolean)
        .join('\n\n');
      if (text) return { state: 'reply', text };
      if (turn.status === 'waiting')
        return {
          state: 'approval',
          text: 'Bitte öffne Nod für den nächsten Schritt.',
        };
      return {
        state: 'reply',
        text: 'Nod hat geantwortet. Das Ergebnis findest du im Chat.',
      };
    },
  };
}
