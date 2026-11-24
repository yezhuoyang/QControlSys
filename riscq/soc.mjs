// SoC description, address map and latency model of a RISC-Q build. The address formulas
// follow RISC-Q `software/riscq/map.py` (SocMap) and the fixed constants `software/riscq/spec.py`.
// Every latency below names the RISC-Q document that states it. Values marked "assumed" are
// model choices within a documented range.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** DAC samples and ADC samples carried by one dspClk cycle (one batch). */
export const BATCH_SIZE = 16, ADC_BATCH = 4;
/** Software schedule lead in batches: link, slowest fired queue lead and core jitter (map.py LEAD). */
export const LEAD = 96;
/** Wait after a demod start before a result read returns this window (map.py READOUT_LEAD). */
export const READOUT_LEAD = 48;
/** Largest amplitude code that keeps the unsaturated datapath in range (pulses/golden.py AMP_SCALE). */
export const AMP_SCALE = 19896;

/** Core-local addresses (map.py SocMap, ControlMemMaps.scala, EventLink.scala). */
export const MAP = Object.freeze({
  MEM_BASE: 0x80000000,
  CTRL_TIME_CMP: 0x4000, CTRL_WAIT_TIME_CMP: 0x4008, CTRL_DONE: 0x4010, CTRL_TIME: 0xbff8,
  SINK_BASE: 0x4200, SINK_STRIDE: 0x20,
  INBOX_BOARD: 0x4300, INBOX_RELEASE: 0x4320, INBOX_MAILBOX0: 0x4340,
  PUT_WINDOW: 0x10000, RF_CH_STRIDE: 0x10000,
  RF_FIRE: 0x0, RF_FREQ: 0x4, RF_DC_OFFSET: 0x8, RF_PHASE_OFFSET: 0xc, RF_SLOT_STRIDE: 0x10, RF_START_TIME: 0x4100,
  LOCAL_NODES: 16, GROUP_NODES: 4, BARRIER_IDS: 16, GROUP_NODE0: 16, BARRIER_NODE0: 20, INBOX_NODE0: 36,
  HOSTWIN: 0x40000000,
});

function fail(message) {
  throw Error("RISC-Q build — " + message);
}

/** Normalize a RISC-Q build description. Accepts the channel-list form of `software/configs`. */
export function socSpec(raw) {
  if (raw.qubit_num !== undefined) raw = fromLegacy(raw);
  const defaults = raw.core_defaults ?? {};
  if (!Array.isArray(raw.cores) || !raw.cores.length) fail("list at least one core.");
  const cores = raw.cores.map((c) => {
    const merged = { mem_depth: 4096, with_mul: true, queue_depth: 4, ...defaults, ...c };
    if (!Array.isArray(merged.channels) || !merged.channels.length) fail("core " + merged.name + " needs a channel.");
    const channels = merged.channels.map((ch) => {
      if (!["pulse", "demod", "dio"].includes(ch.kind)) fail("unknown channel kind " + ch.kind + ".");
      return {
        name: ch.name, kind: ch.kind, slots: ch.slots,
        envDepth: ch.kind === "dio" ? 0 : (ch.env_depth ?? 1024),
        interp: ch.interp ?? 1,
        ...(ch.kind === "pulse" ? { dac: ch.dac } : {}),
        ...(ch.kind === "demod" ? { adc: ch.adc } : {}),
      };
    });
    if (new Set(channels.map((ch) => ch.name)).size !== channels.length) fail("duplicate channel name in " + merged.name + ".");
    return { name: merged.name, memWords: merged.mem_depth, withMul: merged.with_mul, queueDepth: merged.queue_depth, channels };
  });
  if (new Set(cores.map((c) => c.name)).size !== cores.length) fail("duplicate core name.");
  if (!(raw.dsp_freq_hz > 0)) fail("state dsp_freq_hz.");
  const dspPeriodPs = Math.round(1e12 / raw.dsp_freq_hz);
  return { name: raw.name ?? "riscq", dspFreqHz: raw.dsp_freq_hz, dspPeriodPs, linkPipe: raw.link_pipe ?? 4, cores };
}

/** The role-named form: `qubit_num` cores of gate, ro and demod channels (spec.py from_legacy). */
function fromLegacy(raw) {
  const cores = [];
  for (let c = 0; c < raw.qubit_num; c++) {
    const gateDac = raw.dac_map ? raw.dac_map[c][0] : c;
    const roDac = raw.dac_map ? raw.dac_map[c][1] : c < 7 ? 14 : 15;
    const adc = raw.adc_map ? raw.adc_map[c] : c < 7 ? 0 : 4;
    cores.push({
      name: "q" + c,
      mem_depth: raw.mem_depth, with_mul: raw.with_mul ?? true, queue_depth: raw.queue_depth ?? 4,
      channels: [
        { name: "gate", kind: "pulse", slots: raw.gate_pulse_num, env_depth: raw.env_depth, interp: raw.gate_interp, dac: gateDac },
        { name: "ro", kind: "pulse", slots: 1, env_depth: raw.env_depth, interp: raw.readout_interp, dac: roDac },
        { name: "demod", kind: "demod", slots: 1, env_depth: raw.env_depth, interp: raw.demod_interp ?? 4, adc },
      ],
    });
  }
  return { name: raw.name, dsp_freq_hz: raw.dsp_freq_hz, link_pipe: raw.link_pipe, cores };
}

/** Register stages from a pulse generator to its DAC port (map.py dac_pipe). */
export function dacPipe(spec) {
  const counts = new Map();
  for (const core of spec.cores)
    for (const ch of core.channels) if (ch.dac !== undefined) counts.set(ch.dac, (counts.get(ch.dac) ?? 0) + 1);
  const combine = (n) => (n <= 1 ? 0 : 32 - Math.clz32(n - 1) + 1);
  return Math.max(0, ...[...counts.values()].map(combine)) + 2;
}

/** Latency model in dspClk cycles, with the source of each number. */
export function model(spec, overrides = {}) {
  const linkPipe = spec.linkPipe;
  return {
    linkPipe,
    bridge: 1, // PutBridge.md: the store is forwarded as one beat after a one-cycle ack
    fireToPush: 2, // PulseParamBuffer.md: a fired pulse reaches the queue push 2 cycles after its beat
    freqToPush: 1, // PulseParamBuffer.scala: io.freq.valid := RegNext(hit(freqAddr))
    coreTimeLag: linkPipe, // assumed: ARCH.md says the core copy reads dspTime − D for a constant link delay D
    waitSlack: 3, // ControlMemMaps.scala: delay = 3
    dacPipe: dacPipe(spec),
    redirectPenalty: 5, // assumed upper bound: RISCV.md stages 0–4 refill after a redirect at jumpAt
    busPenalty: 1, // LsuPlugin.md: a load or store halts execute until the response, one cycle
    hubDown: 1 + linkPipe + 2 + 4, // PutHub.md: bridge, link, queue and arbiter, decode and dispatch
    hubUp: 1 + linkPipe + 2 + linkPipe + 1, // PutHub.md: replica and link, core merge, link, inbox
    reportUp: 3 + 2 + linkPipe + 1, // EventLink.md: up to three puts, merge, link, sink (assumed worst case)
    decoder: 9, // ReadoutDecoder.md: ComplexMul 6 + 1 + log2Up(4)
    sinkDepth: 8, // EventLink.md: consume-on-read queue of depth 8
    hubQueue: 8, // PutHub.md: one queue of depth 8 per source in front of the round-robin arbiter
    ...overrides,
  };
}

/** CPU address of a channel register. */
export function channelBase(index) {
  return MAP.PUT_WINDOW + index * MAP.RF_CH_STRIDE;
}
/** CPU address of the sink of a reporting channel (demod result or dio events). */
export function sinkAddress(core, channelIndex) {
  const tag = core.channels.slice(0, channelIndex).filter((ch) => ch.kind !== "pulse").length;
  return MAP.SINK_BASE + tag * MAP.SINK_STRIDE;
}

/** A 16-bit code seated in bits 31:16 of a put word (map.py pack16). */
export const pack16 = (code) => ((code & 0xffff) << 16) >>> 0;

/** Batches nearest to a duration in nanoseconds. */
export const batches = (ns, spec) => Math.round((ns * 1000) / spec.dspPeriodPs);

/** Carrier code: phase advance per DAC sample in units of π, 16 bits (units.py _freq_code). */
export function freqCode(hz, spec, lanes = BATCH_SIZE) {
  const rate = lanes * spec.dspFreqHz;
  const code = Math.round((hz * 65536) / rate);
  if (code <= -65536 || code >= 65536) fail("frequency " + hz + " Hz exceeds the sample rate.");
  return ((code + 32768) & 0xffff) - 32768;
}
/** Phase code in units of π, 16 bits (units.py _phase_code). */
export function phaseCode(rad) {
  const turn = 2 * Math.PI;
  const x = rad - turn * Math.round(rad / turn);
  return ((Math.round((x / Math.PI) * 32768) + 32768) & 0xffff) - 32768;
}
/** Amplitude code for a in [−1, 1] (units.py _amp_code). */
export function ampCode(a) {
  if (!(a >= -1 && a <= 1)) fail("amplitude " + a + " is outside [−1, 1].");
  return Math.round(a * AMP_SCALE);
}

/** Assemble the document the Lean executable runs. `images[i]` is `{words, sourceMap}`. */
export function program(spec, images, options = {}) {
  if (images.length !== spec.cores.length) fail("supply one image per core.");
  return {
    kind: "riscq-soc",
    version: 1,
    name: options.name ?? spec.name,
    dspPeriodPs: spec.dspPeriodPs,
    timeOffset: options.timeOffset ?? 0,
    model: model(spec, options.model),
    cores: spec.cores.map((core, i) => ({
      name: core.name,
      memWords: core.memWords,
      withMul: core.withMul,
      queueDepth: core.queueDepth,
      channels: core.channels,
      image: images[i].words,
      sourceMap: images[i].sourceMap ?? [],
    })),
    readouts: options.readouts ?? [],
    dioInputs: options.dioInputs ?? [],
    responses: options.responses ?? [],
    bindings: options.bindings ?? [],
    trace: options.trace ?? "io",
    maxBatches: options.maxBatches ?? 100000000,
    maxEvents: options.maxEvents ?? 200000,
    maxSteps: options.maxSteps ?? 5000000,
  };
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = path.join(root, ".lake", "build", "bin", process.platform === "win32" ? "qcontrol.exe" : "qcontrol");

/** Run or check a document with the Lean executable. */
export function execute(document, { checkTrace = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, checkTrace ? ["--check-trace"] : [],
      { windowsHide: true, timeout: 240000, maxBuffer: 1 << 30 },
      (error, stdout, stderr) => {
        if (error) return reject(Error(stderr.trim() || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(document));
  });
}
