const channels = [
  { label: "Acquisition", key: "acquiring", color: "#397d9a" },
  { label: "Fiber in flight", key: "inFlight", color: "#b88829" },
  { label: "Start marker", key: "marker", color: "#706aa6" },
  { label: "DAC · 0–750 mV", key: "outputMv", color: "#14785c" },
];

export function createScope(canvas, choose, channelProfile) {
  const ctx = canvas.getContext("2d");
  let run,
    index = -1;
  const left = 110,
    top = 8;
  let right = 14,
    signals = channels;
  function value(state, key) {
    if (key === "inFlight") return state.inFlight === null ? 0 : 1;
    if (key === "outputMv") return state.outputMv / 750;
    return Number(state[key]);
  }
  function draw() {
    if (!run) return;
    const w = canvas.clientWidth,
      h = canvas.clientHeight,
      dpr = Math.min(devicePixelRatio, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    const end = run.frames.at(-1).atNs,
      span = Math.max(1, end) * 1.04;
    const x = (t) => left + ((w - left - right) * t) / span;
    const lane = (h - top - 23) / signals.length;
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textBaseline = "middle";
    const intervals = w - left - right < 260 ? 2 : 4;
    for (let i = 0; i <= intervals; i++) {
      const t = Math.round((span * i) / intervals);
      ctx.strokeStyle = "#dce4df";
      ctx.beginPath();
      ctx.moveTo(x(t), top);
      ctx.lineTo(x(t), h - 21);
      ctx.stroke();
      ctx.fillStyle = "#50635e";
      ctx.textAlign = i === intervals ? "right" : "center";
      ctx.fillText(t + " ns", x(t), h - 8);
    }
    signals.forEach(({ label, key, color, read, ticks }, row) => {
      const readValue = read || ((s) => value(s, key));
      const base = top + (row + 1) * lane - 4;
      const y = (v) => base - v * (lane - 9);
      ctx.textAlign = "left";
      ctx.fillStyle = "#344b46";
      ctx.fillText(label, 1, base - lane / 3);
      ctx.strokeStyle = "#e8ede8";
      ctx.beginPath();
      ctx.moveTo(left, base);
      ctx.lineTo(w - right, base);
      ctx.stroke();
      for (const [level, tick] of ticks || []) {
        const position = y(level);
        ctx.fillText(tick, w - right + 5, position);
        if (level > 0) {
          ctx.beginPath();
          ctx.moveTo(left, position);
          ctx.lineTo(w - right, position);
          ctx.stroke();
        }
      }
      let last = readValue(run.initial);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(0), y(last));
      for (const f of run.frames) {
        const v = readValue(f.state);
        if (v === last) continue;
        ctx.lineTo(x(f.atNs), y(last));
        ctx.lineTo(x(f.atNs), y(v));
        last = v;
      }
      ctx.lineTo(x(span), y(last));
      ctx.stroke();
      ctx.lineWidth = 1;
    });
    const time = index < 0 ? 0 : run.frames[index].atNs;
    ctx.strokeStyle = "#172d2b";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(time), top);
    ctx.lineTo(x(time), h - 20);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  canvas.addEventListener("click", (e) => {
    if (!run) return;
    const w = canvas.clientWidth;
    const t =
      ((e.clientX - canvas.getBoundingClientRect().left - left) /
        (w - left - right)) *
      run.frames.at(-1).atNs *
      1.04;
    choose(run.frames.findLastIndex((f) => f.atNs <= t));
  });
  new ResizeObserver(draw).observe(canvas);
  return (r, i) => {
    const changedProgram = run?.program !== r.program;
    run = r;
    index = i;
    if (channelProfile && changedProgram) {
      signals = channelProfile(r.program);
      const hasScale = signals.some((signal) => signal.ticks);
      right = hasScale ? 84 : 14;
      canvas.style.height =
        Math.max(140, 40 + (hasScale ? 72 : 24) * signals.length) + "px";
    }
    draw();
  };
}
