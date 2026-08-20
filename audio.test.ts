import { describe, expect, it } from "vitest";
import {
  MAX_CUTOFF_HZ,
  MIN_CUTOFF_HZ,
  cutoffForNormalizedAngle,
  nextVoiceState,
  noteFrequency,
} from "./audio.ts";

// Only the pure, AudioContext-free mapping functions are tested here ---
// see spec/README.md and Stage 3's report for why the graph itself isn't
// faked in JSDOM just to raise the test count.

describe("noteFrequency", () => {
  it("maps the six locked ring notes to their standard concert-pitch frequencies", () => {
    expect(noteFrequency("E3")).toBeCloseTo(164.81);
    expect(noteFrequency("G3")).toBeCloseTo(196.0);
    expect(noteFrequency("A3")).toBeCloseTo(220.0);
    expect(noteFrequency("B3")).toBeCloseTo(246.94);
    expect(noteFrequency("D4")).toBeCloseTo(293.66);
    expect(noteFrequency("E4")).toBeCloseTo(329.63);
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
// Audio, just the state table startVoice/releaseVoice/onended consult.
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
