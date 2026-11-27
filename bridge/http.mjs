import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function webOrigins(publicUrl, nodUrl, useNodCookie) {
  function originUrl(value) {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw Error(
        'Configure an HTTP(S) origin without a path, query, fragment or credentials',
      );
    }
    return url;
  }
  const address = originUrl(publicUrl);
  const host = address.hostname;
  const loopback =
    host === 'localhost' ||
    host === 'localhost.' ||
    host === '[::1]' ||
    (isIP(host) === 4 && host.startsWith('127.'));
  if (address.protocol !== 'https:' && !loopback)
    throw Error('PUBLIC_ORIGIN must use HTTPS outside loopback');
  const nod = nodUrl ? originUrl(nodUrl) : address;
  if (useNodCookie && address.origin !== nod.origin)
    throw Error(
      'Nod cookie authentication requires the same scheme, host and port as Nod',
    );
  return { origin: address.origin, authority: nod.host };
}
export function equalSecret(a, b) {
  if (!a || !b) return false;
  const hash = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export async function read(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Failure(413, 'Die Nachricht ist zu groß.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function request(
  base,
  path,
  {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeout = 25_000,
    limit = 16 * 1024 * 1024,
  } = {},
) {
  const url = new URL(base.replace(/\/$/, '') + path);
  const transport = url.protocol === 'https:' ? https : http;
  const deadline = AbortSignal.timeout(timeout);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method,
        headers,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      },
      async (res) => {
        try {
          const bytes = await read(res, limit);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const status = res.statusCode;
            const label =
              status === 401 || status === 403
                ? 'Anmeldung oder Berechtigung fehlt.'
                : status === 429
                  ? 'Der Dienst ist ausgelastet. Bitte kurz warten.'
                  : status === 409
                    ? 'Der Chat hat sich geändert. Bitte im Chat prüfen.'
                    : 'Der verbundene Dienst konnte die Anfrage nicht abschließen.';
            throw new Failure(status, label);
          }
          resolve(bytes);
        } catch (err) {
          reject(err);
        }
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
export async function json(base, path, options) {
  return JSON.parse((await request(base, path, options)).toString('utf8'));
}
export function jsonPost(data, headers = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(data)),
  };
}
export function multipart(fields, audio) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  const serialized = new Response(form);
  return serialized
    .arrayBuffer()
    .then((buffer) => ({
      method: 'POST',
      headers: { 'Content-Type': serialized.headers.get('content-type') },
      body: Buffer.from(buffer),
    }));
}
export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
