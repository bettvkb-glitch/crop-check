// SAM 3.1 via Meta Model API returns special-token text: a box and an encoded mask per match.
// Meta documents the wire grammar at dev.meta.ai/docs/sam/reading-segmentation and ships a
// parser (`meta-sam-parser`, Python/native). There is no JS parser here yet.
//
// First build: return [] so the UI shows the photo with no overlay.
// Next step: port the grammar (or add a small /api/parse route) and return
//   [{ box: [x1, y1, x2, y2], polygon: [[x, y], ...] }]  in source-image pixels.
export function parseSam(/* raw */) {
  return [];
}

export function drawOverlay(ctx, matches, scale = 1) {
  ctx.lineWidth = Math.max(3, 3 * scale);
  ctx.strokeStyle = "#e8705f";
  ctx.fillStyle = "rgba(232,112,95,0.25)";
  for (const m of matches) {
    if (m.polygon?.length) {
      ctx.beginPath();
      m.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (m.box) {
      const [x1, y1, x2, y2] = m.box;
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    }
  }
}
