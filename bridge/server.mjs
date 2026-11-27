import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Failure, equalSecret, read, uuid, webOrigins } from './http.mjs';
import { nodAdapter } from './nod.mjs';
import { compatibleAdapter } from './compatible.mjs';
import { speechOutput, streamPocketAudio, transcriber } from './speech.mjs';
import { spokenText } from './spoken-text.mjs';
import { createCallbacks } from './callbacks.mjs';

const e = process.env,
  kind = e.AGENT_BACKEND || 'nod',
  authMode = e.WEB_AUTH || 'token';
const names = { nod: 'Nod', hermes: 'Hermes', openclaw: 'OpenClaw' };
if (!Object.hasOwn(names, kind) || !['nod', 'token'].includes(authMode))
  throw Error('Invalid backend or web auth');
const { origin, authority } = webOrigins(
  e.PUBLIC_ORIGIN,
  e.NOD_PUBLIC_URL,
  authMode === 'nod',
);
if (authMode === 'nod' && kind !== 'nod')
  throw Error('Nod cookie authentication requires the Nod backend');
if (authMode === 'token' && (e.BRIDGE_WEB_TOKEN || '').length < 32)
  throw Error('Set BRIDGE_WEB_TOKEN (at least 32 characters)');
if (e.BRIDGE_CHANNEL_SECRET && e.BRIDGE_CHANNEL_SECRET.length < 32)
  throw Error('BRIDGE_CHANNEL_SECRET is too short');
if (
  kind === 'nod' &&
  (authMode === 'token' || e.BRIDGE_CHANNEL_SECRET) &&
  !e.NOD_AUTH_TOKEN
)
  throw Error('Set NOD_AUTH_TOKEN for standalone or channel access');
const nodCookie = 'nod-access-' + (e.NOD_PORT || '4310');
const ownCookie = 'agent-call-session';
const sessionValue =
  authMode === 'token'
    ? createHmac('sha256', e.BRIDGE_WEB_TOKEN)
        .update('voice session v1:' + origin)
        .digest('hex')
    : '';
const adapter =
  kind === 'nod'
    ? nodAdapter({
        base: e.NOD_BASE_URL || 'http://server:4310',
        authority,
        transcribe: e.STT_BASE_URL ? transcriber(e) : undefined,
      })
    : compatibleAdapter(e, kind);
const speak = speechOutput(e);
const files = fileURLToPath(new URL('../web/', import.meta.url));
const mime = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain',
};

function cookie(req, name) {
  return (req.headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='))
    ?.slice(name.length + 1);
}
function authentication(req, channel) {
  if (channel) {
    if (
      !equalSecret(
        req.headers.authorization?.replace(/^Bearer /, ''),
        e.BRIDGE_CHANNEL_SECRET,
      ) ||
      !req.headers.authorization?.startsWith('Bearer ')
    )
      throw new Failure(401, 'Kanal nicht angemeldet.');
  } else if (authMode === 'nod') {
    const key = cookie(req, nodCookie);
    if (!key || !/^[a-zA-Z0-9._~-]+$/.test(key))
      throw new Failure(401, 'Bitte bei Nod anmelden.');
    return { Cookie: nodCookie + '=' + key };
  } else if (!equalSecret(cookie(req, ownCookie), sessionValue)) {
    throw new Failure(401, 'Bitte für den Anruf anmelden.');
  }
  return kind === 'nod' ? { Authorization: 'Bearer ' + e.NOD_AUTH_TOKEN } : {};
}
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(
    Buffer.isBuffer(data) || type.startsWith('text/html')
      ? data
      : JSON.stringify(data),
  );
}
function checkOrigin(req) {
  if (
    req.headers.origin !== origin ||
    req.headers['sec-fetch-site'] === 'cross-site'
  )
    throw new Failure(403, 'Unzulässiger Ursprung.');
}
function isWav(bytes) {
  return (
    bytes.length >= 44 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
  );
}
const busy = new Set();
const waiting = new Set();
const realtime = kind === 'nod' && authMode === 'nod' && e.CALL_REALTIME === 'true';
const callbacks = kind === 'nod' && e.CALLBACK_CHANNELS
  ? createCallbacks(e.CALLBACK_CHANNELS, e.CALLBACK_DB || '/var/lib/callbacks/attempts.sqlite')
  : null;
const prepareShortSpeech = kind === 'nod' && !!e.STT_BASE_URL && !!e.STT_FAST_BASE_URL && e.CALL_PREPARE_SHORT_SPEECH === 'true';
async function route(req, res, signal) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health' && req.method === 'GET')
    return send(res, 200, { ok: true });
  if (path === '/anruf/login') {
    if (authMode === 'nod') {
      res.writeHead(303, { Location: '/' });
      return res.end();
    }
    if (req.method === 'GET') {
      // A no-referrer policy makes browsers send Origin: null on form POSTs.
      res.setHeader('Referrer-Policy', 'same-origin');
      return send(
        res,
        200,
        '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anruf anmelden</title><main><h1>Anruf anmelden</h1><form method="post"><label>Zugangsschlüssel <input type="password" name="token" required autocomplete="current-password"></label> <button>Anmelden</button></form></main></html>',
        'text/html; charset=utf-8',
      );
    }
    if (req.method === 'POST') {
      checkOrigin(req);
      const input = new URLSearchParams((await read(req, 1024)).toString());
      if (!equalSecret(input.get('token'), e.BRIDGE_WEB_TOKEN))
        throw new Failure(401, 'Zugangsschlüssel ungültig.');
      res.writeHead(303, {
        Location: '/anruf/',
        'Set-Cookie':
          ownCookie +
          '=' +
          sessionValue +
          '; Path=/anruf; HttpOnly; SameSite=Strict' +
          (origin.startsWith('https:') ? '; Secure' : ''),
      });
      return res.end();
    }
  }
  if (path === '/anruf' || path === '/') {
    res.writeHead(308, { Location: '/anruf/' });
    return res.end();
  }
  const channel = path.startsWith('/channel/'),
    web = path.startsWith('/anruf/api/');
  if (!channel && !web) {
    if (req.method !== 'GET' || !path.startsWith('/anruf/'))
      throw new Failure(404, 'Seite nicht gefunden.');
    const filename = path.slice(7) || 'index.html';
    if (!/^[\w-]+\.(?:html|js|css|svg|ico|woff2|txt)$/.test(filename))
      throw new Failure(404, 'Datei nicht gefunden.');
    let data;
    try {
      data = await readFile(files + filename);
    } catch {
      throw new Failure(404, 'Datei nicht gefunden.');
    }
    return send(res, 200, data, mime[filename.split('.').pop()]);
  }
  if (!channel && req.method === 'POST') checkOrigin(req);
  const auth = authentication(req, channel),
    action = path.slice(channel ? 9 : 11);
  if (req.method === 'POST' && (channel ? ['callback/whatsapp-linked', 'callback/telegram'].includes(action) : realtime && action === 'callback/browser')) {
    if (!callbacks) return send(res, 200, {});
    await adapter.check(auth, signal, web && authMode === 'nod');
    return send(res, 200, await callbacks.next(action.slice(9), () => adapter.callbackState(auth, signal)));
  }
  if (kind === 'nod')
    await adapter.check(auth, signal, web && authMode === 'nod');
  if (action === 'session' && req.method === 'GET' && !channel) {
    return send(res, 200, {
      ok: true,
      agent: names[kind],
      greeting: 'Hi, hier ist ' + names[kind] + '. Wie kann ich dir helfen?',
      ...(realtime ? { realtime: true, taskProject: (e.CALL_TASK_PROJECT || '').slice(0, 150) } : {}),
      ...(prepareShortSpeech ? { prepareShortSpeech: true } : {}),
      ...(e.TTS_ENGINE === 'pocket' ? { speechStream: true } : {}),
      chatUrl: e.CHAT_URL || (authMode === 'nod' ? '/' : null),
    });
  }
  const call = req.headers['x-call-id'];
  if (!uuid.test(call || '')) throw new Failure(400, 'Ungültige Anruf-ID.');
  if (realtime && web && action === 'transcript' && req.method === 'POST') {
    const id = req.headers['x-request-id'];
    if (!uuid.test(id || '') || req.headers['content-type']?.split(';')[0] !== 'text/plain')
      throw new Failure(400, 'Transkript und Beitrags-ID erforderlich.');
    const text = (await read(req, 48_000)).toString('utf8');
    return send(res, 200, { id: await adapter.submitTranscript(text, id, auth, signal) });
  }
  const preparation = prepareShortSpeech && web && action === 'prepare-utterance';
  if ((action === 'utterance' || preparation) && req.method === 'POST') {
    const id = req.headers['x-request-id'];
    if (
      !uuid.test(id || '') ||
      req.headers['content-type']?.split(';')[0] !== 'audio/wav'
    )
      throw new Failure(400, 'WAV und Beitrags-ID erforderlich.');
    if (preparation) {
      const bytes = await read(req, 192_044);
      if (!isWav(bytes)) throw new Failure(400, 'Ungültige WAV-Aufnahme.');
      await adapter.prepare(bytes, id, call, auth, signal);
      return send(res, 200, { ok: true });
    }
    if (busy.has(call) || busy.size >= 4)
      throw new Failure(429, 'Eine Aufnahme wird bereits verarbeitet.');
    busy.add(call);
    try {
      const bytes = await read(req, 10 * 1024 * 1024);
      if (!isWav(bytes)) throw new Failure(400, 'Ungültige WAV-Aufnahme.');
      return send(res, 200, {
        id: await adapter.submit(bytes, id, call, auth, signal, channel),
      });
    } finally {
      busy.delete(call);
    }
  }
  if (action.startsWith('turn/') && req.method === 'GET') {
    const id = action.slice(5);
    let turn = await adapter.poll(id, auth, signal, call, channel);
    if (
      turn.state === 'working' &&
      req.headers.prefer === 'wait=6' &&
      !waiting.has(call) &&
      waiting.size < 8
    ) {
      waiting.add(call);
      try {
        turn = await adapter.waitForTurn(id, auth, signal, call, turn, channel);
      } finally {
        waiting.delete(call);
      }
    }
    if (turn.state === 'reply' && typeof turn.text === 'string') {
      const speechText = spokenText(turn.text);
      if (speechText !== turn.text)
        return send(res, 200, { ...turn, speechText });
    }
    return send(res, 200, turn);
  }
  const streamSpeech = action === 'speech/stream' && e.TTS_ENGINE === 'pocket';
  if ((action === 'speech' || streamSpeech) && req.method === 'POST') {
    let input;
    try {
      input = JSON.parse((await read(req, 16_384)).toString());
    } catch (err) {
      if (err instanceof Failure) throw err;
      throw new Failure(400, 'Ungültige Anfrage.');
    }
    if (
      typeof input?.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 1600
    )
      throw new Failure(400, 'Ungültige Textlänge.');
    if (streamSpeech) {
      const chunks = streamPocketAudio(
        e.TTS_BASE_URL || 'http://call-tts:8090',
        input.text,
        signal,
      );
      const first = await chunks.next();
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Sample-Rate': '24000',
        'X-Accel-Buffering': 'no',
      });
      async function* audio() {
        try {
          yield first.value;
          yield* chunks;
        } finally {
          await chunks.return();
        }
      }
      return pipeline(audio(), res, { signal });
    }
    const bytes = await speak(input.text, signal);
    return send(res, 200, bytes, 'audio/wav');
  }
  throw new Failure(404, 'Funktion nicht gefunden.');
}
export const app = http.createServer((req, res) => {
  const cancel = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) cancel.abort();
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  route(req, res, cancel.signal).catch((err) => {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    const known = err instanceof Failure;
    send(res, known ? err.status : 502, {
      error: known
        ? err.message
        : 'Der Sprachdienst ist gerade nicht erreichbar.',
    });
  });
});
app.requestTimeout = 150_000;
if (import.meta.main) app.listen(8091, '0.0.0.0');
