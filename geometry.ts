// Pure, side-effect-free geometry for Guitar Orbit: the instrument centre,
// its six equal-width playable rings, ring<->note-family mapping, vertical
// position<->register mapping, pointer angle, and boundary hysteresis (both
// radial and vertical). No DOM, no Web Audio --- main.ts is the only place
// that touches those. Hysteresis is expressed as a pure function of
// (position, previous classification) -> next classification: the caller
// owns the "previous" state, this module has none of its own.

export const RING_COUNT = 6;

// The playable radius, as a fraction of the viewport's half-diagonal (the
// centre-to-corner distance) rather than its smaller dimension --- never a
// fixed pixel value, so it scales from phone to desktop alike. A circle of
// radius == half-diagonal already touches every corner of the viewport, so
// it fully covers the rectangle (every point in the rectangle is closer to
// the centre than that); the margin above 1.0 keeps points right at a corner
// safely inside a ring instead of sitting exactly on the excluded outer
// boundary. This intentionally bulges past the visible viewport along the
// middle of each edge --- the goal is covering ordinary pointer positions
// across the screen, not fitting the logical circle inside the rectangle.
export const OUTER_RADIUS_RATIO = 1.05;

// The non-playable central guitar footprint, as a fraction of the playable
// (outer) radius.
export const INNER_RADIUS_RATIO = 0.2;

// How far past a ring boundary the pointer must move, as a fraction of a
// single ring's width, before the active ring actually changes. Expressed as
// a ratio of ring width (not a fixed pixel margin) so it scales with the
// geometry too.
export const HYSTERESIS_RATIO = 0.15;

// Ring 1 (innermost, nearest the guitar) to ring 6 (outermost). A ring names
// a note *family* only --- which letter --- not a fixed octave any more: the
// octave comes from the pointer's vertical position (see classifyRegister/
// resolveRegister below), so the two rings that share a letter (1 and 6,
// both "E") are genuinely identical in pitch options, not just in name.
export const NOTES = ["E", "G", "A", "B", "D", "E"] as const;
export type NoteFamily = (typeof NOTES)[number];

// The register a note family is played in, relative to its own base
// (middle-third) octave: -1 is one octave down, 0 is the base octave, +1 is
// one octave up. BASE_OCTAVE is the scientific-pitch octave number the base
// register maps to for every family (E3, G3, A3, B3, D3), chosen --- after
// checking audio.ts's Karplus-Strong-viable frequency range --- so the full
// three-register spread for every family (down to D2 at 73.42 Hz, up to E4/
// G4/A4/B4 around 330-494 Hz) stays comfortably inside it.
export type Register = -1 | 0 | 1;
export const BASE_OCTAVE = 3;

export function octaveForRegister(register: Register): number {
  return BASE_OCTAVE + register;
}

// Combines a ring's note family with a resolved register into the exact
// note name (e.g. "E3", "B4") that audio.ts's noteFrequency looks up and
// main.ts displays --- the single source of truth for "which note is this",
// so the two can never drift apart.
export function resolvedNoteName(family: NoteFamily, register: Register): string {
  return `${family}${octaveForRegister(register)}`;
}

// How far past a register-zone boundary the pointer must move, as a
// fraction of one zone's height, before the active register actually
// changes --- the vertical counterpart of HYSTERESIS_RATIO above, same
// value, same reason: without it, a pointer held still near a third
// boundary would flicker the note back and forth on every tiny jitter.
export const REGISTER_HYSTERESIS_RATIO = HYSTERESIS_RATIO;

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
  const halfDiagonal = Math.hypot(viewportWidth, viewportHeight) / 2;
  const outerRadius = halfDiagonal * OUTER_RADIUS_RATIO;
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

export function noteForRing(ring: number | null): NoteFamily | null {
  if (ring === null || ring < 1 || ring > RING_COUNT) return null;
  return NOTES[ring - 1];
}

// Canvas-local y -> a normalized [0, 1] vertical position, 0 at the very top
// of the playable area and 1 at the very bottom --- clamped, so a pointer
// briefly outside the canvas (e.g. mid-drag) still resolves to a definite
// register instead of an out-of-range one. `viewportHeight` is the same
// quantity computeGeometry already takes (the canvas's own rendered height,
// not window.innerHeight), so this stays consistent across desktop and
// mobile exactly the way the radial geometry already does.
export function normalizedVerticalPosition(y: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0.5;
  return Math.min(1, Math.max(0, y / viewportHeight));
}

// Strict normalized-y -> register, no hysteresis: the top third is +1
// octave (screen top = higher pitch, per the required direction), the
// middle third is the base register, and the bottom third is -1 octave.
export function classifyRegister(normalizedY: number): Register {
  if (normalizedY < 1 / 3) return 1;
  if (normalizedY < 2 / 3) return 0;
  return -1;
}

// Normalized-y -> register, with hysteresis against the previously active
// register (or `null` if there wasn't one) --- the vertical mirror of
// resolveRing. Staying within the previous zone's band, widened by the
// hysteresis margin on both sides, keeps the previous register; moving past
// that widened band re-classifies from scratch.
export function resolveRegister(normalizedY: number, previousRegister: Register | null): Register {
  if (previousRegister === null) return classifyRegister(normalizedY);

  const margin = (1 / 3) * REGISTER_HYSTERESIS_RATIO;
  const zoneIndex = previousRegister === 1 ? 0 : previousRegister === 0 ? 1 : 2;
  const lo = zoneIndex / 3 - margin;
  const hi = (zoneIndex + 1) / 3 + margin;
  if (normalizedY >= lo && normalizedY < hi) return previousRegister;

  return classifyRegister(normalizedY);
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
