// OpenAI-style raw speech is little-endian mono PCM16 at 24 kHz. Each 100 ms
// block is scheduled on the audio clock, independently of HTTP packet boundaries.
const sampleRate = 24_000;
const blockBytes = (sampleRate / 10) * 2;
const maxQueuedBlocks = 24;

export async function playPcmSpeech(context, signal, parts, open, onStart) {
  const sources = new Set();
  let reader,
    wake,
    nextStart = 0,
    started = false;

  function checkSignal() {
    if (signal.aborted)
      throw signal.reason || new DOMException("Anruf beendet", "AbortError");
  }
  function notify() {
    const resolve = wake;
    wake = null;
    resolve?.();
  }
  function stop() {
    if (reader) reader.cancel().catch(() => {});
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    sources.clear();
    notify();
  }
  async function waitForPlayback() {
    checkSignal();
    await new Promise((resolve) => {
      wake = resolve;
    });
    checkSignal();
  }
  async function schedule(bytes) {
    while (sources.size >= maxQueuedBlocks) await waitForPlayback();
    checkSignal();
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const buffer = context.createBuffer(1, bytes.length / 2, sampleRate);
    const pcm = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++)
      pcm[i] = data.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      notify();
    };
    const now = context.currentTime;
    if (!started || nextStart < now) nextStart = now + 0.015;
    source.start(nextStart);
    sources.add(source);
    nextStart += pcm.length / sampleRate;
    if (!started) {
      started = true;
      onStart();
    }
  }
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (const part of parts) {
      checkSignal();
      const response = await open(part);
      if (
        !response.body ||
        response.headers.get("X-Audio-Sample-Rate") !== String(sampleRate) ||
        response.headers.get("Content-Type")?.split(";")[0] !==
          "application/octet-stream"
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Unerwartetes Audioformat.");
      }
      reader = response.body.getReader();
      const block = new Uint8Array(blockBytes);
      let used = 0,
        received = false;
      while (true) {
        checkSignal();
        const { value, done } = await reader.read();
        if (done) break;
        received ||= value.length > 0;
        let offset = 0;
        while (offset < value.length) {
          const count = Math.min(block.length - used, value.length - offset);
          block.set(value.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (used === block.length) {
            await schedule(block);
            used = 0;
          }
        }
      }
      checkSignal();
      if (!received || used % 2)
        throw new Error("Unvollständiger Sprachstrom.");
      if (used) await schedule(block.subarray(0, used));
      reader.releaseLock();
      reader = null;
      // Open the next phrase while already scheduled audio is still playing.
    }
    while (sources.size) await waitForPlayback();
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    reader?.releaseLock();
  }
}
