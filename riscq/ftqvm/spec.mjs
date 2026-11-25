// The system specification QuantumOS hands to FormalRV: the `.machine` and `.sysspec` files its
// back end (`qec_sys`) and VM read, in FormalRV's own format (FormalRV/ftq_vm/TEXT_SYSPROG.md).
//
// A spec here is data with provenance. Every value says where it comes from:
//   { value, source: "measured", trace } from a QuantumOS run,
//   { value, source: "cited", ref } from the literature (riscq/standards.mjs),
//   { value, source: "derived", from } as arithmetic on other values, or
//   { value, source: "provisional", ref } as a placeholder still to be derived.
// Units are FormalRV's: integers in ns, bits/us and qubits/us.

/** Machine fields FormalRV requires, with their units (FormalRV/ftq_vm/ocaml/resource_vm.ml). */
export const MACHINE_FIELDS = Object.freeze({
  qubits: "total", factories: "total", max_parallel_gates: "total", decoders: "total",
  classical_data_bandwidth: "bits/us", qubit_routing_bandwidth: "qubits/us", ancilla_bandwidth: "qubits/us",
  gate1q_ns: "ns", gate2q_ns: "ns", measure_ns: "ns", reset_ns: "ns", route_latency_ns: "ns",
  decoder_latency_ns: "ns", magic_state_latency_ns: "ns", pauli_frame_update_ns: "ns",
});

/** Optional machine fields. `decoder_latency_model` is an expression in the input bits n. */
export const MACHINE_OPTIONAL = Object.freeze({
  decoder_bandwidth: "bits/us", classical_memory: "bits", decoder_window_rounds: "total", decoder_latency_model: "ns",
});

/** Fields of a gadget resource contract in a .sysspec. */
export const CONTRACT_FIELDS = Object.freeze({
  qubits: "total", runtime: "ns", gates: "total", factories: "total", decoders: "total",
  classical_data_bandwidth: "bits/us", qubit_routing_bandwidth: "qubits/us", ancilla_bandwidth: "qubits/us",
});

/** Fields of a factory contract (`spec factory`, `factory_ccz`, `factory_autoccz`, `factory_y`), in the .machine file. */
export const FACTORY_FIELDS = Object.freeze({
  output_qubits: "total", workspace_qubits: "total", latency: "ns", gates: "total", decoders: "total",
  classical_data_bandwidth: "bits/us", qubit_routing_bandwidth: "qubits/us",
});

export const PROGRAM_FIELDS = Object.freeze({ qubits_min: "total", qubits: "total", runtime_min: "ns", runtime: "ns" });

const valueOf = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);

function render(value, unit, name) {
  const v = valueOf(value);
  if (typeof v === "string") return `${v} ${unit}`; // a symbolic expression, e.g. decoder_latency_model
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer, not ${v}`);
  return `${v} ${unit}`;
}

function fields(values, table, optional = {}, { required = true } = {}) {
  const out = [];
  for (const [name, unit] of Object.entries(table)) {
    if (values[name] === undefined) {
      if (required) throw new Error(`missing ${name}`);
      continue;
    }
    out.push(`${name}: ${render(values[name], unit, name)}`);
  }
  for (const [name, unit] of Object.entries(optional)) if (values[name] !== undefined) out.push(`${name}: ${render(values[name], unit, name)}`);
  const known = new Set([...Object.keys(table), ...Object.keys(optional)]);
  for (const name of Object.keys(values)) if (!known.has(name)) throw new Error(`unknown field ${name}`);
  return out.join(", ");
}

/** The `.machine` text: one `machine { ... }` line. */
export function machineText(spec) {
  for (const [name, v] of Object.entries(spec.machine)) {
    if (name.endsWith("_ns") && valueOf(v) <= 0) throw new Error(`${name} must be positive`);
  }
  const lines = [`machine { ${fields(spec.machine, MACHINE_FIELDS, MACHINE_OPTIONAL)} }`];
  // Factory contracts follow the machine line, as in FormalRV's own machine files.
  for (const [name, c] of Object.entries(spec.factories ?? {})) lines.push("", `spec ${name}:`, `  resource { ${fields(c, FACTORY_FIELDS)} }`);
  return lines.join("\n") + "\n";
}

/**
 * The `.sysspec` text: `spec program`, then one contract per round gadget, then factory and
 * maintenance contracts when the spec has them (in the order FormalRV's examples use).
 */
export function sysspecText(spec) {
  const lines = ["spec program:", `  resource { ${fields(spec.program, PROGRAM_FIELDS)} }`];
  for (const [name, c] of Object.entries(spec.contracts || {})) lines.push(`spec ${name}:`, `  resource { ${fields(c, CONTRACT_FIELDS)} }`);
  for (const [name, c] of Object.entries(spec.extra || {})) {
    // Factory and maintenance contracts have their own field sets: each entry is { value, unit }.
    lines.push(`spec ${name}:`, `  resource { ${Object.entries(c).map(([k, v]) => `${k}: ${render(v, v.unit, k)}`).join(", ")} }`);
  }
  return lines.join("\n") + "\n";
}

/** Both files' text, as formalrv.build() takes them. */
export function files(spec) {
  return { machine: machineText(spec), sysspec: sysspecText(spec) };
}

/** Factory contracts of a FormalRV machine file: { factory: { output_qubits: 9, … }, factory_ccz: … }. */
export function parseFactories(text) {
  const out = {};
  for (const m of text.matchAll(/^spec (factory\w*):\s*\n\s*resource\s*\{([^}]*)\}/gm)) {
    out[m[1]] = {};
    for (const part of m[2].split(",")) {
      const f = /^\s*([a-z_0-9]+)\s*:\s*(\d+)/.exec(part);
      if (f && f[1] in FACTORY_FIELDS) out[m[1]][f[1]] = Number(f[2]);
    }
  }
  return out;
}

/** Parse a FormalRV `machine { ... }` line into { field: number | string }. */
export function parseMachine(text) {
  const m = /machine\s*\{([\s\S]*?)\}/.exec(text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"));
  if (!m) throw new Error("no machine { ... } declaration");
  const out = {};
  for (const part of m[1].split(",")) {
    const f = /^\s*([a-z_0-9]+)\s*:\s*(.+?)\s*$/.exec(part);
    if (!f) continue;
    const [, name, rest] = f;
    const unit = MACHINE_FIELDS[name] ?? MACHINE_OPTIONAL[name];
    const raw = unit && rest.endsWith(unit) ? rest.slice(0, -unit.length).trim() : rest;
    out[name] = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/**
 * A provisional spec from an existing FormalRV machine file: every value is marked provisional,
 * with the file as its reference. Contracts for the given round gadgets get the machine's whole
 * capacity, which FormalRV checks but which says nothing about the hardware yet; spec
 * derivation (derive.mjs) replaces them with measured values.
 */
export function provisional(machineFileText, ref, { gadgets = [], runtimeNs = 1_000_000_000 } = {}) {
  const m = parseMachine(machineFileText);
  const tag = (value) => ({ value, source: "provisional", ref });
  const machine = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, tag(v)]));
  const whole = {
    qubits: m.qubits, runtime: runtimeNs, gates: m.max_parallel_gates, factories: m.factories, decoders: m.decoders,
    classical_data_bandwidth: m.classical_data_bandwidth, qubit_routing_bandwidth: m.qubit_routing_bandwidth, ancilla_bandwidth: m.ancilla_bandwidth,
  };
  return {
    machine,
    program: { qubits_min: tag(0), qubits: tag(m.qubits), runtime_min: tag(0), runtime: tag(runtimeNs) },
    contracts: Object.fromEntries(gadgets.map((g) => [g, Object.fromEntries(Object.entries(whole).map(([k, v]) => [k, tag(v)]))])),
  };
}
