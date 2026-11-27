import { VoiceDetector } from "./vad.js";

class NodCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.vad = new VoiceDetector(sampleRate, (event) => {
      this.port.postMessage(event, event.wav ? [event.wav] : []);
    });
    this.port.onmessage = ({ data }) => this.vad.arm(data === "listen");
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) this.vad.feed(samples);
    // Output remains silent; the capture graph never monitors mic audio.
    return true;
  }
}

registerProcessor("nod-call-capture", NodCapture);
