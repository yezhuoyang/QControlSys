// The control system of a digital twin in 3D: the RISC-Q board (one FPGA with its cores), the
// converters, the cables to the device or to the optics that drive it, and the host.
//
// What lights up comes from the run (riscq/ftqvm/track.mjs controllerTrack): a core glows over
// the batches the Lean trace shows one of its channels playing a pulse, and a signal packet runs
// along the cable to the site the pulse drives (back from it for a readout). Decoder cores glow
// while the decoder service runs a decode, the frame core while it updates the Pauli frame.
// Which cores exist, their channels and the sites they drive are the build's (the riscq-design
// or optical design the run used). Placement of the board, converters, optics and host around
// the device is schematic: it is not the geometry of a lab.
import * as THREE from "three";

export const ROLE_COLORS = {
  qubit: 0x3b82f6, frame: 0xe879f9, decoder: 0xf472b6, beam: 0x10b981, global: 0xff3b6b,
  pump: 0x60a5fa, mover: 0xf59e0b, readout: 0xfacc15,
};
export const ROLE_LABEL = {
  qubit: "qubit control core", frame: "Pauli-frame core", decoder: "decoder core", beam: "addressing-beam core",
  global: "global-pulse core", pump: "optical-pumping core", mover: "transport core", readout: "readout core",
};
const CHANNEL_COLOR = { gate: 0x34d399, cz: 0xf97316, ro: 0xfacc15, demod: 0xfacc15, detect: 0xfacc15, rydberg: 0xff3b6b, raman: 0x34d399, pump: 0x60a5fa };
const hex = (c) => "#" + c.toString(16).padStart(6, "0");

/** A text label as a sprite: `size` is its height in world units. */
export function textSprite(text, { size = 0.35, color = "#e2e8f0", background = "rgba(15,23,42,0.78)", bold = false } = {}) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), px = 44;
  g.font = (bold ? "700 " : "500 ") + px + "px system-ui, sans-serif";
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w;
  c.height = px + 22;
  g.font = (bold ? "700 " : "500 ") + px + "px system-ui, sans-serif";
  if (background) {
    g.fillStyle = background;
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, 12);
    g.fill();
  }
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 14, c.height / 2 + 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  s.scale.set((size * c.width) / c.height, size, 1);
  s.renderOrder = 10;
  return s;
}

/** The optics a core role drives, on a neutral-atom or trapped-ion twin. */
function opticsOf(role, name, kind) {
  const atoms = kind === "atoms";
  if (role === "global") {
    const which = name.replace(/^global-/, "").replace(/\d+$/, "");
    return { rydberg: "Rydberg laser · global pulse", raman: "Raman laser · global one-qubit layer", pump: "optical-pumping laser · global reset" }[which] ?? "global laser";
  }
  if (role === "beam") return atoms ? "addressing beams (AOM)" : "gate beams (AOM)";
  if (role === "pump") return "pumping beams";
  if (role === "mover") return atoms ? "AOD · atom moves" : "electrode DACs · ion transport";
  if (role === "readout") return atoms ? "camera · imaging" : "PMT array · fluorescence";
  return null;
}

/**
 * Build the control system next to the device. `device` gives the device's frame and positions.
 * Returns { bounds, deviceBounds, pickables, update(t, { decoding, framing }) }.
 */
export function buildControl(scene, controller, device) {
  const { kind, center, size, positionAt, siteCount, glowSprite } = device;
  const group = new THREE.Group();
  scene.add(group);
  const cores = controller.cores, n = cores.length;
  const optical = kind !== "transmon";

  // ---- board and FPGA ----
  const cols = Math.max(4, Math.ceil(Math.sqrt(n * 2.2))), rows = Math.ceil(n / cols), tile = 0.42, pitch = 0.56;
  const fw = cols * pitch + 0.6, fd = rows * pitch + 1.0;
  const bw = Math.max(fw + 4.5, Math.min(size.x + 3, fw + 9)), bd = fd + 3.4;
  const zFront = center.z - size.z / 2 - (optical ? 7.5 : 4.5); // the board's edge nearest the device
  const B = new THREE.Vector3(center.x, 0, zFront - bd / 2);
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.12, bd), new THREE.MeshStandardMaterial({ color: 0x0d4d2f, roughness: 0.75, metalness: 0.1 }));
  pcb.position.copy(B).setY(0.06);
  group.add(pcb);
  // The board's edge connectors and traces, for legibility.
  const traceMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.8, roughness: 0.35 });
  for (let i = 0; i < 14; i++) {
    const tr = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, bd * 0.36), traceMat);
    tr.position.set(B.x - fw / 2 + (i + 0.5) * (fw / 14), 0.125, B.z + fd / 2 + bd * 0.14);
    group.add(tr);
  }
  const fpga = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.22, fd), new THREE.MeshStandardMaterial({ color: 0x1e2433, roughness: 0.5, metalness: 0.4 }));
  fpga.position.copy(B).setY(0.23);
  group.add(fpga);
  const fpgaLabel = textSprite(`RISC-Q FPGA · ${controller.board.dspMHz} MHz batch clock · ${n} cores`, { size: 0.62, bold: true });
  fpgaLabel.position.set(B.x, 1.3, B.z - fd / 2 - 0.3);
  group.add(fpgaLabel);

  const tiles = cores.map((c, i) => {
    const color = ROLE_COLORS[c.role] ?? 0x94a3b8;
    const m = new THREE.Mesh(new THREE.BoxGeometry(tile, 0.12, tile), new THREE.MeshStandardMaterial({ color: 0x334155, emissive: color, emissiveIntensity: 0.12, roughness: 0.4 }));
    const r = Math.floor(i / cols), col = i % cols;
    m.position.set(B.x - fw / 2 + 0.3 + pitch / 2 + col * pitch, 0.4, B.z - fd / 2 + 0.7 + pitch / 2 + r * pitch);
    m.userData = { pick: "core", core: c, index: i };
    group.add(m);
    return { mesh: m, color, core: c, until: -1 };
  });

  // ---- converters on the front edge: one DAC block per core that plays pulses, an ADC for readout ----
  const pulsing = cores.map((c, i) => (c.channels.some(([k]) => k === "pulse") ? i : -1)).filter((i) => i >= 0);
  const dacAt = new Map();
  const convW = Math.min(0.5, (bw - 1) / Math.max(1, pulsing.length)), convMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4, metalness: 0.5 });
  pulsing.forEach((ci, j) => {
    const x = B.x - ((pulsing.length - 1) * convW) / 2 + j * convW, z = B.z + bd / 2 - 0.35;
    const chip = new THREE.Mesh(new THREE.BoxGeometry(convW * 0.8, 0.16, 0.4), convMat);
    chip.position.set(x, 0.2, z);
    chip.userData = { pick: "converter", core: cores[ci] };
    group.add(chip);
    dacAt.set(ci, new THREE.Vector3(x, 0.28, z + 0.2));
    // The board trace from the core to its converter.
    const from = tiles[ci].mesh.position.clone().setY(0.36), to = new THREE.Vector3(x, 0.14, z - 0.2);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, new THREE.Vector3(from.x, 0.14, from.z), new THREE.Vector3(from.x, 0.14, (from.z + to.z) / 2), new THREE.Vector3(to.x, 0.14, (from.z + to.z) / 2), to]),
      new THREE.LineBasicMaterial({ color: 0xc9a227, transparent: true, opacity: 0.55 }));
    group.add(line);
  });
  if (pulsing.length) {
    const l = textSprite(optical ? "DACs → AOM / AOD / electrode drivers" : "DACs (drive, flux, readout tone) and ADCs (demodulation)", { size: 0.46 });
    l.position.set(B.x, 1.5, B.z + bd / 2 - 0.2);
    group.add(l);
  }

  // ---- host ----
  const host = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 1.4), new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6, metalness: 0.3 }));
  host.position.set(B.x - bw / 2 - 2.0, 0.55, B.z - bd / 2 + 0.7);
  host.userData = { pick: "host" };
  group.add(host);
  const hostLabel = textSprite("host · loads programs, collects records", { size: 0.44 });
  hostLabel.position.copy(host.position).setY(1.6);
  group.add(hostLabel);
  const link = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([host.position.clone().setY(0.3), new THREE.Vector3(host.position.x + 1.3, 0.2, host.position.z), fpga.position.clone().add(new THREE.Vector3(-fw / 2, -0.05, -fd / 2 + 0.3))]), 24, 0.04, 6),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.5 }));
  group.add(link);

  // ---- cables and optics ----
  const cables = new Map(); // key core:site (transmon) or core (optics) -> { curve, mesh }
  const tubeMat = (color) => new THREE.MeshStandardMaterial({ color: 0x8a94a8, emissive: color, emissiveIntensity: 0, metalness: 0.6, roughness: 0.4, transparent: true, opacity: 0.3 });
  const opticsBoxes = new Map(); // label -> { mesh, cores: [], at }
  let fridge;
  if (!optical) {
    // A coax line from each qubit core's converter to every transmon the core drives, down
    // through the dilution refrigerator (drawn as its outline round the chip).
    const r = Math.max(size.x, size.z) / 2 + 1.6;
    fridge = new THREE.Group();
    for (const [y, op] of [[-0.15, 0.5], [1.4, 0.3], [2.6, 0.2]]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: op * 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.set(center.x, y, center.z);
      fridge.add(ring);
    }
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 2.8, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    shell.position.set(center.x, 1.25, center.z);
    fridge.add(shell);
    group.add(fridge);
    const fl = textSprite("dilution refrigerator · chip at about 10 mK", { size: 0.5 });
    fl.position.set(center.x - r + 1.5, 3.0, center.z - r * 0.7);
    group.add(fl);
    cores.forEach((c, ci) => {
      const from = dacAt.get(ci);
      if (!from) return;
      for (const s of c.sites) {
        if (s >= siteCount) continue;
        const to = positionAt(s, 0).clone().setY(0.06);
        const curve = new THREE.CubicBezierCurve3(from, from.clone().setY(2.8), to.clone().setY(3.2), to);
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.022, 5), tubeMat(0xffffff));
        group.add(mesh);
        cables.set(ci + ":" + s, { curve, mesh });
      }
    });
  } else {
    // An optical table between board and device: one instrument per kind of core, driven by its
    // cores' DACs; its light reaches the array when one of them plays.
    const tableZ = center.z - size.z / 2 - 3.6;
    const kinds = [];
    cores.forEach((c, ci) => {
      const label = opticsOf(c.role, c.name, kind);
      if (!label) return;
      if (!opticsBoxes.has(label)) { opticsBoxes.set(label, { cores: [], role: c.role }); kinds.push(label); }
      opticsBoxes.get(label).cores.push(ci);
    });
    const table = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x + 2, kinds.length * 2.6), 0.14, 2.4), new THREE.MeshStandardMaterial({ color: 0x3f4654, roughness: 0.8, metalness: 0.5 }));
    table.position.set(center.x, -0.07, tableZ);
    group.add(table);
    const spacing = Math.max(2.2, Math.min(3.2, (size.x + 2) / Math.max(1, kinds.length)));
    kinds.forEach((label, j) => {
      const o = opticsBoxes.get(label), color = ROLE_COLORS[o.role];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 1.0), new THREE.MeshStandardMaterial({ color: 0x1f2937, emissive: color, emissiveIntensity: 0.1, roughness: 0.5, metalness: 0.4 }));
      mesh.position.set(center.x - ((kinds.length - 1) * spacing) / 2 + j * spacing, 0.4, tableZ);
      mesh.userData = { pick: "optics", label, cores: o.cores.map((ci) => cores[ci].name) };
      group.add(mesh);
      const aperture = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16), new THREE.MeshStandardMaterial({ color: 0x111827, emissive: color, emissiveIntensity: 0.4 }));
      aperture.rotation.x = Math.PI / 2;
      aperture.position.copy(mesh.position).add(new THREE.Vector3(0, 0.1, 0.52));
      group.add(aperture);
      const l = textSprite(label, { size: 0.4 });
      l.position.copy(mesh.position).setY(j % 2 ? 1.85 : 1.2); // staggered, so neighbours do not overlap
      group.add(l);
      Object.assign(o, { mesh, aperture, color, at: mesh.position.clone(), beam: null });
      // Cables from each core's DAC to the instrument.
      for (const ci of o.cores) {
        const from = dacAt.get(ci);
        if (!from) continue;
        const to = mesh.position.clone().add(new THREE.Vector3(0, 0, -0.5));
        const curve = new THREE.CubicBezierCurve3(from, from.clone().add(new THREE.Vector3(0, 0.9, 0.9)), to.clone().add(new THREE.Vector3(0, 0.9, -0.9)), to);
        const cm = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.025, 5), tubeMat(0xffffff));
        group.add(cm);
        cables.set(String(ci), { curve, mesh: cm, optics: o });
      }
      // Its light path to the array: a beam drawn while one of its cores plays.
      const beamGeo = new THREE.BufferGeometry().setFromPoints([o.aperture.position, center.clone().setY(0.1)]);
      o.beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      group.add(o.beam);
    });
  }

  // ---- signal packets ----
  const packets = Array.from({ length: 240 }, () => {
    const s = glowSprite(0xffffff, 0.32);
    s.visible = false;
    group.add(s);
    return s;
  });

  // ---- pulses, sorted by start ----
  const pulses = controller.pulses.slice().sort((a, b) => a[2] - b[2]);
  const maxDur = Math.max(1, ...pulses.map((p) => p[3] - p[2]));
  const firstAfter = (t) => { let lo = 0, hi = pulses.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pulses[mid][2] < t) lo = mid + 1; else hi = mid; } return lo; };
  const channelColor = (ci, ch) => {
    const name = cores[ci]?.channels[ch]?.[1] ?? "";
    const key = Object.keys(CHANNEL_COLOR).find((k) => name.split(".").at(-1).startsWith(k));
    return CHANNEL_COLOR[key] ?? ROLE_COLORS[cores[ci]?.role] ?? 0xffffff;
  };
  const isReadout = (ci, ch) => /(^|\.)(demod|pmt)$/.test(cores[ci]?.channels[ch]?.[1] ?? "") || cores[ci]?.channels[ch]?.[0] === "demod";
  const decoderTiles = tiles.filter((x) => x.core.role === "decoder"), frameTiles = tiles.filter((x) => x.core.role === "frame");

  const bounds = new THREE.Box3().setFromObject(group);
  bounds.expandByPoint(center.clone().add(size.clone().multiplyScalar(0.5)));
  bounds.expandByPoint(center.clone().sub(size.clone().multiplyScalar(0.5)));
  const controlBounds = new THREE.Box3().setFromObject(pcb).expandByObject(host).expandByObject(fpgaLabel);

  function update(t, { decoding = 0, framing = 0 } = {}) {
    for (const x of tiles) x.mesh.material.emissiveIntensity = 0.12;
    for (const c of cables.values()) { c.mesh.material.emissiveIntensity = 0; c.mesh.material.opacity = 0.3; }
    for (const o of opticsBoxes.values()) { o.mesh.material.emissiveIntensity = 0.1; o.beam.material.opacity = 0; }
    let used = 0, active = 0;
    for (let i = firstAfter(t - maxDur); i < pulses.length && pulses[i][2] <= t; i++) {
      const p = pulses[i];
      if (p[3] <= t) continue;
      active++;
      const [ci, ch, t0, t1] = p, color = channelColor(ci, ch), tl = tiles[ci];
      if (tl) { tl.mesh.material.emissive.setHex(tl.color); tl.mesh.material.emissiveIntensity = 1.8; }
      const f = Math.min(1, Math.max(0, (t - t0) / Math.max(1, t1 - t0))), back = isReadout(ci, ch);
      if (!optical) {
        for (let k = 4; k < p.length; k++) {
          const c = cables.get(ci + ":" + p[k]);
          if (!c) continue;
          c.mesh.material.emissive.setHex(color);
          c.mesh.material.emissiveIntensity = 1.2;
          c.mesh.material.opacity = 1;
          if (used < packets.length) {
            const s = packets[used++];
            s.visible = true;
            s.material.color.setHex(color);
            s.material.opacity = 1;
            s.position.copy(c.curve.getPoint(back ? 1 - f : f));
          }
        }
      } else {
        const c = cables.get(String(ci));
        if (c) {
          c.mesh.material.emissive.setHex(color);
          c.mesh.material.emissiveIntensity = 1.2;
          c.mesh.material.opacity = 1;
          c.optics.mesh.material.emissiveIntensity = 1.4;
          c.optics.beam.material.opacity = 0.85;
          if (used < packets.length) {
            const s = packets[used++];
            s.visible = true;
            s.material.color.setHex(color);
            s.material.opacity = 1;
            s.position.copy(c.curve.getPoint(back ? 1 - f : f));
          }
        }
      }
    }
    for (let k = used; k < packets.length; k++) packets[k].visible = false;
    // The decoder service and the frame core: not pulses, but the run's decode and frame events.
    decoderTiles.forEach((x, i) => { if (i < decoding * Math.max(1, Math.ceil(decoderTiles.length / 4))) x.mesh.material.emissiveIntensity = 1.8; });
    if (framing) for (const x of frameTiles) x.mesh.material.emissiveIntensity = 1.8;
    return { activePulses: active };
  }

  return { bounds, controlBounds, pickables: [...tiles.map((x) => x.mesh), ...[...opticsBoxes.values()].map((o) => o.mesh), host], update };
}

/** What the inspector shows for a picked part of the control system. */
export function describePick(data, controller) {
  if (data.pick === "core" || data.pick === "converter") {
    const c = data.core;
    const channels = c.channels.map(([k, name]) => name + (k === "pulse" ? "" : " (" + k + ")"));
    return `<b style="color:${hex(ROLE_COLORS[c.role] ?? 0xffffff)}">${c.name}</b> · ${ROLE_LABEL[c.role] ?? c.role}${data.pick === "converter" ? " · its converters" : ""}<br>` +
      `${c.channels.length} channel${c.channels.length > 1 ? "s" : ""}: ${channels.slice(0, 8).join(", ")}${channels.length > 8 ? ", …" : ""}` +
      (c.sites.length ? `<br>drives site${c.sites.length > 1 ? "s" : ""} ${c.sites.join(", ")}` : "");
  }
  if (data.pick === "optics") return `<b>${data.label}</b><br>driven by ${data.cores.join(", ")}`;
  if (data.pick === "host") return `<b>host</b><br>loads each core's program onto the board (${controller.board.name}) and reads the records back`;
  return "";
}
