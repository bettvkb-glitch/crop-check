// SAM 3.1 (Meta Model API) returns special-token text, one line per frame, e.g.
//   <0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>,1<|box;...|><|mask;...|>
// Grammar: https://dev.meta.ai/docs/sam/reading-segmentation
//
// This parser reads the boxes (plain integers, fully documented) and keeps each mask's
// size and encoding. Mask payloads are base85-encoded; decoding them to pixels is left to
// Meta's @meta-sam/parser (see README "Known gaps"), so the overlay draws boxes for now.

const RECORD = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;([^|]*)\|>)?/g;

function fields(s) {
  const out = {};
  for (const part of (s || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/**
 * Parse raw SAM output into matches for frame 0 (a still image).
 * Returns [{ id, box: [x1, y1, x2, y2], w, h, confidence?, mask?: { rows, cols, encoding } }]
 * in source-image pixels. Never throws: bad input returns [].
 */
export function parseSam(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const matches = [];
  for (const line of raw.split(/\r?\n/)) {
    const fm = /^<(\d+)f>/.exec(line.trim());
    if (!fm) continue;
    const body = line.trim().slice(fm[0].length);
    RECORD.lastIndex = 0;
    let m;
    while ((m = RECORD.exec(body))) {
      const b = fields(m[2]);
      const [x1, y1, x2, y2, w, h] = ["x1", "y1", "x2", "y2", "w", "h"].map((k) => Number(b[k]));
      if ([x1, y1, x2, y2, w, h].some((n) => !Number.isFinite(n)) || !w || !h) continue;
      const match = { id: m[1], frame: Number(fm[1]), box: [x1, y1, x2, y2], w, h };
      if (b.c !== undefined) match.confidence = Number(b.c);
      if (m[3]) {
        const d = /data=(\d+),(\d+),(.)/.exec(m[3]);
        if (d) match.mask = { rows: Number(d[1]), cols: Number(d[2]), encoding: d[3] === "!" ? "one_bit" : "lossless" };
      }
      matches.push(match);
    }
  }
  return matches.filter((x) => x.frame === 0);
}

/**
 * Draw boxes on a canvas whose pixels may differ from the source image.
 * Scales from the source size (w, h) to the canvas size automatically.
 */
export function drawOverlay(ctx, matches, scale = 1) {
  const canvas = ctx.canvas;
  ctx.save();
  ctx.lineWidth = Math.max(3, 3 * scale);
  ctx.strokeStyle = "#e8705f";
  ctx.fillStyle = "rgba(232,112,95,0.18)";
  for (const m of matches) {
    const sx = (canvas.width / m.w) * scale;
    const sy = (canvas.height / m.h) * scale;
    const [x1, y1, x2, y2] = m.box;
    const rx = x1 * sx, ry = y1 * sy, rw = (x2 - x1 + 1) * sx, rh = (y2 - y1 + 1) * sy;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
  }
  ctx.restore();
}
