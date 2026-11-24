// Switch-level teaching cell. Coordinates are schematic display units. Each MOS
// switch is ideal, drives either its source level or high impedance ("Z"), and
// settles within one program step. Storage nodes retain an ideal binary charge.
export const sampleCell = {
  lut: "0110",
  pins: ["000", "001", "101", "111", "011", "111"]
};

const cellParts = [];
function part(id, kind, x, z, y = 0) {
  cellParts.push({id, kind, position: [x, y, z]});
}
for (let i = 0; i < 4; i++) part("bit" + i, "Configuration bit", -5, i * 2 - 3);
for (const [i, pin] of ["a", "b", "clk"].entries()) part(pin, "Input pad", -5, -6 + i * 0.9, 1);
for (const [i, pin] of ["a", "b", "clk"].entries()) {
  part(pin + ".pullUp", "pMOS to supply", -2 + i * 2, -6);
  part(pin + ".pullDown", "nMOS to ground", -2 + i * 2, -5);
  part(pin + ".bar", "Inverted select", -2 + i * 2, -4);
}
const selectors = [
  ["low", "a", "bit0", "bit1", -2, -1.4],
  ["high", "a", "bit2", "bit3", -2, 2.1],
  ["d", "b", "low", "high", 1, 0],
];
for (const [id, , , , x, z] of selectors) {
  for (let i = 0; i < 2; i++) {
    part(id + i + ".n", "nMOS pass switch", x, z + i * 1.1);
    part(id + i + ".p", "pMOS pass switch", x + 0.8, z + i * 1.1);
  }
  part(id, "Selector output", x + 1.35, z + 0.5, 0.8);
}
for (const [id, x] of [["master", 4], ["q", 6]]) {
  part(id + ".n", "nMOS sampling switch", x, 0);
  part(id + ".p", "pMOS sampling switch", x, 1);
  part(id, "Stored level", x, 2, 0.4);
}
export const cellMachine = {name: "Two-input programmable cell", unit: "step", parts: cellParts};

export function runCell(program) {
  if (typeof program?.lut !== "string" || !/^[01]{4}$/.test(program.lut) || !Array.isArray(program.pins) ||
      !program.pins.length || program.pins.length > 128 ||
      program.pins.some(bits => typeof bits !== "string" || !/^[01]{3}$/.test(bits)))
    throw Error("Enter four table bits and 1–128 pin rows in clock, B, A order.");
  if (!program.pins[0].startsWith("0")) throw Error("Begin with the clock low so the first rising edge is explicit.");
  const frames = [];
  for (const [step, bits] of program.pins.entries()) {
    if (step && bits[0] !== program.pins[step-1][0] && bits.slice(1) !== program.pins[step-1].slice(1))
      throw Error("Row " + (step + 1) + " changes data on a clock edge. Place the data change in a separate row.");
    const previous = frames.at(-1);
    const state = {}, events = [];
    function put(id, value, parents = []) {
      const before = previous?.state[id] ?? null;
      state[id] = value;
      events.push({id: step + "/" + id, part: id, before, after: value, causes: parents});
    }
    const refs = (...ids) => ids.map(id => step + "/" + id);
    const old = id => previous ? [(step - 1) + "/" + id] : [];
    for (let i = 0; i < 4; i++) put("bit" + i, Number(program.lut[i]), old("bit" + i));
    for (const [i, id] of ["clk","b","a"].entries()) {
      const level = Number(bits[i]);
      put(id, level);
      put(id + ".pullUp", level ? "Z" : 1, refs(id));
      put(id + ".pullDown", level ? 0 : "Z", refs(id));
      put(id + ".bar", level ? state[id + ".pullDown"] : state[id + ".pullUp"], refs(id + ".pullUp", id + ".pullDown"));
    }
    function pass(id, src, nGate, pGate) {
      put(id + ".n", state[nGate] ? state[src] : "Z", refs(src, nGate));
      put(id + ".p", state[pGate] ? "Z" : state[src], refs(src, pGate));
    }
    function driven(drivers) {
      const values = drivers.map(id => state[id]).filter(v => v !== "Z");
      if (new Set(values).size > 1) throw Error("Conflicting drivers.");
      return values[0];
    }
    for (const [id, sel, left, right] of selectors) {
      pass(id + "0", left, sel + ".bar", sel);
      pass(id + "1", right, sel, sel + ".bar");
      const wires = ["0.n","0.p","1.n","1.p"].map(suffix => id + suffix);
      put(id, driven(wires), refs(...wires));
    }
    for (const [id, src, nGate, pGate] of [["master","d","clk.bar","clk"],["q","master","clk","clk.bar"]]) {
      pass(id, src, nGate, pGate);
      const wires = [id + ".n", id + ".p"], sampled = driven(wires);
      put(id, sampled ?? previous?.state[id] ?? 0, [...refs(...wires), ...(sampled === undefined ? old(id) : [])]);
    }
    frames.push({at: step, label: "Pins " + bits, state, events});
  }
  return {machine: cellMachine, frames};
}
