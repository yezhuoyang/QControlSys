// Worked examples of the operating system's scheduler, one idea each, for the interactive
// stepper on /schedule. Every example is a complete QSysASM program: its machine line and its
// statements. The page schedules them in the browser with the OS's own code (riscq/os/schedule.mjs,
// riscq/os/des.mjs); tests/os-teaching.test.mjs checks that each shows what its lesson claims.
//
// Each example: { id, title, idea (one sentence), lesson (what to watch), text, controls (the
// machine fields a reader may change), options (the scheduler options it starts with),
// variants: [{ label, text }] (other spellings of the same program) }.
import { machineLine } from "../ftqvm/qsysasm.mjs";

// A transmon-like machine; each example changes what its lesson needs.
const BASE = {
  qubits: 16, decoders: 1, factories: 1, classical_data_bandwidth: 500, qubit_routing_bandwidth: 5000, ancilla_bandwidth: 1000,
  max_parallel_gates: 16, gate1q_ns: 40, gate2q_ns: 200, measure_ns: 1000, reset_ns: 160, route_latency_ns: 2,
  decoder_latency_ns: 400, magic_state_latency_ns: 5000, pauli_frame_update_ns: 30,
};
const program = (comment, fields, lines) => [...comment.map((c) => "# " + c), machineLine({ ...BASE, ...fields }), "", ...lines].join("\n") + "\n";
const range = (n) => Array.from({ length: n }, (_, i) => i);

const parity = [
  "request_ancilla  count=2  ancilla[0:1]", "route  ancilla[0], data[0:1]", "CNOT  data[0], ancilla[0]", "CNOT  data[1], ancilla[0]",
  "route  ancilla[1], data[1:2]", "CNOT  data[1], ancilla[1]", "CNOT  data[2], ancilla[1]", "measure  basis=Z  ancilla[0] -> s[0]",
  "measure  basis=Z  ancilla[1] -> s[1]", "release_ancilla  count=2  ancilla[0:1]", "s[0:1] -> decode_syndrome  rounds=1", "s[0:1] -> pauli_frame_update  X data[0:2]",
];

const twoChecks = (shortFirst) => {
  const long = ["CNOT data[1], ancilla[1]", "CNOT data[2], ancilla[1]", "CNOT data[3], ancilla[1]", "measure basis=Z ancilla[1] -> s[1]", "s[1] -> decode_syndrome rounds=1"];
  const short = ["CNOT data[0], ancilla[0]", "measure basis=Z ancilla[0] -> s[0]", "s[0] -> decode_syndrome rounds=1"];
  return program(["Two checks share one gate slot and one decoder.", shortFirst ? "The weight-1 check is written first." : "The weight-3 check is written first."],
    { max_parallel_gates: 1, measure_ns: 600, decoder_latency_ns: 900 }, shortFirst ? [...short, ...long] : [...long, ...short]);
};

export const EXAMPLES = [
  {
    id: "critical-path", title: "The critical path",
    idea: "With every service plentiful, a program takes as long as its longest chain of dependencies.",
    lesson: "Each statement starts the moment its last predecessor ends. The parity round's chain runs request → CNOTs → measure → decode → frame update; nothing ever waits for a service.",
    text: program(["One parity round of the 3-qubit bit-flip code, with the latencies measured on the cycle-exact model (§ 3)."],
      { qubits: 5, max_parallel_gates: 5, gate2q_ns: 472, measure_ns: 1324, decoder_latency_ns: 474, pauli_frame_update_ns: 182 }, parity),
    controls: ["max_parallel_gates", "decoders"], options: { policy: "order" },
  },
  {
    id: "gate-slots", title: "Gate slots",
    idea: "A gate needs a gate slot; with fewer slots than gates, the gates run in waves.",
    lesson: "Six checks are independent, but with 2 gate slots only two CNOTs run at once. Raise max_parallel_gates to 6 and they all start together; the measurements then overlap completely.",
    text: program(["Six independent checks; the machine has 2 gate slots."], { max_parallel_gates: 2 },
      range(6).flatMap((i) => [`CNOT data[${i}], ancilla[${i}]`, `measure basis=Z ancilla[${i}] -> s[${i}]`])),
    controls: ["max_parallel_gates"], options: { policy: "order" },
  },
  {
    id: "order-matters", title: "Order matters",
    idea: "With a shared service, the order in which ready statements are served changes the makespan.",
    lesson: "Written long check first, the short check's CNOT waits behind three CNOTs and its decode waits for the decoder: 3.0 µs. Serve the short check first (the second spelling) and its measurement and decode overlap the long check's gates: 2.6 µs, the optimum over all 40,320 orders (§ 2.1).",
    text: twoChecks(false), variants: [{ label: "long check first", text: twoChecks(false) }, { label: "short check first", text: twoChecks(true) }],
    controls: ["max_parallel_gates", "decoders"], options: { policy: "order", strict: true },
  },
  {
    id: "classical-bandwidth", title: "Classical bandwidth",
    idea: "A measurement reserves r(1, D) = ⌈1000 / D⌉ bits/µs of the classical bandwidth for its whole duration.",
    lesson: "Each 1 µs measurement reserves 1 bit/µs, and the hub carries 4 bits/µs here, so only 4 of the 8 measurements run at once. Watch the classical pool fill; raise its capacity to 8 and the second wave disappears.",
    text: program(["Eight measurements at once; the board carries 4 bits/µs."], { classical_data_bandwidth: 4 }, range(8).map((i) => `measure basis=Z data[${i}] -> c[${i}]`)),
    controls: ["classical_data_bandwidth"], options: { policy: "order" },
  },
  {
    id: "ancilla-bandwidth", title: "Ancilla preparation",
    idea: "request_ancilla count=N holds N qubits until their release, and reserves r(N, reset) of the preparation bandwidth while it resets them.",
    lesson: "Each request of 4 ancillas reserves ⌈1000·4/160⌉ = 25 qubits/µs of a 40 qubits/µs preparation service, so the three requests reset one after another although the qubit pool has room for all twelve.",
    text: program(["Three tenants each prepare 4 ancillas; preparation runs at 40 qubits/µs."], { ancilla_bandwidth: 40 },
      range(3).flatMap((t) => [`request_ancilla count=4 ancilla[${4 * t}:${4 * t + 3}]`, `H ancilla[${4 * t}]`, `CNOT ancilla[${4 * t}], ancilla[${4 * t + 1}]`,
        `measure basis=Z ancilla[${4 * t + 1}] -> a[${t}]`, `release_ancilla count=4 ancilla[${4 * t}:${4 * t + 3}]`])),
    controls: ["ancilla_bandwidth", "qubits"], options: { policy: "order" },
  },
  {
    id: "decoder-backlog", title: "A decoder that falls behind",
    idea: "If a decode takes longer than a round, one decoder falls further behind every round.",
    lesson: "A round's syndrome arrives every 1 µs and a decode takes 1.6 µs. With one decoder the queue of waiting decodes grows by one every few rounds; set decoders to 2 and every decode starts as soon as its syndrome arrives.",
    text: program(["One syndrome bit per round, every round decoded. Decoding is slower than a round."], { decoder_latency_ns: 1600 },
      range(8).flatMap((k) => [`measure basis=Z ancilla[0] -> s[${k}]`, `s[${k}] -> decode_syndrome rounds=1`])),
    controls: ["decoders"], options: { policy: "fifo" },
  },
  {
    id: "factory", title: "A magic-state factory",
    idea: "request_magic holds a factory for the factory's whole latency; T gates queue for factories.",
    lesson: "Two T gates each need a magic state, and one factory takes 5 µs per state, so the second T gate waits 5 µs for the factory. With 2 factories both states are made at once.",
    text: program(["Two T gates by magic-state injection, one factory."], { factories: 1, magic_state_latency_ns: 5000 },
      range(2).flatMap((i) => [`request_magic state=|T> magic[${i}]`, `CNOT data[${i}], magic[${i}]`, `measure basis=Z magic[${i}] -> m[${i}]`, `m[${i}] -> pauli_frame_update Z data[${i}]`])),
    controls: ["factories"], options: { policy: "order" },
  },
  {
    id: "routing", title: "Transport is a shared service",
    idea: "On trapped ions and neutral atoms, route moves qubits, and moves share the transport hardware.",
    lesson: "Each route takes 50 µs and reserves ⌈1000·2/50000⌉ = 1 qubit/µs; the transport carries 1 qubit/µs here, so the three routes run one at a time and every gate waits for its route. Raise qubit_routing_bandwidth to 3 and they move together.",
    text: program(["Three two-qubit gates on an ion trap; every pair must first be brought together."],
      { route_latency_ns: 50000, qubit_routing_bandwidth: 1, gate2q_ns: 300, measure_ns: 1000 },
      range(3).flatMap((i) => [`route data[${2 * i}], data[${2 * i + 1}]`, `CNOT data[${2 * i}], data[${2 * i + 1}]`])),
    controls: ["qubit_routing_bandwidth"], options: { policy: "order" },
  },
  {
    id: "deadlock", title: "Deadlock",
    idea: "Holding ancillas while waiting for more lets two programs wait for each other forever.",
    lesson: "Each tenant takes one of the 2 ancillas at 0 ns and asks for a second at 200 ns: each holds what the other needs, and nothing can move. Tick “ancillas in program order” and tenant A gets both before B gets any: it completes.",
    text: program(["Two tenants share a pool of 2 ancilla qubits; each timetable is valid alone."], { qubits: 2, ancilla_bandwidth: 64 }, [
      "# Tenant A", "@0 ns     request_ancilla count=1 ancilla[0]", "@160 ns   H ancilla[0]", "@200 ns   request_ancilla count=1 ancilla[1]",
      "@360 ns   CNOT ancilla[0], ancilla[1]", "@560 ns   measure basis=Z ancilla[1] -> a[0]", "@1560 ns  release_ancilla count=2 ancilla[0:1]",
      "# Tenant B", "@0 ns     request_ancilla count=1 ancilla[2]", "@160 ns   H ancilla[2]", "@200 ns   request_ancilla count=1 ancilla[3]",
      "@360 ns   CNOT ancilla[2], ancilla[3]", "@560 ns   measure basis=Z ancilla[3] -> b[0]", "@1560 ns  release_ancilla count=2 ancilla[2:3]"]),
    controls: ["qubits"], options: { policy: "fifo" },
  },
  {
    id: "starvation", title: "Starvation",
    idea: "Backfill keeps services busy, but a large request can wait while small ones keep passing it.",
    lesson: "Tenant L needs all 4 ancillas at 100 ns; three small tenants take one each, again and again. With backfill L waits until they are all done. Tick “ancillas in program order” and L is served first, because it is written first.",
    text: program(["Tenant L needs the whole pool of 4 ancillas; tenants S0–S2 need 1 each, repeatedly."], { qubits: 4, ancilla_bandwidth: 64 }, [
      "# Tenant L", "@100 ns   request_ancilla count=4 ancilla[0:3]", "@260 ns   measure basis=Z ancilla[0] -> big[0]", "@1260 ns  release_ancilla count=4 ancilla[0:3]",
      ...range(3).flatMap((t) => ["# Tenant S" + t, ...range(3).flatMap((rep) => {
        const at = rep * 1300 + t * 430, a = 4 + 3 * t + rep;
        return [`@${at} ns  request_ancilla count=1 ancilla[${a}]`, `@${at + 160} ns  H ancilla[${a}]`, `@${at + 200} ns  measure basis=Z ancilla[${a}] -> s${t}[${rep}]`, `@${at + 1200} ns  release_ancilla count=1 ancilla[${a}]`];
      })])]),
    controls: ["qubits"], options: { policy: "fifo" },
  },
];

/** Scheduler options from the stepper's controls: the policy names the page shows. */
export const POLICIES = Object.freeze([
  { id: "order", label: "Program order", note: "ready statements are served in the order they are written" },
  { id: "fifo", label: "First ready, first served", note: "ready statements are served in the order they became ready" },
  { id: "deadline", label: "Listed time", note: "ready statements are served in the order of their @ times (a timetable's own order)" },
]);
