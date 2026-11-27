import { DatabaseSync } from 'node:sqlite';

const urgent = /^(?:\[dringend\]|dringende rückfrage\s*:|dringend\s*:)\s*/iu;
const requestedEvent = /^angeforderter anruf\s*:\s*/iu;
const minute = 60_000;

export function pendingCallback(state, now) {
  if (
    !state.threadId ||
    state.verificationRequests?.length ||
    state.messages?.some((m) => m.approval?.state === 'pending')
  )
    return;
  const turns = new Map((state.turns || []).map((turn) => [turn.id, turn]));
  const tasks = new Map(
    (state.tasks || [])
      .filter((task) => task.questionMessageId)
      .map((task) => [task.questionMessageId, task]),
  );
  for (const message of [...(state.messages || [])].reverse()) {
    if (message.role === 'user') return;
    if (message.role !== 'assistant' || message.approval || !message.id)
      continue;
    const text = message.text?.trim();
    if (!text) continue;
    const event = requestedEvent.test(text);
    if (!event && (!urgent.test(text) || !text.includes('?'))) continue;
    const reason = text
      .replace(event ? requestedEvent : urgent, '')
      .trim()
      .slice(0, 600);
    if (!reason) continue;
    const task = tasks.get(message.id);
    if (task && task.status !== 'needs_you') return;
    const turn = turns.get(message.turnId);
    if (turn && ['cancelled', 'failed'].includes(turn.status)) return;
    if (
      message.answerChoices &&
      !(
        state.pendingAnswerChoiceMessageIds?.includes(message.id) ??
        message.answerChoicesPending
      )
    )
      return;
    const age = now - Date.parse(message.createdAt);
    if (!(age >= (event ? 0 : 5 * minute) && age < 60 * minute)) return;
    return { id: state.threadId + '.' + message.id, question: reason };
  }
}

export function createCallbacks(channels, filename, now = Date.now) {
  const order = channels
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    !order.length ||
    order.some((x) => !['whatsapp-linked', 'telegram', 'browser'].includes(x))
  )
    throw Error('Invalid CALLBACK_CHANNELS');
  const seen = new Map();
  const started = now();
  const db = new DatabaseSync(filename);
  db.exec(
    'CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  );
  const expire = db.prepare('DELETE FROM attempts WHERE at < ?');
  const claim = db.prepare(
    'INSERT OR IGNORE INTO attempts (id, at) VALUES (?, ?)',
  );
  function preferred(channel) {
    const rank = order.indexOf(channel);
    return (
      rank >= 0 &&
      (!rank ||
        (now() - started >= 30_000 &&
          !order
            .slice(0, rank)
            .some((c) => now() - (seen.get(c) ?? -Infinity) < 45_000)))
    );
  }
  return {
    async next(channel, load) {
      if (!order.includes(channel)) return {};
      seen.set(channel, now());
      if (!preferred(channel)) return {};
      const pending = pendingCallback(await load(), now());
      if (!pending || !preferred(channel)) return {};
      expire.run(now() - 24 * 60 * minute);
      return claim.run(pending.id, now()).changes ? pending : {};
    },
    close: () => db.close(),
  };
}
