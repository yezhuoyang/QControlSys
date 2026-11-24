// Plain-language explanations for the hover cards of the RISC-Q workspace. One entry per scene
// part kind, apparatus part, hardware instruction and frame operation. The statements follow
// docs/riscq-controller.md, where each register and latency is tied to its RISC-Q source.

/** Part kinds of `system.parts`: [name, what it is, what it does in a run, RISC-Q source]. */
export const PARTS = {
  host: ["Host processor", "The computer that loads firmware into every core and collects the results.",
    "Cores store measured bits and decoded words into its result memory through the write-only host window from 0x40000000.", "HostWindow.md"],
  hub: ["Board hub", "Shared switch between the cores of one board: group words of shared bits, counted barriers and mailboxes.",
    "Each core has a queue of 8 messages here. A round-robin arbiter passes one message per batch for the whole board. A publish reaches every core 23 batches later at link depth 4.", "PutHub.md"],
  core: ["RV32I control core", "A small RISC-V processor that runs one firmware program from its own RAM.",
    "It reads the batch-time register, stalls on waitTimeCmp until a start time is near, and issues timed register writes to its channels ahead of the time they must take effect (96 batches lead).", "RISCV.md, ControlMemMaps.scala"],
  link: ["Posted link", "The pipelined path from a core's put window to its channels and to the hub.",
    "A store into the put window becomes a posted write that arrives 1 + link-depth batches later. The core does not wait for it.", "PutBridge.md, PutLink.md"],
  inbox: ["Core inbox", "The core-local registers that results and messages return to.",
    "Holds readout results, digital input events, the board words of the hub, the barrier release time and two mailboxes. Reading a result that has not settled stalls the core.", "EventLink.md"],
  pulse: ["Pulse channel", "A pulse generator next to a DAC with a pulse table, a start time and timed queues.",
    "Writing a slot number to `fire` schedules that table entry at the start time. The queues release each parameter early by its own pipeline latency, so the pulse opens at the converter on exactly the scheduled batch.", "PulseParamBuffer.scala, TimedQueue.scala"],
  demod: ["Demodulation channel", "A readout window on ADC samples followed by a decoder.",
    "When its window closes the decoder turns the integrated I/Q values into a bit that reaches the core's inbox 9 batches later.", "ReadoutDecoder.md"],
  dio: ["Digital channel", "Timed updates of digital output lines and a queue of input edges.",
    "Used for photon counters and triggers: the core pops input events (time, sequence, count) from its inbox.", "EventLink.md"],
  dac: ["DAC output", "Digital-to-analog converter port. One batch carries 16 samples.",
    "A pulse window drawn here is what leaves the controller toward the apparatus, after the generator-to-port pipeline.", "map.py dac_pipe"],
  adc: ["ADC input", "Analog-to-digital converter port. One batch carries 4 samples.",
    "Feeds the demodulation channel during a readout window.", "map.py"],
  pins: ["Digital pins", "Physical digital input and output lines of a digital channel.",
    "Edges on the input lines are scripted inputs of the run, such as photon arrivals. They have no cause inside the model.", "EventLink.md"],
  device: ["Apparatus part", "A part of the quantum machine that a control signal reaches.",
    "Lit when a window bound to it is open. No quantum state is simulated: the model records which signal arrived when.", "program.bindings"],
};

/** Apparatus parts by ID pattern: [pattern, name, explanation]. */
const DEVICES = [
  [/^qubit(\d+)$/, (m) => "Transmon qubit " + m[1], "Driven by its gate channel (35 ns x90, 70 ns x) and by CZ channels shared with a neighbour (400 ns). Frame updates (virtual Z) play no pulse."],
  [/^resonator(\d+)$/, (m) => "Readout resonator of qubit " + m[1], "A readout tone is played into it and the reflected signal is demodulated on an ADC to give the measured bit."],
  [/^site:(.+)$/, (m) => "Gate site " + m[1], "A trap zone where laser pulses act on the ions present: single-ion rotations, MS two-ion gates and detection. Its zone core fires the modulators."],
  [/^electrodes:zone\.(.+)$/, (m) => "Electrodes of zone " + m[1], "The DC electrodes that move ions in and out of this zone. Each Studio control channel plays one waveform from a DAC during a transport cycle."],
  [/^electrodes:(.+)$/, (m) => "Electrode bank " + m[1], "A shared electrode control channel of QCCD Studio's wiring. Its waveform moves every ion its electrodes hold."],
  [/^light:(.+)$/, (m) => "Broadcast " + m[1] + " light", "One beam that reaches every ion at once, such as sympathetic cooling between gates."],
  [/^beam:(.+)$/, (m) => "Global " + m[1] + " beam", "A laser pulse on the whole atom array: Raman for one-qubit gates, Rydberg for entangling atoms that sit together in the gate zone."],
  [/^aod(\d+):([xy])(\d+)$/, (m) => "AOD " + m[1] + " " + (m[2] === "x" ? "column" : "row") + " tone " + m[3],
    "One RF tone of a crossed acousto-optic deflector. Its frequency sets the position of a line of tweezers. An atom sits where a column tone crosses a row tone: ramp up to pick up, step the frequency to move, ramp down to drop."],
];

/** Hardware instructions by `op`: what one instruction does physically. */
export const OPS = {
  x90: "π/2 rotation about X: one drive pulse on the qubit's gate channel.",
  x: "π rotation about X: one drive pulse.",
  frame: "Virtual Z: a phase update of later pulses. No pulse is played.",
  cz: "Controlled-Z between two neighbours: a tone on each qubit's CZ channel at the same time, then frame corrections.",
  measure: "Readout: a tone into the resonator (or a detection pulse on an ion site) and a demodulation or photon-count window that yields one bit.",
  decode: "The decoder core looks the correction up in a table in its RAM after reading the syndrome bits.",
  "pauli-frame": "A Pauli-frame update: bits of a qubit's frame word flip in the decoder's RAM. No pulse.",
  transport: "Ion transport: every engaged electrode control channel plays its waveform, moving ions between sites.",
  rotate: "Single-ion rotation: a laser modulator pulse with the gate's angle and phase.",
  ms: "Mølmer–Sørensen two-ion gate in a gate zone.",
  cool: "Broadcast sympathetic cooling pulse.",
  pickup: "AOD tones ramp up their RF amplitude, so the tweezers grab atoms.",
  move: "AOD tones step their frequency every 2 µs along the path, carrying atoms.",
  drop: "AOD tones ramp down, leaving atoms in the static traps.",
  raman: "Global Raman pulse: one-qubit gates on every atom.",
  rydberg: "Global Rydberg pulse: entangles atom pairs in the gate zone.",
  load: "The decoder reads its syndrome input.",
  report: "The decoder reports its result.",
};

/** Explanation of an apparatus part: [title, text], or null for another kind of part. */
export function device(id) {
  for (const [pattern, name, text] of DEVICES) {
    const m = pattern.exec(id);
    if (m) return [name(m), text];
  }
  return null;
}

/** Hover text for a part: { title, kind, what, role, source }. */
export function part(kind, id, label) {
  const [name, what, role, source] = PARTS[kind] ?? [kind, "", "", ""];
  const dev = kind === "device" ? device(id) : null;
  return { title: dev ? dev[0] : name, kind: name, what: dev ? dev[1] : what, role: dev ? PARTS.device[2] : role, source, label };
}

/** Panels and controls of the page that carry a hover explanation (data-explain="key"). */
export const UI = {
  "view-chip": "The apparatus and the converters and channels that drive it. Cores, links, the hub and the host keep running off view: their instructions stay in the program column and an off-view badge names them when they act.",
  "view-control": "The controller: host, hub, cores, links, inboxes, channels and converters, at their floorplan positions. The apparatus is off view.",
  "view-machine": "Every part at its schematic floorplan position: controller and apparatus together.",
  source: "The program as written. The highlighted lines are the origin of the hardware instruction of this step.",
  ir: "The intermediate program the source compiled to. QCCD Studio's TSIR: transport, gate and measure instructions with sites.",
  hardware: "Hardware instructions: one physical operation each, with a start time and a duration. The highlighted row is the instruction of this step.",
  firmware: "The RV32I firmware of one control core, disassembled from its RAM image. The highlighted word is the instruction at this step; tinted words belong to the current hardware instruction.",
  now: "What this step does at every layer: the frame, its hardware instruction and source, and the firmware word behind it.",
  offview: "Parts acting at this step that the current view does not draw. Click to switch to a view that shows them.",
  track: "Hardware instructions over time, coloured by kind. The line is the time of this step. Click to seek.",
};
