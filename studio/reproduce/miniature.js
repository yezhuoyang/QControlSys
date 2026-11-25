// A run in miniature, inside a card on /reproduce or /examples: the opening beats of its track
// (riscq/ftqvm/preview.mjs) drawn on a canvas. Sites glow as operations act on them, a two-qubit gate
// lights the pair, moved atoms and ions travel between their places. It plays only while on screen,
// and shows one still frame to a reader who asked for reduced motion.

const COLOR = { "1q": "#34d399", "2q": "#f97316", measure: "#facc15", reset: "#60a5fa", decode: "#f472b6", frame: "#e879f9", factory: "#a78bfa" };
const SITE = { d: "#38bdf8", a: "#a78bfa", m: "#f472b6" };
const BEATS_PER_SECOND = 14, REST_BEATS = 10;

export function mountMiniature(canvas, preview) {
  const g = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const n = preview.sites.length;
  const movesOf = Array.from({ length: n }, () => []);
  for (const m of preview.moves) movesOf[m[0]]?.push(m);
  for (const list of movesOf) list.sort((a, b) => a[1] - b[1]);
  const total = preview.beats + REST_BEATS;
  let visible = false, raf = 0, start = performance.now();

  const where = (k, u) => {
    let p = preview.sites[k];
    for (const [, b0, b1, x0, y0, x1, y1] of movesOf[k]) {
      if (u < b0) break;
      if (u >= b1) { p = [x1, y1]; continue; }
      const f = (u - b0) / (b1 - b0), e = f * f * (3 - 2 * f);
      return [x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, true];
    }
    return p;
  };

  function draw(u) {
    const dpr = Math.min(2, devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, "#131a33");
    bg.addColorStop(1, "#070b18");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const pad = 22, top = 34, side = Math.min(w, h - top) - 2 * pad, ox = (w - side) / 2, oy = top + (h - top - side) / 2;
    const X = ([x, y]) => [ox + x * side, oy + y * side];
    const r = Math.max(2.2, Math.min(6, side / Math.sqrt(n) / 4.2));
    // The ion race track, and the couplers of a chip.
    if (preview.kind === "ions-ring") {
      g.strokeStyle = "rgba(148,163,184,.18)";
      g.lineWidth = 6;
      g.beginPath();
      g.ellipse(ox + side / 2, oy + side / 2, side / 2 - 4, side / 3, 0, 0, 2 * Math.PI);
      g.stroke();
    }
    g.lineWidth = 1;
    g.strokeStyle = "rgba(148,163,184,.16)";
    for (const [a, b] of preview.couplers) {
      if (!preview.sites[a] || !preview.sites[b]) continue;
      const [x0, y0] = X(preview.sites[a]), [x1, y1] = X(preview.sites[b]);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // What acts now.
    const lit = new Map(), pairs = [];
    for (const [k, b0, b1, ...s] of preview.events) {
      if (u < b0 || u >= b1) continue;
      for (const site of s) lit.set(site, k);
      if (k === "2q" && s.length === 2) pairs.push(s);
    }
    g.globalCompositeOperation = "lighter";
    for (const [a, b] of pairs) {
      const [x0, y0] = X(where(a, u)), [x1, y1] = X(where(b, u));
      g.strokeStyle = COLOR["2q"];
      g.lineWidth = 2.4;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // Glows shrink when much of the device acts at once (a whole patch reset), so the sites stay distinct.
    const halo = r * (lit.size > n / 3 ? 2.4 : 3.6);
    g.globalAlpha = lit.size > n / 3 ? 0.55 : 0.85;
    for (let k = 0; k < n; k++) {
      const p = where(k, u), [x, y] = X(p), k2 = lit.get(k);
      if (k2 || p[2]) {
        const glow = g.createRadialGradient(x, y, 0, x, y, halo);
        glow.addColorStop(0, k2 ? COLOR[k2] : "#ffffff");
        glow.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = glow;
        g.beginPath();
        g.arc(x, y, halo, 0, 2 * Math.PI);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    for (let k = 0; k < n; k++) {
      const [x, y] = X(where(k, u)), k2 = lit.get(k);
      g.fillStyle = k2 ? COLOR[k2] : SITE[preview.sites[k][2]] ?? SITE.a;
      g.globalAlpha = k2 ? 1 : 0.62;
      g.beginPath();
      g.arc(x, y, r, 0, 2 * Math.PI);
      g.fill();
    }
    g.globalAlpha = 1;
    // A thin progress line along the bottom.
    g.fillStyle = "rgba(226,232,240,.5)";
    g.fillRect(0, h - 2, (Math.min(u, preview.beats) / preview.beats) * w, 2);
  }

  function frame(now) {
    if (!visible) { raf = 0; return; }
    const u = (((now - start) / 1000) * BEATS_PER_SECOND) % total;
    draw(Math.min(u, preview.beats - 0.001));
    raf = requestAnimationFrame(frame);
  }
  if (reduced) {
    draw(preview.beats * 0.4);
    return { dispose() {} };
  }
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  });
  io.observe(canvas);
  draw(0);
  return { dispose() { io.disconnect(); visible = false; } };
}

/** The colours of the miniature, for a legend. */
export const MINIATURE_LEGEND = [["1q", "one-qubit gate"], ["2q", "two-qubit gate"], ["measure", "measurement"], ["reset", "reset"]].map(([k, label]) => [COLOR[k], label]);
