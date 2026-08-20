// Pure, side-effect-free geometry for Guitar Orbit: the instrument centre,
// its six equal-width playable rings, ring<->note mapping, pointer angle,
// and ring-boundary hysteresis. No DOM, no Web Audio --- main.ts is the only
// place that touches those. Hysteresis is expressed as a pure function of
// (radius, previous ring) -> next ring: the caller owns the "previous ring"
// state, this module has none of its own.

export const RING_COUNT = 6;

// The playable radius, as a fraction of the viewport's smaller dimension ---
// never a fixed pixel value, so it scales from phone to desktop alike.
export const OUTER_RADIUS_RATIO = 0.45;

// The non-playable central guitar footprint, as a fraction of the playable
// (outer) radius.
export const INNER_RADIUS_RATIO = 0.2;

// How far past a ring boundary the pointer must move, as a fraction of a
// single ring's width, before the active ring actually changes. Expressed as
// a ratio of ring width (not a fixed pixel margin) so it scales with the
// geometry too.
export const HYSTERESIS_RATIO = 0.15;

// Ring 1 (innermost, nearest the guitar) to ring 6 (outermost).
export const NOTES = ["E3", "G3", "A3", "B3", "D4", "E4"] as const;

export interface OrbitGeometry {
  centerX: number;
  centerY: number;
  innerRadius: number;
  outerRadius: number;
  ringWidth: number;
}

export function computeGeometry(
  viewportWidth: number,
  viewportHeight: number,
): OrbitGeometry {
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  const outerRadius = Math.min(viewportWidth, viewportHeight) * OUTER_RADIUS_RATIO;
  const innerRadius = outerRadius * INNER_RADIUS_RATIO;
  const ringWidth = (outerRadius - innerRadius) / RING_COUNT;
  return { centerX, centerY, innerRadius, outerRadius, ringWidth };
}

export function distanceFromCentre(
  x: number,
  y: number,
  geometry: OrbitGeometry,
): number {
  return Math.hypot(x - geometry.centerX, y - geometry.centerY);
}

// The ring boundaries as radii, low to high: boundaries[0] is the inner
// (guitar) radius, boundaries[RING_COUNT] is the outer playable radius. Ring
// `i` (1-indexed) spans [boundaries[i - 1], boundaries[i]).
export function ringBoundaries(geometry: OrbitGeometry): number[] {
  const { innerRadius, outerRadius, ringWidth } = geometry;
  // The last boundary is pinned to outerRadius itself rather than
  // innerRadius + RING_COUNT * ringWidth: that product doesn't always
  // round-trip back to outerRadius exactly in floating point, and
  // classifyRing compares against outerRadius directly.
  return Array.from({ length: RING_COUNT + 1 }, (_, i) =>
    i === RING_COUNT ? outerRadius : innerRadius + i * ringWidth,
  );
}

// Strict radius -> ring index, no hysteresis: null for the central
// non-playable guitar area and for anything beyond the outer playable
// radius.
export function classifyRing(
  radius: number,
  geometry: OrbitGeometry,
): number | null {
  const { innerRadius, outerRadius, ringWidth } = geometry;
  if (radius < innerRadius || radius >= outerRadius) return null;
  const ring = Math.floor((radius - innerRadius) / ringWidth) + 1;
  return Math.min(Math.max(ring, 1), RING_COUNT);
}

// Radius -> ring index, with hysteresis against the previously active ring
// (or `null` if there wasn't one). Staying within the previous ring's band,
// widened by the hysteresis margin on both sides, keeps the previous ring;
// moving past that widened band re-classifies from scratch, so a fast drag
// can still jump straight to the right ring instead of stepping through
// every one in between.
export function resolveRing(
  radius: number,
  previousRing: number | null,
  geometry: OrbitGeometry,
): number | null {
  if (previousRing === null) return classifyRing(radius, geometry);

  const { innerRadius, ringWidth } = geometry;
  const margin = ringWidth * HYSTERESIS_RATIO;
  const lo = innerRadius + (previousRing - 1) * ringWidth - margin;
  const hi = innerRadius + previousRing * ringWidth + margin;
  if (radius >= lo && radius < hi) return previousRing;

  return classifyRing(radius, geometry);
}

export function noteForRing(ring: number | null): (typeof NOTES)[number] | null {
  if (ring === null || ring < 1 || ring > RING_COUNT) return null;
  return NOTES[ring - 1];
}

// Pointer angle relative to the centre, in radians, normalized to [0, 2*PI).
// Screen coordinates (y grows downward), so 0 is due right and the angle
// increases clockwise.
export function angleFromCentre(
  x: number,
  y: number,
  geometry: OrbitGeometry,
): number {
  const angle = Math.atan2(y - geometry.centerY, x - geometry.centerX);
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

// Angle (radians, [0, 2*PI)) -> a normalized [0, 1) value. This is the
// number a future low-pass filter's cutoff would be derived from; no
// BiquadFilterNode lives here or is created by this module.
export function normalizedAngle(angleRad: number): number {
  return angleRad / (Math.PI * 2);
}
