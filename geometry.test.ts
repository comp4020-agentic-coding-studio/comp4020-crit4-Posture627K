import { describe, expect, it } from "vitest";
import {
  NOTES,
  RING_COUNT,
  angleFromCentre,
  classifyRing,
  computeGeometry,
  normalizedAngle,
  noteForRing,
  resolveRing,
  ringBoundaries,
  type OrbitGeometry,
} from "./geometry.ts";

describe("computeGeometry", () => {
  it("scales from the viewport's smaller dimension at 1920x1080 (landscape desktop)", () => {
    const g = computeGeometry(1920, 1080);
    expect(g.centerX).toBeCloseTo(960);
    expect(g.centerY).toBeCloseTo(540);
    expect(g.outerRadius).toBeCloseTo(1080 * 0.45);
    expect(g.innerRadius).toBeCloseTo(g.outerRadius * 0.2);
    expect(g.ringWidth).toBeCloseTo((g.outerRadius - g.innerRadius) / RING_COUNT);
  });

  it("scales from the viewport's smaller dimension at 390x844 (portrait phone)", () => {
    const g = computeGeometry(390, 844);
    expect(g.centerX).toBeCloseTo(195);
    expect(g.centerY).toBeCloseTo(422);
    // width, not height, is the smaller dimension here
    expect(g.outerRadius).toBeCloseTo(390 * 0.45);
    expect(g.innerRadius).toBeCloseTo(g.outerRadius * 0.2);
  });

  it("maps the same relative radius to the same ring regardless of viewport size", () => {
    const desktop = computeGeometry(1920, 1080);
    const phone = computeGeometry(390, 844);
    for (const fraction of [0.1, 0.4, 0.6, 0.9]) {
      const desktopRadius = desktop.innerRadius + fraction * (desktop.outerRadius - desktop.innerRadius);
      const phoneRadius = phone.innerRadius + fraction * (phone.outerRadius - phone.innerRadius);
      expect(classifyRing(desktopRadius, desktop)).toBe(classifyRing(phoneRadius, phone));
    }
  });
});

describe("classifyRing: the six rings, the dead zone, and outside", () => {
  const g = computeGeometry(1920, 1080);
  const bounds = ringBoundaries(g);

  it("returns null inside the central non-playable guitar area", () => {
    expect(classifyRing(0, g)).toBeNull();
    expect(classifyRing(g.innerRadius - 1, g)).toBeNull();
  });

  it("returns null outside the outer playable radius", () => {
    expect(classifyRing(g.outerRadius, g)).toBeNull();
    expect(classifyRing(g.outerRadius + 500, g)).toBeNull();
  });

  it("maps a radius at the midpoint of each ring to that ring", () => {
    for (let ring = 1; ring <= RING_COUNT; ring++) {
      const mid = (bounds[ring - 1] + bounds[ring]) / 2;
      expect(classifyRing(mid, g)).toBe(ring);
    }
  });

  it("treats each boundary as the start of the next ring (half-open bands)", () => {
    for (let ring = 1; ring <= RING_COUNT; ring++) {
      expect(classifyRing(bounds[ring - 1], g)).toBe(ring);
    }
    // the outer boundary itself is outside, not ring 6
    expect(classifyRing(bounds[RING_COUNT], g)).toBeNull();
  });

  it("switches rings immediately at a boundary when there is no previous ring to stick to", () => {
    const boundary = bounds[1];
    expect(classifyRing(boundary - 0.001, g)).toBe(1);
    expect(classifyRing(boundary + 0.001, g)).toBe(2);
  });
});

describe("noteForRing", () => {
  it("maps all six rings to the locked note sequence, inner to outer", () => {
    expect(NOTES).toEqual(["E3", "G3", "A3", "B3", "D4", "E4"]);
    for (let ring = 1; ring <= RING_COUNT; ring++) {
      expect(noteForRing(ring)).toBe(NOTES[ring - 1]);
    }
  });

  it("returns null for no ring and for out-of-range ring indices", () => {
    expect(noteForRing(null)).toBeNull();
    expect(noteForRing(0)).toBeNull();
    expect(noteForRing(7)).toBeNull();
  });
});

describe("resolveRing: hysteresis against a previous ring", () => {
  const g = computeGeometry(1920, 1080);
  const bounds = ringBoundaries(g);

  it("behaves exactly like classifyRing when there is no previous ring", () => {
    const r = bounds[2] + 3;
    expect(resolveRing(r, null, g)).toBe(classifyRing(r, g));
  });

  it("does not flip when a raw boundary is crossed by less than the margin", () => {
    const boundary = bounds[1]; // between ring 1 and ring 2
    const justPast = boundary + 1; // raw classifyRing would already say ring 2
    expect(classifyRing(justPast, g)).toBe(2);
    expect(resolveRing(justPast, 1, g)).toBe(1); // hysteresis keeps ring 1
  });

  it("does flip once the pointer moves past the boundary by more than the margin", () => {
    const boundary = bounds[1];
    const margin = g.ringWidth * 0.15;
    const wellPast = boundary + margin + 1;
    expect(resolveRing(wellPast, 1, g)).toBe(2);
  });

  it("does not flip back and forth while oscillating near a boundary", () => {
    const boundary = bounds[1];
    let ring: number | null = classifyRing(boundary - 5, g); // starts in ring 1
    expect(ring).toBe(1);
    for (const radius of [boundary + 2, boundary - 2, boundary + 2, boundary - 2]) {
      ring = resolveRing(radius, ring, g);
      expect(ring).toBe(1);
    }
  });

  it("applies hysteresis at the inner (dead-zone) boundary too", () => {
    const margin = g.ringWidth * 0.15;
    const justInsideDeadZone = g.innerRadius - margin / 2;
    expect(classifyRing(justInsideDeadZone, g)).toBeNull();
    expect(resolveRing(justInsideDeadZone, 1, g)).toBe(1); // stays ring 1

    const wellInsideDeadZone = g.innerRadius - margin - 1;
    expect(resolveRing(wellInsideDeadZone, 1, g)).toBeNull();
  });

  it("applies hysteresis at the outer boundary too", () => {
    const margin = g.ringWidth * 0.15;
    const justPastOuter = g.outerRadius + margin / 2;
    expect(classifyRing(justPastOuter, g)).toBeNull();
    expect(resolveRing(justPastOuter, RING_COUNT, g)).toBe(RING_COUNT); // stays ring 6

    const wellPastOuter = g.outerRadius + margin + 1;
    expect(resolveRing(wellPastOuter, RING_COUNT, g)).toBeNull();
  });

  it("can still jump straight to the right ring on a fast drag, skipping the ones between", () => {
    const g2 = computeGeometry(1920, 1080);
    const farRing = resolveRing(g2.outerRadius - 1, 1, g2);
    expect(farRing).toBe(RING_COUNT);
  });
});

describe("angleFromCentre and normalizedAngle", () => {
  const g: OrbitGeometry = {
    centerX: 100,
    centerY: 100,
    innerRadius: 10,
    outerRadius: 90,
    ringWidth: 13.33,
  };

  it("is 0 due right of centre", () => {
    expect(angleFromCentre(200, 100, g)).toBeCloseTo(0);
  });

  it("is PI/2 directly below centre (screen y grows downward)", () => {
    expect(angleFromCentre(100, 200, g)).toBeCloseTo(Math.PI / 2);
  });

  it("is PI directly left of centre", () => {
    expect(angleFromCentre(0, 100, g)).toBeCloseTo(Math.PI);
  });

  it("wraps a negative atan2 result into [0, 2*PI) directly above centre", () => {
    expect(angleFromCentre(100, 0, g)).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("stays within [0, 2*PI) for every quadrant", () => {
    for (const [x, y] of [[150, 150], [50, 150], [50, 50], [150, 50]] as const) {
      const angle = angleFromCentre(x, y, g);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(Math.PI * 2);
    }
  });

  it("normalizes angle to a [0, 1) value for the future filter mapping", () => {
    expect(normalizedAngle(0)).toBeCloseTo(0);
    expect(normalizedAngle(Math.PI)).toBeCloseTo(0.5);
    expect(normalizedAngle((3 * Math.PI) / 2)).toBeCloseTo(0.75);
    expect(normalizedAngle(Math.PI * 2 - 0.0001)).toBeLessThan(1);
  });
});
