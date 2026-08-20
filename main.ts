// Tracks a single active pointer against the geometry module to select a
// ring/note (invisibly --- the six rings are a hit-testing model, not a
// drawn diagram) and drives the Web Audio voice in audio.ts from that same
// pointer/ring state. The real guitar image lives in index.html as an <img>,
// underneath this transparent canvas; this file only draws the temporary
// feedback layer on top of it: a fading pointer trail, a short note-trigger
// ripple, and the current note name while playing. The guitar image's own
// small CSS-transform "kick" is also driven from here (see
// triggerGuitarNoteChangeResponse), fired exactly when the resolved note
// changes --- never from the pointer merely touching or crossing the image.

import {
  angleFromCentre,
  classifyRing,
  computeGeometry,
  distanceFromCentre,
  normalizedAngle,
  normalizedVerticalPosition,
  noteForRing,
  resolveRegister,
  resolveRing,
  resolvedNoteName,
  type OrbitGeometry,
  type Register,
} from "./geometry.ts";
import {
  articulateNoteChange,
  releaseVoice,
  startVoice,
  updateVoiceFilterCutoff,
  voiceState,
} from "./audio.ts";

const canvas = document.querySelector<HTMLCanvasElement>(
  '[data-testid="orbit-canvas"]',
);
const guitarImg = document.querySelector<HTMLImageElement>(".orbit-guitar");

// The pointer currently owning the gesture, if any --- only one at a time
// (a second concurrent pointer is ignored outright). Ownership (this) and
// audio activation (voiceState()) are deliberately separate: a pointerdown
// anywhere in the stage arms this, even if its position doesn't resolve to
// a playable ring yet --- see handlePointerDown/handlePointerMove.
let activePointerId: number | null = null;
// The ring the active pointer currently resolves to (or has most recently
// resolved to this gesture), kept purely so handlePointerMove can pass it to
// resolveRing as the hysteresis anchor --- it is never drawn. Null both
// before the gesture has ever entered a ring, and while it's within the
// dead zone/guitar centre, are the two cases where no voice is playing yet
// and previousRing === null is how handlePointerMove tells "never started"
// apart from "ring changed".
let activeRing: number | null = null;
// The register (see geometry.ts's Register/resolveRegister) the active
// pointer's vertical position currently resolves to, kept purely so
// handlePointerMove can pass it to resolveRegister as the hysteresis
// anchor --- same role as activeRing, just for the vertical dimension. Set
// alongside activeRing whenever the pointer is inside a playable ring;
// left untouched while the pointer sits in the centre dead zone, mirroring
// how activeRing is preserved there too.
let activeRegister: Register | null = null;

// The single pointer whose movement drives the trail, independent of
// activePointerId so the trail also appears on hover before any press. A
// second concurrent pointer's movement is ignored, same policy as audio, so
// this never becomes a multi-touch visual.
let hoverPointerId: number | null = null;

interface TrailPoint {
  x: number;
  y: number;
  createdAt: number;
  speed: number; // canvas-heights/second since the previous trail point --- purely for rendering intensity, see draw()
}
const TRAIL_FADE_MS = 350;
// Reference speed (canvas-heights/second) at which the trail's glow/size
// visual boost is fully saturated --- a rendering-only tuning constant, not a
// gesture threshold like GUITAR_FAST_VELOCITY_THRESHOLD.
const TRAIL_SPEED_REFERENCE = 1.6;
let trail: TrailPoint[] = [];

// A short-lived visual pulse at the pointer position, drawn for a note
// trigger and then discarded. Each entry fades out over RIPPLE_DURATION_MS
// and is removed once expired, so ripples never accumulate.
interface Ripple {
  x: number;
  y: number;
  startedAt: number;
  maxRadius: number;
}
const RIPPLE_DURATION_MS = 220;
let ripples: Ripple[] = [];

// The note name shown near the pointer while playing. `releasedAt` is null
// while the note is actually sounding; once the interaction ends it's set to
// the release time and the label fades out over NOTE_LABEL_FADE_MS before
// being cleared, rather than vanishing instantly.
interface NoteLabel {
  note: string;
  x: number;
  y: number;
  releasedAt: number | null;
  createdAt: number; // when *this* note (not just the label object) started --- drives drawNoteLabel's entrance pop
}
const NOTE_LABEL_FADE_MS = 250;
let noteLabel: NoteLabel | null = null;

// A restrained damped-spring response applied to the rendered <img
// class="orbit-guitar"> itself (a CSS transform, not a canvas draw), fired as
// a one-shot impulse exactly when the resolved *note* changes --- never from
// the pointer touching or crossing the image (see
// triggerGuitarNoteChangeResponse, called only from handlePointerDown and
// handlePointerMove's ring-transition branches). Values are always driven
// back toward 0 by the spring in stepGuitarSpring below, so a perturbation
// always decays to the neutral centred pose rather than accumulating or
// oscillating forever.
//
// Three discrete intensity levels, chosen from the *measured* pointer
// velocity in the moment leading up to the note change (never from raw event
// count alone):
//   1 (normal) - an ordinary low/medium-speed transition: an obvious gentle
//                swing that settles smoothly.
//   2 (fast)   - the transition happened at high pointer velocity: bigger,
//                snappier, more overshoot, and --- because its spring is
//                stiffer (higher natural frequency) --- it actually settles
//                *sooner* than Level 1 despite moving further.
//   3 (rapid)  - recent genuine note-transition history (not raw pointermove
//                count) shows several changes in a short rolling window,
//                with at least one fast or reversing among them: the
//                strongest, highest-frequency response, plus a brief
//                scale/glow resonance pulse.
// Displacement is expressed as a fraction of the guitar <img>'s own rendered
// height (read fresh each time, not cached) rather than a fixed pixel
// figure, so the same note-change gesture reads the same way whether the
// guitar renders at phone or desktop size.
type GuitarLevel = 1 | 2 | 3;

interface GuitarLevelProfile {
  rotationPeakDeg: number; // target peak rotation for a typical transition at this level
  translatePeakRatio: number; // target peak displacement, as a fraction of the guitar's rendered height
  maxRotationDeg: number; // hard safety ceiling, above the ordinary peak
  maxTranslateRatio: number; // hard safety ceiling, as a fraction of the guitar's rendered height
  stiffness: number; // shared spring constant for both rotation and translate at this level
  damping: number;
  resonance: boolean; // Level 3 only: also triggers the scale/glow pulse
  glowColor: string; // "r, g, b" for this level's warm accent drop-shadow (see applyGuitarVisual)
  glowBlur: number; // baseline glow blur radius (px) the instant this level becomes active
  glowOpacity: number; // baseline glow alpha the instant this level becomes active
}

// stiffness/damping are chosen so that, for a light initial kick, peak
// amplitude ≈ kick / sqrt(stiffness) and the response decays to near-nothing
// in roughly 6 / damping seconds --- see triggerGuitarNoteChangeResponse for
// how the kick itself is derived from rotationPeakDeg/translatePeakRatio.
// glowBlur/glowOpacity are each level's *baseline* (i.e. even before the
// current displacement scales them further in applyGuitarVisual) --- Level
// 1's matches the idle ambient glow in styles.css exactly, so the very first
// instant of a response never visibly "pops" relative to the resting guitar.
const GUITAR_LEVEL_PROFILES: Record<GuitarLevel, GuitarLevelProfile> = {
  1: {
    rotationPeakDeg: 2.6, // target 2-3°
    translatePeakRatio: 0.01, // target ~1% of guitar height
    maxRotationDeg: 4,
    maxTranslateRatio: 0.016,
    stiffness: 196, // recovers in ~300ms (target 250-350ms)
    damping: 20,
    resonance: false,
    glowColor: "255, 205, 140",
    glowBlur: 26,
    glowOpacity: 0.16,
  },
  2: {
    rotationPeakDeg: 6, // target 5-7°
    translatePeakRatio: 0.02, // target ~2%
    maxRotationDeg: 9,
    maxTranslateRatio: 0.03,
    stiffness: 484, // higher frequency + lower damping ratio than Level 1 -> stronger overshoot
    damping: 26, // recovers in ~230ms (target 180-280ms), despite the bigger swing
    resonance: false,
    glowColor: "255, 176, 90",
    glowBlur: 34,
    glowOpacity: 0.26,
  },
  3: {
    rotationPeakDeg: 9, // target 8-10°
    translatePeakRatio: 0.035, // target 3-4%
    maxRotationDeg: 13,
    maxTranslateRatio: 0.05,
    stiffness: 900, // highest natural frequency -> visible high-frequency resonance
    damping: 16, // most underdamped of the three -> several visible cycles before settling
    resonance: true,
    glowColor: "255, 150, 70",
    glowBlur: 44,
    glowOpacity: 0.34,
  },
};

const GUITAR_FAST_VELOCITY_THRESHOLD = 2.4; // guitar-heights/second, measured since the previous pointer sample
const GUITAR_RAPID_WINDOW_MS = 600; // trailing window for detecting rapid continuous note switching
const GUITAR_RAPID_MIN_TRANSITIONS = 3; // note changes required within the window before Level 3 can trigger
const GUITAR_RESONANCE_PULSE_MS = 380; // Level 3's extra scale/glow accent duration (target 300-450ms)
const GUITAR_RESONANCE_SCALE_PEAK = 0.035; // target scale peak ~1.03-1.04

let guitarRotation = 0; // degrees
let guitarRotationVelocity = 0;
let guitarOffsetX = 0; // px
let guitarOffsetY = 0; // px
let guitarVelocityX = 0;
let guitarVelocityY = 0;
let currentGuitarLevel: GuitarLevel = 1;
let guitarResonancePulseUntil = 0; // performance.now() timestamp; <= now means inactive

// A record of one resolved-note change, kept only long enough to classify
// Level 3 (see classifyNoteChangeLevel) --- not for raw pointermove counting.
interface NoteTransitionRecord {
  at: number; // performance.now() timestamp
  velocity: number; // guitar-heights/second, at the moment of this transition
  dx: number; // pointer movement x since the previous sample, for direction/reversal
}
let recentNoteTransitions: NoteTransitionRecord[] = [];
// The pointer position/time the guitar-response logic last measured a
// movement from, so each note change's velocity is "since the previous
// sample" rather than "since the gesture started". Reset to null at the
// start and end of every gesture (see handlePointerDown/handlePointerEnd) so
// one gesture's velocity history never leaks into the next.
let lastPointerMoveSample: { x: number; y: number; t: number } | null = null;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Classifies a note-change transition's intensity level from its own
// velocity plus the rolling history of recent transitions --- the
// GUITAR_RAPID_* escalation to Level 3 needs "several genuine note changes
// in a short window, at least some of them fast or reversing direction", not
// just one isolated fast transition. `history` is mutated: the new
// transition is recorded (and the window pruned) as a side effect, since
// every call site immediately follows through with an actual impulse.
function classifyNoteChangeLevel(dx: number, velocity: number, now: number): GuitarLevel {
  recentNoteTransitions = recentNoteTransitions.filter((t) => now - t.at <= GUITAR_RAPID_WINDOW_MS);
  recentNoteTransitions.push({ at: now, velocity, dx });

  const level: GuitarLevel = velocity >= GUITAR_FAST_VELOCITY_THRESHOLD ? 2 : 1;
  if (recentNoteTransitions.length < GUITAR_RAPID_MIN_TRANSITIONS) return level;

  const hasFast = recentNoteTransitions.some((t) => t.velocity >= GUITAR_FAST_VELOCITY_THRESHOLD);
  const signs = recentNoteTransitions.map((t) => Math.sign(t.dx)).filter((s) => s !== 0);
  let hasReversal = false;
  for (let i = 1; i < signs.length; i++) {
    if (signs[i] !== signs[i - 1]) {
      hasReversal = true;
      break;
    }
  }
  return hasFast || hasReversal ? 3 : level;
}

// Fires a one-shot spring impulse for a single resolved-note change at
// canvas-local position (x, y). Direction comes from the pointer's actual
// movement since lastPointerMoveSample (falling back to a radial "outward
// from centre" nudge, classified as the gentlest level, when there isn't one
// yet --- e.g. a pointerdown landing straight in a ring with no prior
// movement: the spec's "small initial response"). This is the single place
// that decides the level and applies the kick; call sites just supply the
// position and current time.
function triggerGuitarNoteChangeResponse(x: number, y: number, geometry: OrbitGeometry, now: number): void {
  if (!guitarImg || prefersReducedMotion()) return;
  const guitarHeight = guitarImg.getBoundingClientRect().height;
  if (guitarHeight <= 0) return;

  let dx: number;
  let dy: number;
  let velocity: number;
  if (lastPointerMoveSample) {
    dx = x - lastPointerMoveSample.x;
    dy = y - lastPointerMoveSample.y;
    const dtSeconds = Math.max((now - lastPointerMoveSample.t) / 1000, 1 / 240);
    velocity = Math.hypot(dx, dy) / dtSeconds / guitarHeight;
  } else {
    dx = x - geometry.centerX;
    dy = y - geometry.centerY;
    velocity = 0;
  }

  const level = classifyNoteChangeLevel(dx, velocity, now);
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;

  const profile = GUITAR_LEVEL_PROFILES[level];
  const omega = Math.sqrt(profile.stiffness); // peak ≈ kick / omega, so kick = peak * omega
  guitarRotationVelocity += profile.rotationPeakDeg * omega * ux;
  guitarVelocityX += profile.translatePeakRatio * guitarHeight * omega * ux;
  guitarVelocityY += profile.translatePeakRatio * guitarHeight * omega * uy;
  currentGuitarLevel = level;
  if (profile.resonance) {
    guitarResonancePulseUntil = Math.max(guitarResonancePulseUntil, now + GUITAR_RESONANCE_PULSE_MS);
  }
  ensureAnimation();
}

// Advances the guitar's damped spring by `dt` seconds, using whichever
// level's profile is currently active. Returns whether it's still visibly
// moving --- once rotation/offset and their velocities all drop below a tiny
// threshold (and no Level-3 resonance pulse is still playing out), everything
// snaps to exactly 0, the active level resets to 1, and this returns false,
// so the shared animation loop can stop itself rather than running forever.
function stepGuitarSpring(dt: number, now: number): boolean {
  const profile = GUITAR_LEVEL_PROFILES[currentGuitarLevel];
  const guitarHeight = guitarImg?.getBoundingClientRect().height ?? 0;
  const maxTranslatePx = profile.maxTranslateRatio * guitarHeight;

  const rotAccel = -profile.stiffness * guitarRotation - profile.damping * guitarRotationVelocity;
  guitarRotationVelocity += rotAccel * dt;
  guitarRotation = clamp(guitarRotation + guitarRotationVelocity * dt, profile.maxRotationDeg);

  const accX = -profile.stiffness * guitarOffsetX - profile.damping * guitarVelocityX;
  guitarVelocityX += accX * dt;
  guitarOffsetX = clamp(guitarOffsetX + guitarVelocityX * dt, maxTranslatePx);

  const accY = -profile.stiffness * guitarOffsetY - profile.damping * guitarVelocityY;
  guitarVelocityY += accY * dt;
  guitarOffsetY = clamp(guitarOffsetY + guitarVelocityY * dt, maxTranslatePx);

  const resonanceActive = now < guitarResonancePulseUntil;
  const settled =
    !resonanceActive &&
    Math.abs(guitarRotation) < 0.01 &&
    Math.abs(guitarRotationVelocity) < 0.01 &&
    Math.abs(guitarOffsetX) < 0.05 &&
    Math.abs(guitarVelocityX) < 0.05 &&
    Math.abs(guitarOffsetY) < 0.05 &&
    Math.abs(guitarVelocityY) < 0.05;
  if (settled) {
    guitarRotation = 0;
    guitarRotationVelocity = 0;
    guitarOffsetX = 0;
    guitarVelocityX = 0;
    guitarOffsetY = 0;
    guitarVelocityY = 0;
    currentGuitarLevel = 1;
  }
  return !settled;
}

// Renders the spring's current rotation/offset as a CSS transform on the
// guitar <img>, plus a warm drop-shadow glow whose blur/opacity scale with
// both the *current level* (1/2/3 --- see GUITAR_LEVEL_PROFILES' glowBlur/
// glowOpacity baselines) and how far the spring is currently displaced from
// centre relative to that level's own max (`intensity`, 0..1) --- so Level 1
// stays a subtle lift, Level 2 reads noticeably brighter, and Level 3 is the
// strongest, further flickering during its short resonance-pulse window.
// Everything here is derived from state stepGuitarSpring already computes;
// no new physics, triggers, or thresholds are introduced.
function applyGuitarVisual(now: number): void {
  if (!guitarImg) return;
  const resonanceRemaining = guitarResonancePulseUntil - now;

  if (guitarRotation === 0 && guitarOffsetX === 0 && guitarOffsetY === 0 && resonanceRemaining <= 0) {
    // Idle: hand back to the plain centring transform and ambient glow
    // defined in styles.css instead of leaving permanent (even if zeroed)
    // inline styles behind.
    guitarImg.style.removeProperty("transform");
    guitarImg.style.removeProperty("filter");
    return;
  }

  const profile = GUITAR_LEVEL_PROFILES[currentGuitarLevel];
  const guitarHeight = guitarImg.getBoundingClientRect().height || 1;
  const maxTranslatePx = profile.maxTranslateRatio * guitarHeight || 1;
  const intensity = clamp01(
    Math.max(Math.abs(guitarRotation) / profile.maxRotationDeg, Math.hypot(guitarOffsetX, guitarOffsetY) / maxTranslatePx),
  );

  let scale = 1;
  let flicker = 1;
  if (resonanceRemaining > 0) {
    const t = resonanceRemaining / GUITAR_RESONANCE_PULSE_MS; // 1 -> 0
    scale = 1 + GUITAR_RESONANCE_SCALE_PEAK * t * Math.sin(now / 35);
    flicker = 1 + 0.25 * t * Math.sin(now / 35);
  }

  const blur = Math.min(140, profile.glowBlur * (1 + intensity * 1.6) * flicker);
  const glowOpacity = Math.min(0.92, profile.glowOpacity * (1 + intensity * 1.3) * flicker);

  guitarImg.style.transform =
    `translate(-50%, -50%) translate(${guitarOffsetX.toFixed(2)}px, ${guitarOffsetY.toFixed(2)}px) ` +
    `rotate(${guitarRotation.toFixed(3)}deg) scale(${scale.toFixed(4)})`;
  guitarImg.style.filter =
    `drop-shadow(0 22px 34px rgba(0, 0, 0, 0.55)) ` +
    `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(${profile.glowColor}, ${glowOpacity.toFixed(2)}))`;
}

// requestAnimationFrame handle shared by the trail, the ripples, the
// note-label fade, and the guitar spring, or null when idle. This loop only
// runs while at least one of those actually has something to animate --- it
// is not a continuous decorative animation, and stops itself the moment
// everything is empty/settled again.
let animationFrameHandle: number | null = null;
// Wall-clock time of the previous animation step, used to derive the guitar
// spring's dt. Reset to null whenever the loop stops, so the first step of a
// fresh run always uses a safe default instead of a stale (possibly huge, if
// the tab was backgrounded) gap.
let lastAnimationStepAt: number | null = null;

function ensureAnimation(): void {
  if (animationFrameHandle !== null) return;
  const step = () => {
    const now = performance.now();
    const dt = lastAnimationStepAt === null ? 1 / 60 : Math.min(0.05, (now - lastAnimationStepAt) / 1000);
    lastAnimationStepAt = now;

    ripples = ripples.filter((ripple) => now - ripple.startedAt < RIPPLE_DURATION_MS);
    trail = trail.filter((point) => now - point.createdAt < TRAIL_FADE_MS);
    if (noteLabel && noteLabel.releasedAt !== null && now - noteLabel.releasedAt >= NOTE_LABEL_FADE_MS) {
      noteLabel = null;
    }
    const guitarStillAnimating = stepGuitarSpring(dt, now);
    applyGuitarVisual(now);
    draw();

    const stillAnimating =
      ripples.length > 0 ||
      trail.length > 0 ||
      (noteLabel !== null && noteLabel.releasedAt !== null) ||
      guitarStillAnimating;
    if (stillAnimating) {
      animationFrameHandle = requestAnimationFrame(step);
    } else {
      animationFrameHandle = null;
      lastAnimationStepAt = null;
    }
  };
  animationFrameHandle = requestAnimationFrame(step);
}

function triggerRipple(x: number, y: number, geometry: OrbitGeometry): void {
  ripples.push({ x, y, startedAt: performance.now(), maxRadius: geometry.ringWidth * 1.4 });
  ensureAnimation();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

const NOTE_LABEL_ENTRANCE_MS = 180; // brief pop-in when a *new* note appears --- independent of the fade-out timing
const NOTE_LABEL_EDGE_MARGIN = 12; // keeps the label's pill fully inside the canvas near any edge, incl. on mobile

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function drawNoteLabel(
  ctx: CanvasRenderingContext2D,
  label: NoteLabel,
  alpha: number,
  geometry: OrbitGeometry,
  width: number,
  height: number,
): void {
  const now = performance.now();
  const fontSize = Math.min(34, Math.max(20, geometry.ringWidth * 0.62));
  const offsetAbove = Math.max(28, geometry.ringWidth * 0.75);

  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const paddingX = fontSize * 0.65;
  const paddingY = fontSize * 0.4;
  const boxWidth = ctx.measureText(label.note).width + paddingX * 2;
  const boxHeight = fontSize + paddingY * 2;

  const boxCenterX = clampRange(
    label.x,
    boxWidth / 2 + NOTE_LABEL_EDGE_MARGIN,
    width - boxWidth / 2 - NOTE_LABEL_EDGE_MARGIN,
  );
  let boxCenterY = label.y - offsetAbove;
  if (boxCenterY - boxHeight / 2 < NOTE_LABEL_EDGE_MARGIN) {
    boxCenterY = label.y + offsetAbove; // too close to the top edge --- flip below the pointer instead
  }
  boxCenterY = clampRange(boxCenterY, boxHeight / 2 + NOTE_LABEL_EDGE_MARGIN, height - boxHeight / 2 - NOTE_LABEL_EDGE_MARGIN);

  // A brief pop-in scale on a genuinely new note (label.createdAt reset only
  // when the resolved note changes --- see the noteLabel assignment sites in
  // handlePointerDown/handlePointerMove), never on same-note pointer drag.
  const entranceT = prefersReducedMotion() ? 0 : Math.max(0, 1 - (now - label.createdAt) / NOTE_LABEL_ENTRANCE_MS);
  const scale = 1 + entranceT * entranceT * 0.32;

  ctx.save();
  ctx.translate(boxCenterX, boxCenterY);
  ctx.scale(scale, scale);

  ctx.shadowBlur = 18;
  ctx.shadowColor = `rgba(94, 224, 255, ${alpha * 0.35})`;
  ctx.fillStyle = `rgba(8, 11, 20, ${alpha * 0.78})`;
  drawRoundedRect(ctx, -boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight, boxHeight / 2);
  ctx.fill();

  ctx.shadowBlur = 14;
  ctx.shadowColor = `rgba(148, 233, 255, ${alpha * 0.65})`;
  ctx.fillStyle = `rgba(233, 250, 255, ${alpha})`;
  ctx.fillText(label.note, 0, 0);
  ctx.restore();
}

function draw(): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // The guitar itself is the <img class="orbit-guitar"> underneath this
  // canvas (see index.html) --- nothing is drawn for it here. The six rings
  // stay purely a hit-testing model (see geometry.ts): no permanent circles
  // are drawn for them either. Everything below is temporary feedback only.
  const geometry = computeGeometry(width, height);
  const now = performance.now();

  for (const point of trail) {
    const age = now - point.createdAt;
    if (age >= TRAIL_FADE_MS) continue;
    const progress = age / TRAIL_FADE_MS;
    const speedBoost = clamp01(point.speed / TRAIL_SPEED_REFERENCE);
    const radius = Math.max(2, geometry.ringWidth * 0.14) * (0.85 + speedBoost * 0.5) * (1 - progress * 0.35);
    const alpha = (1 - progress) * (0.28 + speedBoost * 0.22);
    ctx.save();
    ctx.shadowBlur = 10 + speedBoost * 14;
    ctx.shadowColor = `rgba(94, 224, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(150, 214, 255, ${alpha})`;
    ctx.fill();
    ctx.restore();
  }

  for (const ripple of ripples) {
    const progress = (now - ripple.startedAt) / RIPPLE_DURATION_MS;
    if (progress >= 1) continue;
    ctx.save();
    ctx.shadowBlur = 16 * (1 - progress);
    ctx.shadowColor = `rgba(120, 210, 255, ${(1 - progress) * 0.5})`;
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, progress * ripple.maxRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(148, 220, 255, ${(1 - progress) * 0.6})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  if (noteLabel) {
    const alpha =
      noteLabel.releasedAt === null ? 1 : Math.max(0, 1 - (now - noteLabel.releasedAt) / NOTE_LABEL_FADE_MS);
    if (alpha > 0) drawNoteLabel(ctx, noteLabel, alpha, geometry, width, height);
  }
}

function pointerLocalPosition(event: PointerEvent): { x: number; y: number } {
  const rect = canvas!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// Adds a trail point for whichever single pointer is currently being
// tracked for hover, regardless of whether it's also the active (playing)
// pointer. Runs independently of handlePointerMove below.
function handleTrailMove(event: PointerEvent): void {
  if (!canvas) return;
  if (hoverPointerId === null) hoverPointerId = event.pointerId;
  if (event.pointerId !== hoverPointerId) return; // ignore a second concurrent pointer's trail too

  const { x, y } = pointerLocalPosition(event);
  const now = performance.now();
  const last = trail[trail.length - 1];
  let speed = 0;
  if (last) {
    const rect = canvas.getBoundingClientRect();
    const dtSeconds = Math.max((now - last.createdAt) / 1000, 1 / 240);
    speed = Math.hypot(x - last.x, y - last.y) / dtSeconds / Math.max(rect.height, 1);
  }
  trail.push({ x, y, createdAt: now, speed });
  ensureAnimation();
}

function clearHoverPointer(event: PointerEvent): void {
  if (event.pointerId === hoverPointerId) {
    hoverPointerId = null;
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (!canvas || activePointerId !== null) return; // ignore a second concurrent pointer
  if (voiceState() !== "idle") return; // previous voice is still releasing --- ignore this press entirely

  // A fresh gesture starts with clean velocity/rapid-switch history --- see
  // triggerGuitarNoteChangeResponse and classifyNoteChangeLevel --- so it
  // never inherits a previous gesture's history.
  lastPointerMoveSample = null;
  recentNoteTransitions = [];

  const { x, y } = pointerLocalPosition(event);
  const rect = canvas.getBoundingClientRect();
  const geometry = computeGeometry(rect.width, rect.height);
  const radius = distanceFromCentre(x, y, geometry);
  const ring = classifyRing(radius, geometry);
  const register = resolveRegister(normalizedVerticalPosition(y, rect.height), null);

  // Adopt this pointer as the gesture owner even when it starts outside any
  // playable ring (most commonly: on the guitar itself). Ownership and audio
  // are separate: an armed gesture with no ring yet produces no sound and no
  // note label until (if ever) it first drags into a valid ring --- see
  // handlePointerMove's `previousRing === null` branch, which is what starts
  // the voice then.
  activePointerId = event.pointerId;
  activeRing = ring;
  activeRegister = register;

  const family = noteForRing(ring);
  const angle = normalizedAngle(angleFromCentre(x, y, geometry));
  if (family) {
    const note = resolvedNoteName(family, register);
    const now = performance.now();
    startVoice(note, angle);
    noteLabel = { note, x, y, releasedAt: null, createdAt: now };
    triggerRipple(x, y, geometry); // a note just started
    triggerGuitarNoteChangeResponse(x, y, geometry, now); // resolved note went from none -> this one
    lastPointerMoveSample = { x, y, t: now };
  }

  draw();
}

function handlePointerMove(event: PointerEvent): void {
  if (!canvas || event.pointerId !== activePointerId) return; // hover, or not the active pointer

  const { x, y } = pointerLocalPosition(event);
  const rect = canvas.getBoundingClientRect();
  const geometry = computeGeometry(rect.width, rect.height);
  const radius = distanceFromCentre(x, y, geometry);
  const previousRing = activeRing;
  const previousRegister = activeRegister;
  const ring = resolveRing(radius, previousRing, geometry);
  const now = performance.now();

  if (ring === null) {
    if (radius < geometry.innerRadius) {
      // The drag moved into the central guitar footprint. This is now a
      // hold zone, not a gesture-ending one: keep the voice, the last valid
      // ring and register (so resolveRing/resolveRegister's hysteresis
      // anchors are unchanged), and the note label all exactly as they
      // were --- only the label position follows the pointer. No new note
      // is invented while inside, so no guitar response fires here either
      // --- that only ever happens on an actual resolved-note change (see
      // triggerGuitarNoteChangeResponse).
      if (noteLabel) {
        noteLabel = { ...noteLabel, x, y };
      }
      lastPointerMoveSample = { x, y, t: now };
      draw();
      return;
    }

    // Otherwise the drag moved past the outer edge, which still ends the
    // play interaction outright, the same as lifting the pointer: release
    // the voice, and clear ownership so this same physical pointer cannot
    // resume playing just by dragging back into a ring --- only a fresh
    // pointerdown may start a new voice. No muted-but-alive voice, no voice
    // stealing: exactly one voice can ever exist. The note label starts
    // fading for the same reason.
    activePointerId = null;
    activeRing = null;
    activeRegister = null;
    lastPointerMoveSample = null;
    if (noteLabel) {
      noteLabel = { ...noteLabel, releasedAt: now };
      ensureAnimation();
    }
    releaseVoice();
    draw();
    return;
  }

  activeRing = ring;
  const register = resolveRegister(normalizedVerticalPosition(y, rect.height), previousRegister);
  activeRegister = register;

  const family = noteForRing(ring);
  if (family) {
    const note = resolvedNoteName(family, register);
    const angle = normalizedAngle(angleFromCentre(x, y, geometry));
    if (previousRing === null) {
      // This armed gesture's first entry into any playable ring --- no voice
      // exists yet, so start one rather than trying to retune a voice that
      // was never created.
      startVoice(note, angle);
      noteLabel = { note, x, y, releasedAt: null, createdAt: now };
      triggerRipple(x, y, geometry);
      triggerGuitarNoteChangeResponse(x, y, geometry, now);
    } else {
      // previousRing !== null implies a voice already exists, and (see
      // activeRegister's own comment) previousRegister was set alongside
      // it --- so it's always a real register here, and the previous
      // resolved note is always defined. The musical-transition event is
      // the *resolved* note (ring + register combined) changing, not the
      // ring index alone: a pure register change (moving vertically within
      // the same ring) must retrigger exactly like a ring change does, and
      // moving within the same quantised ring+register must not retrigger
      // at all.
      const previousNote = resolvedNoteName(noteForRing(previousRing)!, previousRegister!);
      if (note !== previousNote) {
        articulateNoteChange(note, angle);
        noteLabel = { note, x, y, releasedAt: null, createdAt: now }; // the note changed --- refresh the label and pulse
        triggerRipple(x, y, geometry);
        triggerGuitarNoteChangeResponse(x, y, geometry, now);
      } else if (noteLabel) {
        noteLabel = { ...noteLabel, x, y }; // same note --- just follow the pointer
      }
    }
    updateVoiceFilterCutoff(angle);
  }

  lastPointerMoveSample = { x, y, t: now };
  draw();
}

function handlePointerEnd(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  activePointerId = null;
  activeRing = null;
  activeRegister = null;
  lastPointerMoveSample = null;
  if (noteLabel) {
    noteLabel = { ...noteLabel, releasedAt: performance.now() };
    ensureAnimation();
  }
  releaseVoice();
  draw();
}

draw();
window.addEventListener("resize", draw);

if (canvas) {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handleTrailMove);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerEnd);
  canvas.addEventListener("pointerup", clearHoverPointer);
  canvas.addEventListener("pointercancel", handlePointerEnd);
  canvas.addEventListener("pointercancel", clearHoverPointer);
  canvas.addEventListener("pointerleave", clearHoverPointer);
}
