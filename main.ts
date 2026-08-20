// Static scaffold: draws the central guitar and six concentric rings once,
// resized from the viewport's smaller dimension. No pointer handling, no
// audio, and no ring highlighting yet --- those land in later stages.

const RING_COUNT = 6;

const canvas = document.querySelector<HTMLCanvasElement>(
  '[data-testid="orbit-canvas"]',
);

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

  const centerX = width / 2;
  const centerY = height / 2;
  const outerRadius = Math.min(width, height) * 0.45;
  const innerRadius = outerRadius * 0.2;

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
  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1.5;
  for (let ring = 1; ring <= RING_COUNT; ring++) {
    const radius =
      innerRadius + ((outerRadius - innerRadius) * ring) / RING_COUNT;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

draw();
window.addEventListener("resize", draw);
