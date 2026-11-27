import { Failure, json, multipart, request, uuid } from './http.mjs';

export function nodAdapter({ base, authority }) {
  const upstream = new URL(base);
  if (upstream.username || upstream.password)
    throw Error('NOD_BASE_URL must not include credentials');
  function api(path, auth, options = {}) {
    return json(base, path, {
      ...options,
      headers: { Host: authority, ...auth, ...options.headers },
    });
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
    async check(auth, signal, verifyCookieAccess = false) {
      if (verifyCookieAccess) await requirePrivateSession(signal);
      const session = await api('/api/session', auth, { signal });
      if (typeof session?.user?.id !== 'string' || !session.user.id.trim()) {
        throw new Failure(401, 'Bitte bei Nod anmelden.');
      }
    },
    async submit(audio, messageId, _call, auth, signal) {
      const state = await api('/api/state', auth, { signal });
      if (
        state.verificationRequests?.length ||
        state.messages?.some((m) => m.approval?.state === 'pending')
      ) {
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
      const recording = await multipart(
        { message: JSON.stringify(message) },
        audio,
      );
      const receipt = await api('/api/messages/audio', auth, {
        ...recording,
        signal,
        timeout: 135_000,
      });
      if (
        receipt.verificationStatus ||
        receipt.messageId !== messageId ||
        !uuid.test(receipt.turnId)
      ) {
        throw new Failure(409, 'Diese Eingabe bitte direkt in Nod prüfen.');
      }
      return [state.threadId, receipt.turnId, messageId].join('.');
    },
    async poll(id, auth, signal) {
      const parts = id.split('.');
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
