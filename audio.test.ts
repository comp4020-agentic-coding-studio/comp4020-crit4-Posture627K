import { describe, expect, it } from "vitest";
import {
  ATTACK_SECONDS,
  BRIGHTNESS_DECAY_TIME_CONSTANT,
  BRIGHTNESS_HOLD_SECONDS,
  EXCITE_GAIN,
  FILTER_Q,
  INITIAL_PLUCK_BRIGHTNESS_DECAY_TIME_CONSTANT,
  INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS,
  INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER,
  MAX_CUTOFF_HZ,
  MIN_CUTOFF_HZ,
  OUTPUT_GAIN,
  REARTICULATION_BRIGHTNESS_MULTIPLIER,
  RELEASE_SECONDS,
  STRING_DECAY,
  brightnessAccentCutoff,
  cutoffForNormalizedAngle,
  initialPluckBrightnessCutoff,
  nextVoiceState,
  noteFrequency,
} from "./audio.ts";

// Only the pure, AudioContext-free mapping functions are tested here ---
// see spec/README.md and Stage 3's report for why the graph itself isn't
// faked in JSDOM just to raise the test count. This also means the
// Karplus-Strong string itself (public/karplus-strong-processor.js) isn't
// tested from here: it runs in a real AudioWorkletGlobalScope, which JSDOM
// doesn't provide, and faking that scope just to execute it would be
// exactly the kind of fake-browser-audio test the project avoids.

describe("noteFrequency", () => {
  it("maps every note family's base (middle) register to its standard concert-pitch frequency", () => {
    expect(noteFrequency("E3")).toBeCloseTo(164.81);
    expect(noteFrequency("G3")).toBeCloseTo(196.0);
    expect(noteFrequency("A3")).toBeCloseTo(220.0);
    expect(noteFrequency("B3")).toBeCloseTo(246.94);
    expect(noteFrequency("D3")).toBeCloseTo(146.83);
  });

  it("maps every note family's lower (-1) register an octave down from its base", () => {
    expect(noteFrequency("E2")).toBeCloseTo(82.41);
    expect(noteFrequency("G2")).toBeCloseTo(98.0);
    expect(noteFrequency("A2")).toBeCloseTo(110.0);
    expect(noteFrequency("B2")).toBeCloseTo(123.47);
    expect(noteFrequency("D2")).toBeCloseTo(73.42);
  });

  it("maps every note family's upper (+1) register an octave up from its base", () => {
    expect(noteFrequency("E4")).toBeCloseTo(329.63);
    expect(noteFrequency("G4")).toBeCloseTo(392.0);
    expect(noteFrequency("A4")).toBeCloseTo(440.0);
    expect(noteFrequency("B4")).toBeCloseTo(493.88);
    expect(noteFrequency("D4")).toBeCloseTo(293.66);
  });

  it("doubles in frequency exactly one octave apart, for every family", () => {
    for (const family of ["E", "G", "A", "B", "D"]) {
      const low = noteFrequency(`${family}2`);
      const mid = noteFrequency(`${family}3`);
      const high = noteFrequency(`${family}4`);
      expect(mid).toBeCloseTo(low * 2, 0);
      expect(high).toBeCloseTo(mid * 2, 0);
    }
  });

  it("stays within a Karplus-Strong-stable range (well clear of unstable extremes)", () => {
    for (const family of ["E", "G", "A", "B", "D"]) {
      for (const octave of [2, 3, 4]) {
        const hz = noteFrequency(`${family}${octave}`);
        expect(hz).toBeGreaterThan(50);
        expect(hz).toBeLessThan(600);
      }
    }
  });

  it("returns 0 for an unrecognised note", () => {
    expect(noteFrequency("Z9")).toBe(0);
  });
});

describe("cutoffForNormalizedAngle", () => {
  it("returns the minimum cutoff at angle 0", () => {
    expect(cutoffForNormalizedAngle(0)).toBeCloseTo(MIN_CUTOFF_HZ);
  });

  it("returns the maximum cutoff at angle 1", () => {
    expect(cutoffForNormalizedAngle(1)).toBeCloseTo(MAX_CUTOFF_HZ);
  });

  it("is monotonically increasing across the normalized range", () => {
    const samples = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];
    for (let i = 1; i < samples.length; i++) {
      expect(cutoffForNormalizedAngle(samples[i])).toBeGreaterThan(
        cutoffForNormalizedAngle(samples[i - 1]),
      );
    }
  });
});

// This is the one part of the voice lifecycle that's pure and worth testing
// directly --- it has no AudioContext in it at all. It's not a mock of Web
// Audio, just the state table startVoice/releaseVoice consult.
describe("nextVoiceState: the idle -> active -> releasing -> idle lifecycle", () => {
  it("moves from idle to active on start", () => {
    expect(nextVoiceState("idle", "start")).toBe("active");
  });

  it("ignores start while already active or releasing (no polyphony)", () => {
    expect(nextVoiceState("active", "start")).toBe("active");
    expect(nextVoiceState("releasing", "start")).toBe("releasing");
  });

  it("moves from active to releasing on release", () => {
    expect(nextVoiceState("active", "release")).toBe("releasing");
  });

  it("ignores release when not active", () => {
    expect(nextVoiceState("idle", "release")).toBe("idle");
    expect(nextVoiceState("releasing", "release")).toBe("releasing");
  });

  it("moves from releasing to idle only on end", () => {
    expect(nextVoiceState("releasing", "end")).toBe("idle");
  });

  it("ignores end unless releasing (the release cannot be cut short)", () => {
    expect(nextVoiceState("idle", "end")).toBe("idle");
    expect(nextVoiceState("active", "end")).toBe("active");
  });
});

describe("Karplus-Strong string parameters", () => {
  it("keeps the feedback decay coefficient below 1, so every note dies away", () => {
    expect(STRING_DECAY).toBeLessThan(1);
    expect(STRING_DECAY).toBeGreaterThan(0.9); // still close enough to 1 for a multi-second natural decay
  });

  it("keeps the excitation (pick noise burst) gain in a safe, non-clipping range", () => {
    expect(EXCITE_GAIN).toBeGreaterThan(0);
    expect(EXCITE_GAIN).toBeLessThanOrEqual(1);
  });

  it("keeps the overall output gain within headroom-safe bounds", () => {
    expect(OUTPUT_GAIN).toBeGreaterThan(0);
    expect(OUTPUT_GAIN).toBeLessThanOrEqual(1);
  });
});

describe("output gain ramp constants: click-free start, smooth release", () => {
  it("keeps the attack ramp very short --- just long enough to avoid a click", () => {
    expect(ATTACK_SECONDS).toBeGreaterThan(0);
    expect(ATTACK_SECONDS).toBeLessThanOrEqual(0.01);
  });

  it("keeps the release smooth (within the ~90-110ms target)", () => {
    expect(RELEASE_SECONDS).toBeGreaterThanOrEqual(0.09);
    expect(RELEASE_SECONDS).toBeLessThanOrEqual(0.11);
  });
});

describe("filter range and Q: brighter, still non-resonant", () => {
  it("opens the normal cutoff range to roughly 700-12000 Hz", () => {
    expect(MIN_CUTOFF_HZ).toBeCloseTo(700);
    expect(MAX_CUTOFF_HZ).toBeCloseTo(12000);
  });

  it("keeps Q close to neutral/Butterworth (0.6-0.707), with no resonant peak", () => {
    expect(FILTER_Q).toBeGreaterThanOrEqual(0.6);
    expect(FILTER_Q).toBeLessThanOrEqual(0.7071067811865476);
  });
});

describe("brightnessAccentCutoff", () => {
  it("brightens above the angle's own cutoff", () => {
    expect(brightnessAccentCutoff(0.5)).toBeGreaterThan(cutoffForNormalizedAngle(0.5));
  });

  it("multiplies the angle's cutoff by the brightness multiplier", () => {
    expect(brightnessAccentCutoff(0.3)).toBeCloseTo(
      cutoffForNormalizedAngle(0.3) * REARTICULATION_BRIGHTNESS_MULTIPLIER,
    );
  });

  it("never exceeds the filter's own maximum cutoff, even at the top of the angle range", () => {
    expect(brightnessAccentCutoff(1)).toBeLessThanOrEqual(MAX_CUTOFF_HZ);
    expect(brightnessAccentCutoff(0.95)).toBeLessThanOrEqual(MAX_CUTOFF_HZ);
  });
});

describe("note-change brightness accent timing", () => {
  it("brightens by roughly 1.8x, per the brighter steel-string retune", () => {
    expect(REARTICULATION_BRIGHTNESS_MULTIPLIER).toBeCloseTo(1.8);
  });

  it("decays over roughly 40-60ms, so it's perceptible as a shimmer rather than instant", () => {
    expect(BRIGHTNESS_DECAY_TIME_CONSTANT).toBeGreaterThanOrEqual(0.04);
    expect(BRIGHTNESS_DECAY_TIME_CONSTANT).toBeLessThanOrEqual(0.06);
  });

  it("holds off normal filter tracking for roughly 120-160ms, long enough for the curve to settle before tracking resumes", () => {
    expect(BRIGHTNESS_HOLD_SECONDS).toBeCloseTo(BRIGHTNESS_DECAY_TIME_CONSTANT * 3);
    expect(BRIGHTNESS_HOLD_SECONDS).toBeGreaterThanOrEqual(0.12);
    expect(BRIGHTNESS_HOLD_SECONDS).toBeLessThanOrEqual(0.16);
  });
});

describe("initialPluckBrightnessCutoff: the first pluck's own bright transient", () => {
  it("brightens above the angle's own cutoff", () => {
    expect(initialPluckBrightnessCutoff(0.5)).toBeGreaterThan(cutoffForNormalizedAngle(0.5));
  });

  it("multiplies the angle's cutoff by the initial-pluck brightness multiplier", () => {
    expect(initialPluckBrightnessCutoff(0.3)).toBeCloseTo(
      cutoffForNormalizedAngle(0.3) * INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER,
    );
  });

  it("never exceeds the filter's own maximum cutoff", () => {
    expect(initialPluckBrightnessCutoff(1)).toBeLessThanOrEqual(MAX_CUTOFF_HZ);
  });

  it("uses a multiplier within the 1.7-1.9x target", () => {
    expect(INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER).toBeGreaterThanOrEqual(1.7);
    expect(INITIAL_PLUCK_BRIGHTNESS_MULTIPLIER).toBeLessThanOrEqual(1.9);
  });

  it("holds its brightness for roughly 100-160ms before settling to the normal cutoff", () => {
    expect(INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS).toBeCloseTo(INITIAL_PLUCK_BRIGHTNESS_DECAY_TIME_CONSTANT * 3);
    expect(INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS).toBeGreaterThanOrEqual(0.1);
    expect(INITIAL_PLUCK_BRIGHTNESS_HOLD_SECONDS).toBeLessThanOrEqual(0.16);
  });
});
