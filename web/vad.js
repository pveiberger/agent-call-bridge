// Work in 20 ms frames so timings stay stable across device sample rates.
export class VoiceDetector {
  constructor(sampleRate, notify, prepareShortSpeech = false) {
    this.notify = notify;
    this.prepareShortSpeech = prepareShortSpeech;
    this.frame = new Float32Array(Math.round(sampleRate / 50));
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
    this.endSilenceFrames = 40;
    this.prepared = false;
    this.preparations = 0;
    this.bands = [];
    this.quietFrames = 0;
    this.background = null;
    this.recentChange = 0;
    this.low1 = 0;
    this.low2 = 0;
    this.low3 = 0;
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
    const pcm = this.toPcm();
    const speech = this.speechChanges(pcm);
    if (!this.recording) {
      this.pre.push(pcm);
      // Keep 560 ms locally so waiting for syllable changes preserves onsets.
      if (this.pre.length > 28) this.pre.shift();
      this.onset = speech ? this.onset + 1 : Math.max(0, this.onset - 1);
      if (this.onset < 3) return;
      this.recording = this.pre;
      this.pre = [];
      this.voiced = this.onset;
      this.notify({ type: "voice" });
      return;
    }

    this.recording.push(pcm);
    if (speech) {
      if (this.prepared) {
        this.prepared = false;
        this.notify({ type: "continued" });
      }
      // Leave more room for unfinished sentences when the speaker hesitates.
      if (this.silence >= 18) this.endSilenceFrames = 55;
      this.voiced++;
      // Confirm speech after 120 ms. Periodic updates also cover long phrases
      // followed by a microphone that stops delivering samples altogether.
      if (
        this.voiced === 6 ||
        this.voiced % 20 === 0 ||
        (this.voiced >= 6 && this.silence > 0)
      )
        this.notify({ type: "activity" });
      this.silence = 0;
    } else {
      if (this.voiced >= 6 && this.silence === 0)
        this.notify({ type: "activity" });
      this.silence++;
      if (this.prepareShortSpeech && this.silence === 19 && this.voiced >= 6 &&
          this.preparations < 2 && this.recording.length <= 300) {
        this.prepared = true;
        this.preparations++;
        this.notify({ type: "prepare", wav: this.recordedWav() });
      }
    }
    if (this.silence < this.endSilenceFrames && this.recording.length < 4500)
      return;
    if (this.voiced < 6) {
      this.arm(true);
      this.notify({ type: "quiet" });
      return;
    }
    // Keep a little of the final pause and preserve the first consonant.
    const wav = this.recordedWav();
    this.arm(false);
    this.notify({ type: "utterance", wav });
  }

  recordedWav() {
    return makeWav(this.recording.slice(0, this.recording.length - Math.max(0, this.silence - 9)));
  }

  speechChanges(pcm) {
    // Haar averages and differences measure three coarse frequency bands on
    // the 16 kHz frame. A fourth emphasizes vowel formants above low rumble.
    // The filter below only affects detection; transcription gets original PCM.
    let low = 0;
    let mid = 0;
    let high = 0;
    let formants = 0;
    for (let i = 0; i < pcm.length; i += 8) {
      const a = (pcm[i] + pcm[i + 1]) / 2;
      const b = (pcm[i + 2] + pcm[i + 3]) / 2;
      const c = (pcm[i + 4] + pcm[i + 5]) / 2;
      const d = (pcm[i + 6] + pcm[i + 7]) / 2;
      low += ((a + b + c + d) / 4) ** 2;
      mid += ((a + b - c - d) / 4) ** 2;
      high += ((a - b) ** 2 + (c - d) ** 2) / 8;

      let clear = 0;
      for (let j = i; j < i + 8; j++) {
        // Three one-pole highpasses around 500 Hz attenuate a fan fundamental.
        this.low1 += 0.18 * (pcm[j] - this.low1);
        const first = pcm[j] - this.low1;
        this.low2 += 0.18 * (first - this.low2);
        const second = first - this.low2;
        this.low3 += 0.18 * (second - this.low3);
        clear += second - this.low3;
      }
      formants += (clear / 4) ** 2;
    }

    // A digital silence gap can precede capture startup or a live room. Start
    // the noise estimate from the actual room in that case. Otherwise track
    // decreases faster than increases, so a softly spoken word still stands out.
    const currentBands = [low, mid, high, formants];
    const quiet = low + mid + high < 3500;
    if (!this.background || (!this.recording && !quiet && this.quietFrames >= 8))
      this.background = [...currentBands];
    this.quietFrames = quiet ? this.quietFrames + 1 : 0;
    let aboveBackground = false;
    let strongBands = 0;
    const ratio = this.recording ? 1.55 : 2.5;
    for (let band = 0; band < 4; band++) {
      const value = currentBands[band];
      const floor = this.background[band];
      if (value > ratio * floor + 600) aboveBackground = true;
      if (value > 4 * floor + 1200) strongBands++;
      const delta = value - floor;
      this.background[band] += delta < 0 ? delta * 0.18 : Math.min(delta, floor + 150) * 0.025;
    }
    if (quiet) {
      this.bands.length = 0;
      this.recentChange = 0;
      return false;
    }
    const history = this.bands;
    history.push(currentBands);
    if (history.length < 4) return this.voiced >= 6 && strongBands >= 2;
    if (history.length > 4) history.shift();
    // Syllables change amplitude and spectral shape. Compare two successive
    // 40 ms windows for changes across bands or a large change in one band.
    let changing = 0;
    let largeChange = false;
    for (let band = 0; band < 4; band++) {
      const previous = history[0][band] + history[1][band] + 350;
      const current = history[2][band] + history[3][band] + 350;
      const contrast = Math.max(previous, current) / Math.min(previous, current);
      if (contrast > 1.8) changing++;
      if (contrast > 3.5) largeChange = true;
    }
    if (changing >= 2 || largeChange) this.recentChange = this.voiced >= 6 ? 18 : 8;
    else if (this.recentChange > 0) this.recentChange--;
    return aboveBackground && this.recentChange > 0;
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
