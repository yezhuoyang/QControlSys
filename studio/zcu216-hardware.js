// An AMD ZCU216 evaluation board running RISC-Q, drawn in mm for the hardware design page and every
// page that shows a machine (form "zcu216"). The layout is illustrative: the RFSoC with its heat sink
// in the middle, the RF-DAC and RF-ADC SMA rows along the front edge, FMC connectors at the back, power
// at the left. Its RISC-Q cores are shown as tiles on the RFSoC lid, one per core the board carries.
const pcb = 0x1f5a44, solder = 0x2c7a5c, rfsoc = 0x2a2f36, sink = 0x8d9aa3, gold = 0xd9a652, black = 0x1a1d21, core = 0x5fa8d3;

export function drawZcu216(s, p) {
  if (p.form !== "zcu216") return false;
  const [w, h, d] = p.sizeMm, t = 1.6, top = -h / 2 + t;
  s.box([0, -h / 2 + t / 2, 0], [w, t, d], pcb);
  s.box([0, top + 0.05, 0], [w * 0.96, 0.1, d * 0.94], solder);
  // The RFSoC: its package, its heat sink fins, and one tile per RISC-Q core on the lid.
  const chip = Math.min(w, d) * 0.32;
  s.box([0, top + 1.2, -d * 0.05], [chip, 2.4, chip], rfsoc);
  for (let k = 0; k < 7; k++) s.box([(k - 3) * chip * 0.14, top + 2.4 + 2.5, -d * 0.05], [chip * 0.06, 5, chip * 0.92], sink);
  const cores = p.model?.zcu216?.cores ?? 0, perRow = 4;
  for (let i = 0; i < Math.min(cores, 16); i++) {
    const r = Math.floor(i / perRow), c = i % perRow;
    s.box([(c - 1.5) * chip * 0.22, top + 7.7, -d * 0.05 + (r - 1.5) * chip * 0.22], [chip * 0.17, 0.6, chip * 0.17], core);
  }
  // RF-DAC (16) and RF-ADC (16) SMA connectors along the front edge, each row drawn as one strip of
  // connector bodies with a dark band of sockets (a machine of many boards stays light to draw).
  for (const [row, color] of [[0, gold], [1, 0xb9c3c9]]) {
    const z = d / 2 - 6 - row * 9;
    s.box([0, top + 2.5, z], [w * 0.88, 5, 4.4], color);
    s.box([0, top + 5.2, z], [w * 0.86, 0.6, 2], black);
  }
  // FMC connectors and the power entry.
  for (const x of [-0.25, 0.25]) s.box([w * x, top + 2, -d / 2 + 9], [w * 0.3, 4, 6], black);
  s.box([-w / 2 + 10, top + 4, -d / 2 + 18], [14, 8, 14], black);
  return true;
}
