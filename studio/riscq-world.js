// One world for a run: every part of the machine at one position, shared by every view of the
// workspace. The views (riscq-layers.js VIEWS) only choose the camera frame and which parts are
// emphasised; they never move or rebuild a part, so the chip, the control system and the whole
// machine are the same machine seen three ways.
//
// Layout, in world units on the floor plane (x right, z toward the viewer, y up):
//   apparatus   inside a disc of radius R = 100: the chip, trap or atom array at its chipLayout
//               coordinates (riscq-layers.js), scaled to fit what the program uses
//   converters  ring at 150, each at the angle of the apparatus it drives
//   channels    ring at 200, beside their converter
//   cores       ring at 275, at the mean angle of their channels; inbox at 300, link at 325
//   bus         ring at 350 joining every link to the hub
//   hub, host   outside the bus at the front (+z)
//   optics      the optical table of a laser platform, left of the controller (x < −400)
// Every position beyond the apparatus disc is schematic: it shows what connects to what, not
// where a rack stands. Inside the disc, positions are the chip layout's, whose note says what
// they are. Nothing here depends on time; the stage moves only ions, atoms and light.
import * as layers from "./riscq-layers.js";

export const R = 100;
export const RINGS = Object.freeze({ converter: 150, channel: 200, core: 275, inbox: 300, link: 325, bus: 350, hub: 410, host: 460 });
const CONTROL = new Set(["host", "hub", "core", "link", "inbox"]);
const DRIVE = new Set(["pulse", "demod", "dio", "dac", "adc", "pins"]);

/** Region of a part kind: "apparatus", "drive" (converters and channels) or "control". */
export const regionOf = (kind) => (kind === "device" ? "apparatus" : DRIVE.has(kind) ? "drive" : CONTROL.has(kind) ? "control" : "other");

const memo = new WeakMap();

/**
 * The world of a run. Returns
 * { chip, toWorld([x, y]) → [x, 0, z], scale, parts: Map(id → { id, kind, region, at: [x, y, z], angle, size }),
 *   wires: [{ from, to, kind }], frames: { chip, control, machine } each { center: [x, y, z], half: [hx, hz] },
 *   table: { at: [x, 0, z], size: [w, d] } | null, notes: [] }.
 */
export function worldLayout(bundle) {
  if (memo.has(bundle)) return memo.get(bundle);
  const parts = new Map(), wires = [];
  const all = bundle.system?.parts ?? [];
  const put = (part, at, angle = 0, size = 1) => parts.set(part.id, { id: part.id, kind: part.kind, region: regionOf(part.kind), at, angle, size });
  const hasApparatus = all.some((p) => p.kind === "device");
  // Apparatus: the chip layout fitted into the disc.
  const chip = hasApparatus ? layers.chipLayout(bundle) : null;
  let toWorld = () => [0, 0, 0], scale = 1;
  if (chip) {
    const points = chip.focus?.length ? chip.focus : [...chip.devices.values(), ...(chip.sites?.values() ?? [])];
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), chip.platform === "neutral" ? 20 : chip.platform === "qccd" ? 2 : 1e-9);
    scale = (1.7 * R) / span;
    toWorld = (p) => [(p[0] - mid[0]) * scale, 0, (p[1] - mid[1]) * scale];
    const clamp = (v) => [Math.max(-1.1 * R, Math.min(1.1 * R, v[0])), v[1], Math.max(-1.1 * R, Math.min(1.1 * R, v[2]))];
    for (const part of all.filter((p) => p.kind === "device")) {
      const p = chip.devices.get(part.id);
      // A tone has no place of its own on the chip: its transducer sits at the edge it enters from.
      const at = p ? clamp(toWorld(p)) : /^aod\d+:x/.test(part.id) ? [0, 0, -1.2 * R] : /^aod\d+:y/.test(part.id) ? [-1.2 * R, 0, 0] : [0, 0, 0];
      put(part, at);
    }
  }
  // Converters and channels: at the angle of the apparatus they drive.
  const driven = layers.drivenBy(bundle), converter = layers.converterOf(bundle);
  const angleOf = (devices) => {
    const pts = [...new Set(devices ?? [])].map((d) => parts.get(d)?.at).filter(Boolean);
    if (!pts.length) return null;
    const c = pts.reduce((a, b) => [a[0] + b[0], 0, a[2] + b[2]], [0, 0, 0]).map((v) => v / pts.length);
    return pts.length > 2 && Math.hypot(c[0], c[2]) < 0.3 * R ? null : Math.atan2(c[2], c[0]);
  };
  const channels = all.filter((p) => ["pulse", "demod", "dio"].includes(p.kind));
  const byConverter = new Map();
  for (const ch of channels) {
    const conv = converter.get(ch.id) ?? ch.id;
    if (!byConverter.has(conv)) byConverter.set(conv, []);
    byConverter.get(conv).push(ch);
  }
  const groups = [...byConverter].map(([conv, list]) => {
    const devs = list.flatMap((ch) => driven.get(ch.id) ?? []);
    return { conv, list, devs, angle: angleOf(devs) };
  });
  // Converters with no apparatus angle fill the back of the ring in order.
  const free = groups.filter((g) => g.angle === null);
  free.forEach((g, k) => (g.angle = -Math.PI / 2 + ((k + 0.5) / Math.max(1, free.length) - 0.5) * Math.min(Math.PI, 0.35 * free.length)));
  groups.sort((a, b) => a.angle - b.angle);
  const minGap = Math.min((2 * Math.PI) / Math.max(groups.length, 1), (7 * Math.PI) / 180);
  for (let k = 1; k < groups.length; k++) if (groups[k].angle - groups[k - 1].angle < minGap) groups[k].angle = groups[k - 1].angle + minGap;
  const driveSize = Math.min(6, (2 * Math.PI * RINGS.converter) / Math.max(1, groups.length) / 6.5);
  const polar = (angle, radius, y = 0) => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  const channelAngle = new Map();
  for (const g of groups) {
    const convPart = all.find((p) => p.id === g.conv);
    if (convPart) {
      put(convPart, polar(g.angle, RINGS.converter), g.angle, driveSize);
      for (const d of new Set(g.devs)) if (parts.has(d)) wires.push({ from: convPart.id, to: d, kind: "coax", shared: new Set(g.devs).size > 2 });
    }
    g.list.forEach((ch, k) => {
      const spread = (k - (g.list.length - 1) / 2) * Math.min(0.06, minGap / Math.max(1, g.list.length));
      put(ch, polar(g.angle + spread, RINGS.channel + (k % 2) * 16), g.angle + spread, driveSize);
      channelAngle.set(ch.id, g.angle + spread);
      if (convPart) wires.push({ from: ch.id, to: convPart.id, kind: "wire" });
    });
  }
  // Converters no channel names (pins of a digital line are named by theirs) sit at the back.
  all.filter((p) => ["dac", "adc", "pins"].includes(p.kind) && !parts.has(p.id))
    .forEach((p, k) => put(p, polar(-Math.PI / 2 + (k - 0.5) * 0.08, RINGS.converter), -Math.PI / 2, driveSize));
  // Cores at the circular mean angle of their channels; inbox and link outward on the same ray.
  const coreOf = new Map();
  for (const ch of channels) coreOf.set(ch.id, ch.id.split(".")[0]);
  const cores = all.filter((p) => p.kind === "core");
  const coreName = (core) => core.id;
  const coreChannels = new Map(cores.map((c) => [c.id, channels.filter((ch) => ch.id === c.id || ch.id.startsWith(c.id + "."))]));
  const placed = cores.map((core) => {
    const angles = (coreChannels.get(core.id) ?? []).map((ch) => channelAngle.get(ch.id)).filter((a) => a !== undefined);
    const angle = angles.length ? Math.atan2(angles.reduce((s, a) => s + Math.sin(a), 0), angles.reduce((s, a) => s + Math.cos(a), 0)) : null;
    return { core, angle };
  });
  const loose = placed.filter((c) => c.angle === null);
  loose.forEach((c, k) => (c.angle = Math.PI / 2 + (k - (loose.length - 1) / 2) * 0.25));
  placed.sort((a, b) => a.angle - b.angle);
  const coreGap = Math.min((2 * Math.PI) / Math.max(placed.length, 1), (9 * Math.PI) / 180);
  for (let k = 1; k < placed.length; k++) if (placed[k].angle - placed[k - 1].angle < coreGap) placed[k].angle = placed[k - 1].angle + coreGap;
  const coreSize = Math.min(6, (2 * Math.PI * RINGS.core) / Math.max(1, placed.length) / 7);
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const { core, angle } of placed) {
    put(core, polar(angle, RINGS.core), angle, coreSize);
    for (const ch of coreChannels.get(core.id) ?? []) wires.push({ from: core.id, to: ch.id, kind: "wire" });
    const inbox = byId.get(coreName(core) + ".inbox"), link = byId.get(coreName(core) + ".link");
    if (inbox) {
      put(inbox, polar(angle, RINGS.inbox), angle, coreSize);
      wires.push({ from: inbox.id, to: core.id, kind: "wire" });
    }
    if (link) {
      put(link, polar(angle, RINGS.link), angle, coreSize);
      if (inbox) wires.push({ from: link.id, to: inbox.id, kind: "wire" });
      wires.push({ from: link.id, to: "bus", kind: "bus", angle });
    }
  }
  // Hub and host at the front, outside the bus.
  const front = Math.PI / 2;
  for (const p of all.filter((p) => p.kind === "hub")) put(p, polar(front, RINGS.hub), front, 6);
  for (const p of all.filter((p) => p.kind === "host")) put(p, polar(front, RINGS.host), front, 6);
  const hub = all.find((p) => p.kind === "hub"), host = all.find((p) => p.kind === "host");
  if (hub) wires.push({ from: "bus", to: hub.id, kind: "bus", angle: front });
  if (hub && host) wires.push({ from: hub.id, to: host.id, kind: "wire" });
  // Anything else: a row behind the bus.
  all.filter((p) => !parts.has(p.id)).forEach((p, k) => put(p, [-120 + k * 20, 0, -RINGS.hub], -Math.PI / 2, 4));
  // Run links the bundle declares and the layout has not drawn.
  for (const link of bundle.system?.links ?? [])
    if (parts.has(link.from) && parts.has(link.to) && !wires.some((w) => (w.from === link.from && w.to === link.to) || (w.from === link.to && w.to === link.from)))
      wires.push({ from: link.from, to: link.to, kind: "wire" });
  // The optical table of a laser platform.
  const optical = bundle.platform === "neutral" || bundle.platform === "qccd";
  const table = optical ? { at: [-(RINGS.host + 320), 0, 0], size: [520, 460] } : null;
  const extent = RINGS.host + 30;
  const frames = {
    chip: hasApparatus ? { center: [0, 0, 0], half: [RINGS.channel + 40, RINGS.channel + 40] } : { center: [0, 0, 0], half: [RINGS.bus + 20, RINGS.host + 20] },
    control: { center: [0, 0, 0], half: [RINGS.bus + 25, RINGS.host + 25] },
    machine: table ? { center: [(table.at[0] - table.size[0] / 2 + extent) / 2, 0, 0], half: [(extent - (table.at[0] - table.size[0] / 2)) / 2 + 10, extent] } : { center: [0, 0, 0], half: [extent, extent] },
  };
  const out = {
    platform: bundle.platform, chip, toWorld, scale, parts, wires, frames, table, R, rings: RINGS,
    notes: [
      "One layout for every view: the views frame it and emphasise parts, and never move one.",
      "Inside the apparatus disc positions are the chip layout's. Outside it the rings are schematic: they show what drives what, not where hardware stands.",
    ],
  };
  memo.set(bundle, out);
  return out;
}

const SIGNAL_RGB = { drive: [0.45, 0.8, 1], "cz-drive": [0.78, 0.55, 1], "readout-tone": [1, 0.8, 0.32], acquire: [0.5, 1, 0.68] };

/**
 * Electrical signals in flight at a batch, from the open windows of the trace: one per window
 * whose binding names an apparatus part. A window's signal leaves its converter when the window
 * opens and reaches the part after the binding's wire delay (riscq/design.mjs: routed length
 * over the medium's speed), so `t` = elapsed time ÷ delay, capped at 1. An acquisition window
 * carries the returning signal from the part to its ADC. Positions are the world's.
 * Returns [{ id, window, binding, kind, from: [x, y, z], to, t, rgb, elapsedPs }].
 */
export function signalsAt(bundle, state, atBatch = state?.atBatch) {
  const world = worldLayout(bundle), period = bundle.machine?.dspPeriodPs ?? 1;
  const out = [];
  for (const window of state?.openWindows ?? []) {
    const binding = layers.bindingOf(bundle, window);
    const device = binding?.part, conv = window.converter;
    if (!device || !world.parts.has(device) || !world.parts.has(conv)) continue;
    const kind = binding.detail?.kind ?? window.kind;
    const elapsedPs = Math.max(0, (atBatch - window.opens) * period);
    const delay = Math.max(binding.delayPs ?? 0, 1);
    const toPart = kind === "acquire";
    const a = world.parts.get(toPart ? device : conv).at, b = world.parts.get(toPart ? conv : device).at;
    out.push({ id: window.id, window, binding, kind, from: [a[0], 1.6, a[2]], to: [b[0], 1.6, b[2]], t: toPart ? Math.min(1, elapsedPs / Math.max(period, 1)) : Math.min(1, elapsedPs / delay),
      rgb: SIGNAL_RGB[kind] ?? [1, 0.62, 0.3], elapsedPs });
  }
  return out;
}

/** Frame and emphasis of a view: the camera fits `frame`; parts outside `emphasis` are drawn faded. */
export function viewOf(bundle, view) {
  const world = worldLayout(bundle);
  return { frame: world.frames[view] ?? world.frames.machine, emphasis: layers.viewParts(bundle, view) };
}
