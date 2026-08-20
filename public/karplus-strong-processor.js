// Karplus-Strong plucked-string AudioWorkletProcessor for Guitar Orbit. Plain
// JS (not TypeScript): it runs in the separate AudioWorkletGlobalScope, which
// has no DOM lib types and isn't part of this repo's tsc project (see
// tsconfig.json's "include"), so it isn't type-checked --- only the pure
// mapping functions in geometry.ts/audio.ts are.
//
// The algorithm is the textbook Karplus-Strong loop: a short burst of white
// noise (the pick) is written into a circular buffer whose length sets the
// pitch (sampleRate / frequency samples), then on every sample the two oldest
// values in the buffer are averaged and scaled by a decay factor, written
// back into the buffer, and read out as the next output sample. The
// averaging is itself a one-pole lowpass, so it removes high frequencies
// faster than low ones every time round the loop --- which is exactly why a
// real plucked string (and this model) sounds brightest right at the pick and
// progressively warmer as it rings down. Because the loop repeats once per
// period of the note (frequency times a second), a single fixed decay factor
// still makes higher notes die out faster than lower ones, same as a real
// string, with no per-note tuning needed.
//
// One instance is ever created per voice (see audio.ts); "pluck" messages
// retune and re-excite it in place rather than a new instance ever being
// created for a note change, so the single-voice, no-polyphony guarantee
// lives entirely in audio.ts's use of this processor, not in here.
class KarplusStrongProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = null;
    this.index = 0;
    this.decay = 0.996;
    this.active = false;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "pluck") {
        const frequency = Math.max(1, message.frequency);
        const length = Math.max(2, Math.round(sampleRate / frequency));
        const excite = message.exciteGain ?? 0.8;
        const buffer = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          buffer[i] = (Math.random() * 2 - 1) * excite;
        }
        this.buffer = buffer;
        this.index = 0;
        this.decay = message.decay ?? this.decay;
        this.active = true;
      } else if (message.type === "stop") {
        this.active = false;
        this.buffer = null;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    const buffer = this.buffer;
    if (!this.active || !buffer) {
      output.fill(0);
      return true;
    }

    const length = buffer.length;
    let index = this.index;
    for (let i = 0; i < output.length; i++) {
      const current = buffer[index];
      const nextIndex = index + 1 === length ? 0 : index + 1;
      const next = buffer[nextIndex];
      const value = this.decay * 0.5 * (current + next);
      buffer[index] = value;
      output[i] = value;
      index = nextIndex;
    }
    this.index = index;
    return true;
  }
}

registerProcessor("karplus-strong", KarplusStrongProcessor);
