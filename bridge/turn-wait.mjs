import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

export const waitMs = 6000;

// Nod broadcasts changes even when the reply arrives between two status
// requests. Read only the event type here; the authenticated turn lookup
// decides what the caller may hear, including any outstanding approval.
export async function waitForNod(base, headers, signal, poll, initial) {
  const close = new AbortController();
  const bounded = AbortSignal.any([
    signal,
    close.signal,
    AbortSignal.timeout(waitMs),
  ]);
  let stream;
  try {
    const url = new URL(base.replace(/\/$/, '') + '/api/events');
    const transport = url.protocol === 'https:' ? https : http;
    stream = await new Promise((resolve, reject) => {
      transport
        .get(url, { headers, signal: bounded }, resolve)
        .once('error', reject);
    });
    if (
      stream.statusCode !== 200 ||
      !stream.headers['content-type']?.startsWith('text/event-stream')
    )
      return initial;
    stream.setEncoding('utf8');
    let buffer = '',
      last = 0;
    for await (const chunk of stream) {
      buffer += chunk;
      let newline;
      let refresh = false;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:') || line.length > 65536) continue;
        try {
          if (JSON.parse(line.slice(5)).type === 'refresh') refresh = true;
        } catch {
          /* A malformed notification cannot deliver a reply. */
        }
      }
      if (buffer.length > 65536) break;
      if (refresh) {
        const remaining = last + 90 - performance.now();
        if (remaining > 0)
          await delay(remaining, undefined, { signal: bounded });
        const result = await poll();
        if (result.state !== 'working') return result;
        last = performance.now();
      }
    }
  } catch {
    signal.throwIfAborted();
  } finally {
    close.abort();
    stream?.destroy();
  }
  return poll();
}

export async function waitForCompletion(work, signal) {
  const close = new AbortController();
  try {
    await Promise.race([
      work,
      delay(waitMs, undefined, {
        signal: AbortSignal.any([signal, close.signal]),
      }),
    ]);
  } finally {
    close.abort();
  }
}
