// Work in 20 ms frames so timings stay stable across device sample rates.
export class VoiceDetector {
  constructor(sampleRate, notify) {
    this.notify = notify;
    this.frame = new Float32Array(Math.round(sampleRate / 50));
    this.noise = 0.0025;
    this.arm(false);
  }

  arm(armed) {
    this.armed = armed;
    this.used = 0;
    this.pre = [];
    this.recording = null;
    this.onset = 0;
    this.silence = 0;
    this.voiced = 0;
  }

  feed(samples) {
    let from = 0;
    while (this.armed && from < samples.length) {
      const count = Math.min(
        this.frame.length - this.used,
        samples.length - from,
      );
      this.frame.set(samples.subarray(from, from + count), this.used);
      this.used += count;
      from += count;
      if (this.used === this.frame.length) {
        this.used = 0;
        this.analyseFrame();
      }
    }
  }

  analyseFrame() {
    let energy = 0;
    for (const sample of this.frame) energy += sample * sample;
    const rms = Math.sqrt(energy / this.frame.length);
    const loud = rms > Math.max(0.009, this.noise * 3.1);
    const ongoing = rms > Math.max(0.006, this.noise * 1.9);
    const pcm = this.toPcm();
    if (!this.recording) {
      this.pre.push(pcm);
      if (this.pre.length > 18) this.pre.shift();
      this.onset = loud ? this.onset + 1 : Math.max(0, this.onset - 1);
      if (!loud) this.noise += (Math.max(0.0008, rms) - this.noise) * 0.04;
      if (this.onset < 3) return;
      this.recording = this.pre;
      this.pre = [];
      this.voiced = this.onset;
      this.notify({ type: "voice" });
      return;
    }

    this.recording.push(pcm);
    if (ongoing) {
      this.voiced++;
      this.silence = 0;
    } else {
      this.silence++;
    }
    if (this.silence < 55 && this.recording.length < 4500) return;
    if (this.voiced < 6) {
      this.arm(true);
      this.notify({ type: "quiet" });
      return;
    }
    // Keep a little of the final pause and preserve the first consonant.
    const frames = this.recording.slice(
      0,
      this.recording.length - Math.max(0, this.silence - 9),
    );
    const wav = makeWav(frames);
    this.arm(false);
    this.notify({ type: "utterance", wav });
  }

  toPcm() {
    const pcm = new Int16Array(320);
    const ratio = this.frame.length / pcm.length;
    for (let i = 0; i < pcm.length; i++) {
      const start = Math.floor(i * ratio);
      const stop = Math.min(
        this.frame.length,
        Math.max(start + 1, Math.floor((i + 1) * ratio)),
      );
      let sum = 0;
      for (let j = start; j < stop; j++) sum += this.frame[j];
      const value = Math.max(-1, Math.min(1, sum / (stop - start)));
      pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
    }
    return pcm;
  }
}

function makeWav(frames) {
  const sampleCount = frames.length * 320;
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  function tag(at, string) {
    for (let i = 0; i < string.length; i++)
      view.setUint8(at + i, string.charCodeAt(i));
  }
  tag(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return buffer;
}
