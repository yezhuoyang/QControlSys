// The control board a RISC-Q build runs on: what one AMD ZCU216 (xczu49dr-ffvf1760-2-e) holds, and how
// many boards a design needs. Every limit names its evidence.
//
// Resource use of a build is estimated per block from a Yosys synthesis of RISC-Q's own RTL
// (validation/riscq/rtl/synth.sh, output in docs/control-fidelity-audit.md "Sizing a board"),
// calibrated to RISC-Q's two Vivado results of record (8 cores: 1,623 DSP48E2; 14 cores: 2,786), which
// the calibrated sum reproduces exactly for qubit cores. Block RAM and UltraRAM come out of
// synthesis exactly as recorded. LUT and FF counts from Yosys are not used (it maps adders to CARRY4
// and does not retime: 2× and 1.4× the recorded use).

const record = "RISC-Q vivado-scripts/riscvsoc-bd/README.md (results of record, x6y3 and zcu216-14q)";

export const ZCU216 = Object.freeze({
  part: "xczu49dr-ffvf1760-2-e",
  cores: { value: 14, source: "RISC-Q pblocks-bd.tcl: cores pinned to the X0 column, rows Y3–Y7, three per row; the 14-core build is the largest that closes timing (" + record + ")" },
  dacs: { value: 16, source: "ZCU216 / xczu49dr: 16 RF-DAC channels (RISC-Q SocSpec dac_num)" },
  adcs: { value: 16, source: "ZCU216 / xczu49dr: 16 RF-ADC channels (RISC-Q SocSpec adc_num)" },
  dsp: { value: 4272, source: "xczu49dr: 4,272 DSP48E2" },
  // Past this demand Vivado's balancer demotes multiplies to fabric and the build collapses.
  dspCeiling: { value: 2786, source: "RISC-Q docs/dsp/DSP48.md: the 14-qubit SoC's 2,786 DSP48E2 sat on the ~65 % knife edge" },
  uram: { value: 80, source: "xczu49dr: 80 URAM288" },
  bram: { value: 1080, source: "xczu49dr: 1,080 RAMB36" },
});

/**
 * DSP48E2 per block, synthesized (Yosys 0.71, synth_xilinx -family xcup) and calibrated on RISC-Q’s two
 * Vivado records: a qubit core (gate and readout pulse channels, demod, multiplier) synthesizes to 235;
 * the records give (2,786 − 1,623) / 6 = 193.8 per qubit core and 72.6 shared (8 cores: 1,623; 14: 2,786).
 */
const VIVADO_SCALE = 193.8 / 235;
const SHARED_DSP = 72.6;
export const DSP_PER = Object.freeze({
  pulse: 97 * VIVADO_SCALE, // PulseDriveChannel: PulseGenerator, 97 (RISC-Q docs/dsp/PulseGenerator.md says 97 too)
  demod: (25 + 12) * VIVADO_SCALE, // DemodChannel carrier 25 + ReadoutDecoder 12
  core: 4 * VIVADO_SCALE, // RiscvSoc: the Zmmul multiplier
  dio: 0,
});

/** URAM288 of one core's I+D RAM: a HalfUram packs two words per 4096 × 64 row (RiscvSoc.scala). */
const uramOfCore = (memWords) => Math.ceil(memWords / 8192);

/**
 * What one build (a riscq/soc.mjs `socSpec`) uses of a board, and the rules of RISC-Q's SocSpec it
 * breaks. `violations` empty means it builds on one ZCU216.
 */
export function boardUse(spec, board = ZCU216) {
  const dacs = new Set(), adcs = new Set();
  let dsp = 0, uram = 0;
  const violations = [];
  for (const core of spec.cores) {
    const demods = core.channels.filter((ch) => ch.kind === "demod").length;
    if (demods !== 1) violations.push({ rule: "demod", core: core.name, detail: "RISC-Q builds exactly one demod channel (decoder + ADC) into every core; " + core.name + " has " + demods });
    if (core.channels.length > 16) violations.push({ rule: "channels", core: core.name, detail: core.channels.length + " channels; a core has 16 put-window nodes" });
    dsp += DSP_PER.core + core.channels.reduce((n, ch) => n + (DSP_PER[ch.kind] ?? 0), 0);
    uram += uramOfCore(core.memWords);
    for (const ch of core.channels) {
      if (ch.dac !== undefined) dacs.add(ch.dac);
      if (ch.adc !== undefined) adcs.add(ch.adc);
    }
  }
  const use = { cores: spec.cores.length, dacs: dacs.size, adcs: adcs.size, dsp: Math.round(dsp + SHARED_DSP), uram };
  if (use.cores > board.cores.value) violations.push({ rule: "cores", detail: use.cores + " cores; one board holds " + board.cores.value });
  if ([...dacs].some((d) => d >= board.dacs.value) || use.dacs > board.dacs.value) violations.push({ rule: "dacs", detail: use.dacs + " DAC channels (highest index " + Math.max(...dacs) + "); a board has " + board.dacs.value });
  if ([...adcs].some((d) => d >= board.adcs.value) || use.adcs > board.adcs.value) violations.push({ rule: "adcs", detail: use.adcs + " ADC channels; a board has " + board.adcs.value });
  if (use.dsp > board.dspCeiling.value) violations.push({ rule: "dsp", detail: "about " + use.dsp + " DSP48E2; past " + board.dspCeiling.value + " the build collapses" });
  if (use.uram > board.uram.value) violations.push({ rule: "uram", detail: use.uram + " URAM288; a board has " + board.uram.value });
  return { use, violations };
}

/**
 * The fewest boards a build could be split over, resource by resource (a lower bound: placement of
 * converters and cores on boards is not solved here). Each core needs its own demod channel.
 */
export function boardsNeeded(spec, board = ZCU216) {
  const { use } = boardUse(spec, board);
  const qubitCores = spec.cores.length;
  const bound = {
    cores: Math.ceil(qubitCores / board.cores.value),
    dacs: Math.ceil(use.dacs / board.dacs.value),
    adcs: Math.ceil(use.adcs / board.adcs.value),
    dsp: Math.ceil(use.dsp / board.dspCeiling.value),
  };
  const boards = Math.max(1, ...Object.values(bound));
  const binding = Object.entries(bound).filter(([, v]) => v === boards).map(([k]) => k);
  return { boards, bound, binding, use };
}
