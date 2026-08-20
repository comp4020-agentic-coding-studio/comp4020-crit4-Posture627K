import { describe, expect, it } from "vitest";
import {
  BASE_OCTAVE,
  INNER_RADIUS_RATIO,
  NOTES,
  OUTER_RADIUS_RATIO,
  REGISTER_HYSTERESIS_RATIO,
  RING_COUNT,
  angleFromCentre,
  classifyRegister,
  classifyRing,
  computeGeometry,
  normalizedAngle,
  normalizedVerticalPosition,
  noteForRing,
  octaveForRegister,
  resolveRegister,
  resolveRing,
  resolvedNoteName,
  ringBoundaries,
  type OrbitGeometry,
  type Register,
} from "./geometry.ts";

describe("computeGeometry", () => {
  it("scales from the viewport's half-diagonal at 1920x1080 (landscape desktop)", () => {
    const g = computeGeometry(1920, 1080);
    const halfDiagonal = Math.hypot(1920, 1080) / 2;
    expect(g.centerX).toBeCloseTo(960);
    expect(g.centerY).toBeCloseTo(540);
    expect(g.outerRadius).toBeCloseTo(halfDiagonal * OUTER_RADIUS_RATIO);
    expect(g.innerRadius).toBeCloseTo(g.outerRadius * INNER_RADIUS_RATIO);
    expect(g.ringWidth).toBeCloseTo((g.outerRadius - g.innerRadius) / RING_COUNT);
  });

  it("scales from the viewport's half-diagonal at 390x844 (portrait phone)", () => {
    const g = computeGeometry(390, 844);
    const halfDiagonal = Math.hypot(390, 844) / 2;
    expect(g.centerX).toBeCloseTo(195);
    expect(g.centerY).toBeCloseTo(422);
    expect(g.outerRadius).toBeCloseTo(halfDiagonal * OUTER_RADIUS_RATIO);
    expect(g.innerRadius).toBeCloseTo(g.outerRadius * INNER_RADIUS_RATIO);
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

  it("covers every point of the viewport rectangle: outer radius exceeds the centre-to-corner distance", () => {
    // The requirement this design satisfies: an ordinary pointer position
    // anywhere in the visible rectangle should land inside the radial
    // instrument rather than being classified as "outside". The
    // centre-to-corner distance is the farthest any point in the rectangle
    // can be from the centre, so the outer radius must exceed it --- checked
    // here directly against the geometric definition, not by re-deriving the
    // implementation's own formula, and across several shapes/orientations
    // so no single viewport hardcodes the result.
    const viewports: Array<[number, number]> = [
      [1920, 1080],
      [390, 844],
      [844, 390],
      [1024, 1024],
      [2560, 1440],
    ];
    for (const [width, height] of viewports) {
      const g = computeGeometry(width, height);
      const cornerDistance = Math.hypot(width / 2, height / 2);
      expect(g.outerRadius).toBeGreaterThan(cornerDistance);
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
      // A tiny nudge past the boundary: reconstructing (radius - innerRadius)
      // / ringWidth from a boundary computed as innerRadius + i * ringWidth
      // doesn't always round-trip to exactly i in floating point, so testing
      // the exact boundary value is inherently flaky. A point unambiguously
      // just past it still verifies the half-open (inclusive-low) band.
      expect(classifyRing(bounds[ring - 1] + 1e-6, g)).toBe(ring);
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
  it("maps all six rings to the locked note-family sequence, inner to outer", () => {
    expect(NOTES).toEqual(["E", "G", "A", "B", "D", "E"]);
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

describe("octaveForRegister and resolvedNoteName", () => {
  it("maps register -1/0/+1 to one octave below/at/above BASE_OCTAVE", () => {
    expect(octaveForRegister(-1)).toBe(BASE_OCTAVE - 1);
    expect(octaveForRegister(0)).toBe(BASE_OCTAVE);
    expect(octaveForRegister(1)).toBe(BASE_OCTAVE + 1);
  });

  it("combines a note family and register into the exact displayed/played note name", () => {
    expect(resolvedNoteName("E", 0)).toBe("E3");
    expect(resolvedNoteName("E", 1)).toBe("E4");
    expect(resolvedNoteName("E", -1)).toBe("E2");
    expect(resolvedNoteName("G", -1)).toBe("G2");
    expect(resolvedNoteName("A", 1)).toBe("A4");
    expect(resolvedNoteName("B", 0)).toBe("B3");
    expect(resolvedNoteName("D", -1)).toBe("D2");
  });
});

describe("normalizedVerticalPosition", () => {
  it("maps the top and bottom of a desktop viewport to 0 and 1", () => {
    expect(normalizedVerticalPosition(0, 1080)).toBeCloseTo(0);
    expect(normalizedVerticalPosition(1080, 1080)).toBeCloseTo(1);
    expect(normalizedVerticalPosition(540, 1080)).toBeCloseTo(0.5);
  });

  it("maps the top and bottom of a phone viewport to 0 and 1 the same way", () => {
    expect(normalizedVerticalPosition(0, 844)).toBeCloseTo(0);
    expect(normalizedVerticalPosition(844, 844)).toBeCloseTo(1);
    expect(normalizedVerticalPosition(422, 844)).toBeCloseTo(0.5);
  });

  it("clamps out-of-range y to [0, 1]", () => {
    expect(normalizedVerticalPosition(-50, 1080)).toBe(0);
    expect(normalizedVerticalPosition(2000, 1080)).toBe(1);
  });
});

describe("classifyRegister: top/middle/bottom thirds, screen top = higher pitch", () => {
  it("resolves the top third of the screen to the +1 (higher pitch) register", () => {
    expect(classifyRegister(0)).toBe(1);
    expect(classifyRegister(0.3)).toBe(1);
  });

  it("resolves the middle third to the base (0) register", () => {
    expect(classifyRegister(0.34)).toBe(0);
    expect(classifyRegister(0.5)).toBe(0);
    expect(classifyRegister(0.66)).toBe(0);
  });

  it("resolves the bottom third of the screen to the -1 (lower pitch) register", () => {
    expect(classifyRegister(0.7)).toBe(-1);
    expect(classifyRegister(0.999)).toBe(-1);
  });
});

describe("resolveRegister: hysteresis against a previous register", () => {
  it("behaves exactly like classifyRegister when there is no previous register", () => {
    expect(resolveRegister(0.1, null)).toBe(classifyRegister(0.1));
    expect(resolveRegister(0.8, null)).toBe(classifyRegister(0.8));
  });

  it("does not flip when a raw third-boundary is crossed by less than the margin", () => {
    const boundary = 1 / 3; // between the top (+1) and middle (0) thirds
    const margin = (1 / 3) * REGISTER_HYSTERESIS_RATIO;
    const justPast = boundary + margin / 2;
    expect(classifyRegister(justPast)).toBe(0); // raw classification already flips
    expect(resolveRegister(justPast, 1)).toBe(1); // hysteresis keeps the previous register
  });

  it("does flip once the pointer moves past a third-boundary by more than the margin", () => {
    const boundary = 1 / 3;
    const margin = (1 / 3) * REGISTER_HYSTERESIS_RATIO;
    const wellPast = boundary + margin + 0.01;
    expect(resolveRegister(wellPast, 1)).toBe(0);
  });

  it("does not flip back and forth while oscillating near a boundary", () => {
    const boundary = 2 / 3; // between the middle (0) and bottom (-1) thirds
    let register: Register | null = classifyRegister(boundary - 0.02);
    expect(register).toBe(0);
    for (const y of [boundary + 0.005, boundary - 0.005, boundary + 0.005, boundary - 0.005]) {
      register = resolveRegister(y, register);
      expect(register).toBe(0);
    }
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
