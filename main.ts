// Draws the central guitar and six concentric rings, and (new in this
// stage) tracks a single active pointer against the geometry module to
// highlight whichever ring it's currently over. No audio yet, no filter
// mapping, no ripple/connector polish --- those land in later stages.

import { RING_COUNT, classifyRing, computeGeometry, distanceFromCentre, resolveRing } from "./geometry.ts";

const canvas = document.querySelector<HTMLCanvasElement>(
  '[data-testid="orbit-canvas"]',
);

// The pointer currently driving the instrument, if any --- only one at a
// time (a second concurrent pointer is ignored outright), and only a
// pointer whose `pointerdown` landed inside a playable ring counts as one.
let activePointerId: number | null = null;
let activeRing: number | null = null;

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

  const geometry = computeGeometry(width, height);
  const { centerX, centerY, innerRadius, outerRadius, ringWidth } = geometry;

  // Central guitar --- a simple, non-playable silhouette.
  ctx.fillStyle = "#8a5a2b";
  ctx.beginPath();
  ctx.ellipse(
    centerX,
    centerY,
    innerRadius,
    innerRadius * 0.8,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillRect(
    centerX - innerRadius * 0.12,
    centerY - innerRadius * 2.2,
    innerRadius * 0.24,
    innerRadius * 2,
  );

  // Six concentric playable rings, inner (lower notes) to outer (higher notes).
  for (let ring = 1; ring <= RING_COUNT; ring++) {
    const radius = innerRadius + ringWidth * ring;
    const isActive = ring === activeRing;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.strokeStyle = isActive ? "#0b5fff" : "#3a3a3a";
    ctx.lineWidth = isActive ? 4 : 1.5;
    ctx.stroke();
  }
}

function pointerLocalPosition(event: PointerEvent): { x: number; y: number } {
  const rect = canvas!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function setActiveRing(ring: number | null): void {
  if (ring === activeRing) return;
  activeRing = ring;
  draw();
}

function handlePointerDown(event: PointerEvent): void {
  if (!canvas || activePointerId !== null) return; // ignore a second concurrent pointer

  const { x, y } = pointerLocalPosition(event);
  const rect = canvas.getBoundingClientRect();
  const geometry = computeGeometry(rect.width, rect.height);
  const radius = distanceFromCentre(x, y, geometry);
  const ring = classifyRing(radius, geometry);

  // Pressing the central guitar area or outside the outer ring does
  // nothing --- this pointer is never adopted as the active one, so its
  // later move/up events are ignored too.
  if (ring === null) return;

  activePointerId = event.pointerId;
  setActiveRing(ring);
}

function handlePointerMove(event: PointerEvent): void {
  if (!canvas || event.pointerId !== activePointerId) return; // hover, or not the active pointer

  const { x, y } = pointerLocalPosition(event);
  const rect = canvas.getBoundingClientRect();
  const geometry = computeGeometry(rect.width, rect.height);
  const radius = distanceFromCentre(x, y, geometry);
  const ring = resolveRing(radius, activeRing, geometry);
  setActiveRing(ring);
}

function handlePointerEnd(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return;
  activePointerId = null;
  setActiveRing(null);
}

draw();
window.addEventListener("resize", draw);

if (canvas) {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerEnd);
  canvas.addEventListener("pointercancel", handlePointerEnd);
}
