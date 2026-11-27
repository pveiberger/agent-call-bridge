import { Failure, json, jsonPost, multipart, request } from './http.mjs';

export const clarification =
  'Das habe ich akustisch nicht verstanden. Kannst du es noch einmal sagen?';

export class UnclearTranscription extends Failure {
  constructor() {
    super(422, clarification);
  }
}

// The call adapters generate 16 kHz, mono PCM16. Check the RIFF chunks
// (including any padding or metadata) before treating the file as a short turn.
function isShortRecording(wav) {
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.readUInt32LE(4) !== wav.length - 8 ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    return false;
  let pcm = false;
  let dataBytes;
  for (let offset = 12, chunks = 0; offset < wav.length; chunks++) {
    if (chunks >= 128 || offset + 8 > wav.length) return false;
    const type = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    offset = start + size + (size % 2);
    if (offset > wav.length) return false;
    if (type === 'fmt ') {
      if (
        pcm ||
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16000 ||
        wav.readUInt32LE(start + 8) !== 32000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        return false;
      pcm = true;
    } else if (type === 'data') {
      if (dataBytes !== undefined || size === 0 || size % 2) return false;
      dataBytes = size;
    }
  }
  return pcm && dataBytes !== undefined && dataBytes <= 6 * 32000;
}

// Three consecutive copies of a long phrase in a clip of at most six seconds
// are characteristic of a decoder loop. Ordinary repeated words stay intact.
function hasRepeatedPhrase(text) {
  const words =
    text
      .slice(0, 4096)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  for (let width = 6; width <= Math.min(32, words.length / 3); width++) {
    let matching = 0;
    for (let i = width; i < words.length; i++) {
      matching = words[i] === words[i - width] ? matching + 1 : 0;
      if (matching >= 2 * width) return true;
    }
  }
  return false;
}

export function transcriber(env) {
  if (!env.STT_BASE_URL || !env.STT_MODEL)
    throw Error('Set both STT_BASE_URL and STT_MODEL');
  async function recognize(audio, signal, contextSize) {
    const fields = { model: env.STT_MODEL, response_format: 'json' };
    fields[env.STT_MODEL === 'gpt-transcribe' ? 'languages[]' : 'language'] =
      'de';
    if (env.STT_PROMPT?.trim()) fields.prompt = env.STT_PROMPT.trim();
    if (contextSize !== undefined) fields.audio_ctx = String(contextSize);
    const form = await multipart(fields, audio);
    if (env.STT_API_KEY)
      form.headers.Authorization = 'Bearer ' + env.STT_API_KEY;
    const result = await json(env.STT_BASE_URL, '/audio/transcriptions', {
      ...form,
      timeout: 120_000,
      limit: 512_000,
      signal,
    });
    if (typeof result?.text !== 'string')
      throw new Failure(
        502,
        'Die Spracherkennung hat eine ungültige Antwort geliefert.',
      );
    if (!result.text.trim()) throw new UnclearTranscription();
    return result.text.trim();
  }
  async function primary(audio, signal) {
    if (env.STT_WHISPER_SHORT_CONTEXT !== 'true')
      return recognize(audio, signal);
    const short = isShortRecording(audio);
    const first = await recognize(audio, signal, short ? 768 : 0);
    if (!short || !hasRepeatedPhrase(first)) return first;
    signal?.throwIfAborted();
    const full = await recognize(audio, signal, 0);
    if (hasRepeatedPhrase(full)) throw new UnclearTranscription();
    return full;
  }
  if (!env.STT_FAST_BASE_URL) return primary;
  // The optional local Parakeet service flags uncertain decoder output.
  // No agent request is made until one final transcript is selected.
  return async (audio, signal) => {
    if (!isShortRecording(audio)) return primary(audio, signal);
    const form = await multipart(
      { model: 'parakeet-tdt-0.6b-v3', language: 'de' },
      audio,
    );
    let quick;
    try {
      quick = await json(env.STT_FAST_BASE_URL, '/audio/transcriptions', {
        ...form,
        timeout: 4_000,
        limit: 512_000,
        signal,
      });
    } catch {
      signal?.throwIfAborted();
    }
    if (
      typeof quick?.text !== 'string' ||
      typeof quick.needs_review !== 'boolean'
    )
      return primary(audio, signal);
    const first = quick.text.trim();
    if (!first) throw new UnclearTranscription();
    if (!quick.needs_review) return first;
    const reviewed = await primary(audio, signal);
    const negative =
      /\b(?:nicht|nichts|nie|niemals|kein(?:e|en|em|er|es)?|nich|ned|net|nix|nöd)\b/iu;
    if (negative.test(first) !== negative.test(reviewed))
      throw new UnclearTranscription();
    return reviewed;
  };
}

// Pocket streams PCM in a WAV with placeholder sizes. Native calling SDKs
// need a finalized file after the last PCM sample has arrived.
function validatePocketHeader(wav) {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    wav.readUInt32LE(16) !== 16 ||
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(22) !== 1 ||
    wav.readUInt32LE(24) !== 24000 ||
    wav.readUInt16LE(34) !== 16 ||
    wav.toString('ascii', 36, 40) !== 'data'
  ) {
    throw new Failure(
      502,
      'Die Sprachausgabe hat ungültige Audiodaten geliefert.',
    );
  }
}
function finishPocketWave(wav) {
  validatePocketHeader(wav);
  if (wav.length <= 44 || wav.length % 2)
    throw new Failure(502, 'Unvollständige Sprachausgabe.');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

export async function* streamPocketAudio(base, text, signal) {
  const response = await fetch(base.replace(/\/$/, '') + '/tts', {
    method: 'POST',
    body: new URLSearchParams({ text }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Failure(502, 'Die Sprachausgabe ist nicht verfügbar.');
  }
  const header = Buffer.alloc(44);
  let filled = 0,
    bytes = 0;
  for await (let chunk of response.body) {
    if (filled < header.length) {
      const count = Math.min(chunk.length, header.length - filled);
      header.set(chunk.subarray(0, count), filled);
      filled += count;
      chunk = chunk.subarray(count);
      if (filled === header.length) validatePocketHeader(header);
    }
    if (chunk.length) {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024)
        throw new Failure(502, 'Die Audiodatei ist zu groß.');
      yield chunk;
    }
  }
  if (!bytes || bytes % 2)
    throw new Failure(502, 'Unvollständige Sprachausgabe.');
}

const announcements = new Set([
  clarification,
  'Sind Sie noch da? Wenn ja, sprechen Sie jetzt.',
  'Hallo, du kannst jetzt sprechen.',
]);

export function speechOutput(env) {
  const cache = new Map();
  const provider = env.TTS_ENGINE || 'piper';
  if (!['piper', 'pocket'].includes(provider))
    throw Error('Unknown TTS_ENGINE');
  const base = env.TTS_BASE_URL || 'http://call-tts:8090';
  return async (text, signal) => {
    if (cache.has(text)) return cache.get(text);
    let audio;
    if (provider === 'pocket') {
      audio = finishPocketWave(
        await request(base, '/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ text }).toString(),
          timeout: 90_000,
          signal,
        }),
      );
    } else {
      audio = await request(base, '/synthesize', {
        ...jsonPost({ text }),
        timeout: 90_000,
        signal,
      });
    }
    if (announcements.has(text)) cache.set(text, audio);
    return audio;
  };
}
