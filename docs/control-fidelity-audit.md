# Control-system fidelity audit

Written 2026-11-24, after the request that no part of the control system be modeled by a
shortcut: the FPGA, the cores, how a decoder is compiled to the chip and runs there, and how
data moves. This file lists every place where the model was not yet the real thing. It gives
the evidence each part will be replaced with, and the check that shows the replacement matches.
Each item is closed only when its check passes. The status column is kept up to date.

The reference design throughout is RISC-Q (github.com/Wu-Quantum-Application-System-Group/RISC-Q).
It is an open SpinalHDL SoC with RTL, simulations and Vivado results of record on the AMD ZCU216
(`xczu49dr-ffvf1760-2-e`). Where RISC-Q has RTL, the RTL is the ground truth. Where it only has
a document, the document is cited and the item says so.

## Shortcuts found

| # | Part | What the model did | Why it is not real | Severity |
|---|---|---|---|---|
| S1 | Board capacity | One board carried up to 64 cores (`riscq/design.mjs`). The Willow twin put 54 cores on one board, Bluvstein 23, H2 53. | A ZCU216 has 16 RF-DAC and 16 RF-ADC channels. RISC-Q's floorplan pins cores to the X0 column, 14 at most (5 rows × 3 bands). Its 8-core build already uses 38 % of the DSP slices and 29 % of the LUTs (vivado-scripts/riscvsoc-bd/README.md, result of record 2026-09-15). The 14-core build closes timing only after an incremental pass. | Critical |
| S2 | Core timing | Each instruction costs one batch, plus an assumed penalty after a taken jump and on every load or store (`QControl/RiscQ/Soc.lean` `redirectPenalty`, `busPenalty`). | The RISC-Q core has a real microarchitecture: 6 in-order stages, fetch forked at stage 0 and joined at stage 1, a 2-entry BTB, a 6-bit GShare, branch resolution at stage 4 with the redirect at stage 5, an interlock on 1-ahead shift/load/CSR/jump/SLT/logic producers, a load/store unit that halts execute for each access, and a 3-cycle multiply halt (docs/riscv/*.md). Every decode time we report depends on this. | Critical |
| S3 | Decoder output | Helios's reference C program reports the cluster root of every node. No correction is derived. | `decode_syndrome` must produce the Pauli correction that the frame applies. | Critical |
| S4 | Decoder placement in time | Each decode runs in a Lean run of its own. It is joined to the pulse run by a constant `PUBLISH_NS = 52` (riscq/ftqvm/decoder.mjs). | The syndrome bits travel over the hub (and across boards) in the same run as the pulses. Contention with other traffic changes their arrival. | Critical |
| S5 | Frame update and feed-forward | The frame core applies every update unconditionally, and no pulse depends on a decoded bit in the paper runs. | A frame update and a conditioned gate must read the decoded bit that arrives over the hub. | High |
| S6 | Syndromes | All outcomes are 0, so every syndrome is empty and the decoder's best case is the only one timed. | Decode time depends on the syndrome. Real syndromes come from the noisy circuit. | High |
| S7 | Lookup decoder | 9 and 10 bits are linearly interpolated from the measured 1- and 8-bit times. | Every size must be measured. | Medium |
| S8 | Hub and links | Modeled from PutHub.md, PutLink.md and EventLink.md statements, not from the RTL. Three latencies are assumed: core time lag, report to sink, branch and memory penalties. | The RTL exists and can be simulated. | High |
| S9 | Multi-board | Not modeled. | Machines above one board's limits need several boards. RISC-Q has White Rabbit sync over a GTY lane (riscq.wr) and PutLane, which carries hub puts between boards. Their latencies are build-time constants asserted in RISC-Q's simulations. | Critical (follows from S1) |
| S10 | Optical actuators in the system-call runs | An AOD move, a global laser pulse and an ion transport were each one DAC pulse of the move's duration (riscq/ftqvm/optical.mjs). Readout was 3 photon edges on a counter line. The controller ran at an unsourced 100 MHz. | QuantumOS's own lowering already plays real AOD tone ramps and frequency steps (riscq/platforms/neutral.mjs) and electrode waveforms (riscq/platforms/qccd.mjs). A camera exposure and its readout are not counter edges. The RISC-Q board runs at 500 MHz. | High |
| S11 | FPGA resources and timing | Not modeled: no LUT, FF, BRAM, URAM or DSP budget, no clock-region floorplan, no timing closure. | Whether a design fits the chip and closes timing decides whether it can be built. | High |
| S12 | Host | Only the write-only host window. | The Zynq PS loads programs over AXI and reads results back. This takes time outside the run. | Low |
| S14 | Transmon two-qubit gate | The Willow twin plays a CZ as tones on the two drive lines, as RISC-Q's 8-transmon calibration does. It gives each transmon one extra pulse channel per coupled partner. | Willow's CZ is a flux pulse on a tunable coupler: one baseband line per coupler. The twin's channels are not the device's. With 97 DSP slices per pulse channel (docs/dsp/PulseGenerator.md), six channels per transmon would need about 20 boards. | High |
| S15 | Design rules of RISC-Q's SocSpec | Not enforced. The Willow twin gave a core two demodulation channels (two transmons per core). The optical designs numbered DACs up to 63. | SocSpec allows exactly one demod channel per core (one decoder, one ADC), and DAC and ADC indices below `dac_num` and `adc_num` (16 on a ZCU216). | Critical |
| S16 | Core configuration inside the SoC | The model used one set of latencies for every core. | In `PulseTableSoc` each core is built with `fetchLatency = 4` (a 9-stage pipeline). Its I/D RAM is UltraRAM (read latency 3). It has `aluNoFastForward`, so every 1-ahead dependency interlocks. There are full stream pipes on both memory buses and a posted-store shim on the data bus (PulseTableSoc.scala, RiscvSoc.md, RiscqFiber.scala). | Critical (part of S2) |
| S13 | 3D placement | The board, converters and optics are placed schematically. | Labelled as schematic. Positions of parts in the lab are not claimed. | Labelled |

## How each is replaced

1. **RTL ground truth (S2, S8).** Build RISC-Q's RTL with its own flow (mill + SpinalHDL) and
   simulate it with Verilator. A testbench runs an arbitrary RV32 ELF on the core and on the full
   `PulseTableSoc`. It records the cycle at which every instruction commits, every put leaves
   and arrives, and every pulse opens. This is the reference every model below is checked
   against.
2. **Cycle-accurate core in Lean (S2).** Replace the cost model with the pipeline:
   - fetch fork and join, and the 2-entry full-tag BTB with its cached GShare direction bit;
   - the 6-bit GShare;
   - the stage 4 resolve and stage 5 redirect with the flush of stages 0–4;
   - the interlock classes;
   - the load/store halt for the data-RAM round trip, and the 3-cycle multiply halt.

   **Check:** the commit cycle of every instruction equals the RTL simulation on RISC-Q's
   `rv32ui`/`rv32um` tests, on the Helios decoder image and on QuantumOS firmware.
3. **Hub, links and sinks against the RTL (S8).** Run QuantumOS firmware on `PulseTableSoc` in
   Verilator and compare every put arrival, barrier release and pulse opening with the Lean
   trace. The assumed latencies become measured ones or proved ones.
4. **The board as a chip (S1, S11).** A ZCU216 board model with the hard limits:
   - 16 DAC and 16 ADC tiles, and the core bands of the floorplan;
   - LUT, FF, BRAM, URAM and DSP use per core and per channel kind, from RISC-Q's synthesis
     results of record, cited per number.

   A design that does not fit is refused, as RISC-Q's build would refuse it. A twin larger than
   one board is split over several.
5. **Several boards (S9).** White Rabbit-synchronized boards with PutLane between their hubs.
   The latency of a put across boards comes from the RTL constants: 8b/10b at 1.25 Gb/s, frame
   length, PCS and FIFO stages, and the CDC. Syndrome bits that cross a board pay it, in the
   same run.
6. **The decoder service in the run (S3–S7).** A compiled decoder that outputs a correction. It
   runs on decoder cores in the same Lean run as the pulse cores, and its result goes back over
   the hub. Frame updates and conditioned gates read it. It is timed on syndromes sampled from
   the circuit with noise. Being built by the parallel session (qcontrolsys-7e,
   riscq/ftqvm/decode-service.mjs). It rests on items 2 and 5 for its timing.
7. **Optical actuators (S10).** The system-call engine for atoms and ions plays the same tone
   and electrode programs as riscq/platforms/neutral.mjs and qccd.mjs, at the board's real
   clock. Readout is modeled as the instrument the paper used (camera exposure, then readout of
   the image and its processing), with cited times.

## Status

| # | Status | Evidence |
|---|---|---|
| S1 | **placed on boards** | `riscq/board.mjs` states what one ZCU216 holds and reproduces both of RISC-Q's Vivado DSP records exactly (`tests/riscq-board.test.mjs`). Generated designs are now placed on as many boards as they need: transmon chips in site order (`riscq/ftqvm/sc-chip.mjs`; Willow d = 7 takes 19 boards, the DSP ceiling binding at about 5 qubit cores of 4 couplers each), optical controllers by `placeOnBoards` (cores sharing a DAC stay together; each board's logical converters take its 16 DACs and ADCs, summed past 16). `riscq/design.mjs` checks every board's cores, converter indices and DSP estimate. |
| S2 | **closed** | `QControl/RiscQ/Pipe.lean` replaces the cost model. Instruction by instruction, every commit equals RISC-Q's RTL in Verilator: 16 micro-benchmarks, the Helios decoder (274,388 instructions), `pulse_sched.elf`, `xcore.elf`, the feed-forward and repetition examples. |
| S3–S7 | in progress | Parallel session (decode service). It reads every time from the Lean run, so it inherits S2 and S8. |
| S8 | **closed** | The hub is modeled register by register from `PutHub.scala`, checked under contention (`validation/riscq/rtl/hub-rtl.mjs`). These latencies are measured on the RTL: the time register, the system-put path, hub delivery, the readout result path, halting reads. Each is stated in `riscq/soc.mjs` `model()`. |
| S9 | **modeled: two boards as RISC-Q's RTL, more as a stated extension** | Lean: one register-level hub per board; the lane is each hub's extra source, with the measured crossing, word-clock phase and frame time (`tests/riscq-multiboard.test.mjs` reproduces the RTL's 325–332, 160 and the barrier release). Still to do: a full two-SoC run on the RTL (two PulseTableSoc with the GTY simulation phy), and the designs placed on boards (S1). |
| S10 | open | |
| S11 | evidence gathered | See "Sizing a board" below. The board model built on it is next. |
| S12 | open | |
| S14 | open | |
| S15 | **enforced** | `riscq/design.mjs` refuses a core without exactly one demod channel, a converter index past 15, a converter on another board than its core, and a board past the DSP ceiling. Generated transmon designs read out one transmon per core (qubitsPerCore = 1); classical cores carry the unused demod channel RISC-Q builds into them, and board placement charges it. |
| S16 | **closed** | Part of S2: `fetchLatency = 4`, URAM, `aluNoFastForward`, the posted-store shim and the bus pipes are in the model. |

## What the RTL changed

Ground truth. RISC-Q at commit 243d814 is built with its own flow (JDK 21, mill 1.1.0, SpinalHDL from its submodule) and simulated in Verilator 5.054. `validation/riscq/rtl/rtl-setup.sh` sets this up without root. The harness `validation/riscq/rtl/QosRun.scala` loads QuantumOS's own program document into `PulseTableSoc`, as RISC-Q's CPU-in-the-loop simulations do. It records commits, pulse windows, host writes and hub traffic.

What was wrong, and what it is now:

| Quantity | Old model | RTL and new model |
|---|---|---|
| Dependent ALU instruction | 1 cycle | 2 (interlock on every 1-ahead dependency) |
| Load | 2 cycles | 6 |
| Taken branch | +5 every time | 10 when mispredicted, 0 when the 2-entry BTB predicts it |
| Straight-line code | 1 per cycle | 5 instructions per 6 cycles (instruction fetch takes 5 cycles; the fetch join is at stage 4) |
| Posted store | 2 cycles | 2 while the 4-entry buffer has room; then one per 6 cycles |
| Empty d = 3 Helios decode | 8,579 batches (17.2 µs) | 17,839 batches (35.7 µs) |
| A time register read | commit − link depth | the time of its data-bus request: commit − 5 |
| Barrier arrivals at the hub | 2 cycles apart | 3 (the hub holds an arrival while the previous one for the same barrier is written back) |
| Table-loop issue of one timed write | budgeted 32 cycles | 63 |

Consequences for QuantumOS's firmware generator (`riscq/firmware.mjs`). The generator scheduled writes against the old core, so on the real core pulses opened late. It now:

- uses issue costs measured on the RTL-exact model;
- adds the measured segment setup (64) to every time base;
- budgets the core time of decode, Pauli-frame and parity work;
- iterates its issue plan to a fixed point. A write the core must issue before a readout's halting read goes before it in the program, and each channel's FIFO timed queue receives its writes in start order.

Each of these was a real bug on the real core. The Google cultivation circuits (254, 1,039 and 1,254 operations) now run every operation inside its window.

## Sizing a board (S1, S11)

**Synthesis.** RISC-Q's 8-core x6y3 SoC was generated by its own `GenPulseTableSocJson` and synthesized with Yosys 0.71 (`synth_xilinx -family xcup`, `validation/riscq/rtl/synth.sh`). RISC-Q's UltraRAM template is a black box, one URAM288 per core. Against RISC-Q's Vivado result of record for the same build (vivado-scripts/riscvsoc-bd/README.md, 2026-09-15) on `xczu49dr` (425,280 LUT, 850,560 FF, 1,080 RAMB36, 80 URAM288, 4,272 DSP48E2):

| Resource | Yosys | Vivado | Use for the board model |
|---|---|---|---|
| RAMB36 | 196 (18.1 %) | 18 % | Yosys (same) |
| URAM288 | 8 (10 %) | 10 % | Yosys (same) |
| DSP48E2 | 1,880 (44 %) | 38 % | Vivado; Yosys is 16 % high (it does not pack as `ComplexMul` intends) |
| LUT | 248,221 (58 %) | 29 % | Vivado; Yosys maps adders to CARRY4 chains and keeps 31 k inverters and 51 k SRL16E |
| FF | 314,538 (37 %) | 27 % | Vivado; no retiming or register merging |

**Limits of one ZCU216 board, from RISC-Q's records:**
- **Cores.** The floorplan pins cores to the X0 column, rows Y3–Y7, three per row (`pblocks-bd.tcl`). The 14-core build closes timing only after an incremental pass.
- **DSP.** 8 cores take 1,623 DSP48E2 (38 %) and 14 take 2,786 (docs/dsp/DSP48.md). That is about 194 per qubit core (gate, readout and demod channels) and about 72 shared. RISC-Q states 65 % as the point where Vivado demotes multiplies to fabric and the build collapses; 2,786 is that point.
- **Converters.** 16 RF-DAC and 16 RF-ADC.
- **Demodulation.** Exactly one demod channel per core.

A design that needs more than this does not fit one board. It must be split over several, as S9 describes.

**What the reproduction twins need** (`boardsNeeded`, a lower bound):

| Twin | Cores modeled on one board | Boards needed, at least | Binding limit |
|---|---|---|---|
| Google Willow, d = 3–7 (two transmons per core) | 54 | 18 | DSP: about 250 DSP48E2 per transmon for its drive, CZ and readout pulse channels |
| Quantinuum H2, 56 qubits | 53 | 5 | DSP |
| Bluvstein et al. 2024 | 23 | 2 | cores |

The runs on the /reproduce pages still put these cores on one board. Their timing inside a core and through the hub is RTL-exact. What is missing is the latency of the boards between them: a publish or barrier that crosses boards goes over PutLane on the White Rabbit GTY lane (S9). Until S9 is modeled, every reproduction states that it needs these boards and does not yet model them.

## Between boards (S9): measured on RISC-Q's RTL

`validation/riscq/rtl/QosLaneTiming.scala` builds two PutHubs joined by two PutLanes (the White Rabbit TX/RX PCS pairs), as RISC-Q's own `PutLaneSim` does. It clocks them as on the board: dspClk 500 MHz, and the lane's word clock 62.5 MHz (20-bit words at 1.25 Gb/s). Latencies are in dspClk cycles, counted from the put entering its source hub. L is the serial line's delay in word clocks (16 ns each).

| Message | Same board | Other board (L = 3) | Other board (L = 13) |
|---|---|---|---|
| Publish of a shared bit | 8 | 332 | 412 |
| Unicast to a mailbox | — | 331 | 411 |
| Barrier, last arrival on the far board: release at the root | — | 329 | 409 |
| Same barrier: release back on the far board | — | 649 | 809 |

One crossing costs 308 + 8·L cycles. The 308 is RISC-Q's RTL: packing the 72-bit frame into 11 bytes, 8b/10b and the PCS, a receive that delivers only CRC-good whole frames, and a clock-crossing FIFO at each end. L is the GTY transceivers' TX and RX latency plus the cable or fiber. These are not in RISC-Q's RTL, so they must come from the transceiver user guide (UG578) and the cable length (about 5 ns/m). L = 3 is the stand-in of RISC-Q's own simulation, not a hardware value.

**Throughput.** Twelve publishes from board 1, offered one per cycle, arrive on board 0 exactly 160 dspClk cycles (20 word clocks, 320 ns) apart. The lane carries 3.1 M put frames per second per direction. RISC-Q's PutLane.md states about 10 M frames/s; its RTL carries a third of that. A burst of syndrome bits crossing boards is therefore bound by the lane, not by the hub, which takes one per cycle.

**Topology.** RISC-Q's put network joins exactly two boards. Each hub has one lane (`laneIn`/`laneOut`), and a frame that arrives from the lane is never forwarded on (`fwd.valid := !fromLane`). A release frame is applied by its receiver without checking its destination board. `PutHub` accepts `boards ≤ 16`, but with one point-to-point lane only two boards are consistent. A machine that needs more boards, as every reproduction twin does (5 to 18), needs a network RISC-Q does not have: a root that forwards between several lanes, or a switch, and a board check on release frames. That is a design QuantumOS must state as its own extension, with its latency derived from the measured crossing (each extra hop is another crossing). It is not RISC-Q's.

What this means: a syndrome bit that crosses a board takes at least 616 ns more than one that does not. A barrier that spans boards takes at least 1.3 µs. The board-local hub takes 8 cycles (16 ns). How the cores of a twin are spread over boards therefore enters every decode and feedback latency. Next, the Lean model gets one hub per board and the lane between them.

**In the Lean model** (`QControl/RiscQ/Soc.lean`; `riscq/soc.mjs` `model()`):

- A core's `board` places it. Each board has its own register-level hub. Board 0 counts barriers and sends one release frame per remote board while its arbiter is held, as `rel.busy` does in the RTL.
- A frame dispatched at cycle `d` reaches the far hub's lane input at the first cycle ≥ `d + 310 + 8·(L − 3)` on the lane's word-clock phase. That phase is fixed at power-up and arbitrary; `lanePhase` chooses it. The frame also arrives at least 160 cycles after the lane's previous frame, and enters the far hub as one more round-robin source with an 8-deep FIFO.
- Measured at a 500 MHz dspClk only. A multi-board build at another clock is refused until it is measured there.
- More than two boards is QuantumOS's extension: board 0 has a lane to every other board and forwards between them, and every frame between two non-root boards crosses twice.

**Optical controllers at 500 MHz** (S10, partly): `riscq/ftqvm/optical.mjs` ran its controllers at an unsourced 100 MHz. They now run at RISC-Q's 500 MHz dspClk, the clock every RTL measurement here uses and the only one the lane is measured at. At 100 MHz the lane's 16 ns word would be 1.6 cycles.

- A native longer than one pulse-table entry is played as consecutive entries. A duration is 16 bits: 65,535 cycles, 131 µs.
- the resource VM issues the gates of one layer 1 ns apart. A global beam (Rydberg, Raman, pumping) is one pulse for the whole layer. A gate shares the pulse of its kind that started at most 10 ns before it (`GLOBAL_LEAD_NS`, one batch of the old 100 MHz controller, which shared within a batch) and ends inside its window. The run reports the worst early start as `globalEarlyNs`. Conformance checks ends, not starts.

**Barriers across boards** (`riscq/firmware.mjs` `remoteReleaseLead`): a release carries the root's stamp but reaches the i-th remote board `1 + i + laneCross + (laneWord − 1) + 7` cycles after the root dispatches it, after at most one grant per other source at that hub. Every member of a barrier shares one time base, so a multi-board segment starts that much later, about 0.7 µs at L = 3.

**More than two boards: one receive FIFO per lane.** In QuantumOS's star, board 0's hub has one source per remote board. Each is a separate PutLane with its own 8-deep receive FIFO (`Program.hubLanes` and `laneSource` in `QControl/RiscQ/Soc.lean`). Until 2026-11-25 every lane into board 0 shared one FIFO. On Willow d = 7 (19 boards) the start barrier's arrivals overflowed it, frames were dropped, and the barrier never released. `tests/riscq-multiboard.test.mjs` now runs a barrier across 18 boards with no drops. Two boards, RISC-Q's RTL, are unchanged.

**Run budgets.** The optical runs at 500 MHz last up to 10⁹ cycles. Each run now sets its budget to its own span twice over plus 20 ms, where the default of 10⁸ cycles had stopped long runs early ("time limit").

**Couplers past a core's nodes.** A transmon core has 16 put-window nodes. Gate, readout and demod leave 13 for CZ channels. A site with more couplers (lattice surgery on bell-d5 gives one 17) packs couplers that share a CZ carrier into one channel, one pulse-table entry each (`riscq/ftqvm/sc-chip.mjs` `czChannelsOf`).

**Frames ahead of a release.** The release bound above assumes the lane is idle when the root sends the release. A lane carries one frame per 160 cycles, so a frame still queued on it delays the release by one frame time. On Besedin's circuit the decoder publishes its result just before the barrier. A remote board received the release 425 cycles after the root, against a lead of about 340, and three conditioned pulses had their amplitude and phase land 6–7 cycles after their envelope. `riscq/compile.mjs` now counts the shared bits each segment publishes, and `riscq/firmware.mjs` `laneBacklogLead` adds one frame time per bit to the next segment's lead. A frame from an earlier segment went ahead of the previous release, so it is not counted. `tests/riscq-studio-reproductions.test.mjs` runs that circuit with no fault.

**A twin is a design a person can build.**
- The hardware editor (`/riscq-design`) places every core, DAC and ADC on a board (`board`). Converter indices count per board, 0–15.
- A board shows what it carries against a ZCU216: cores of 14, RF-DACs and RF-ADCs of 16, DSP48E2 of 2,786. The editor imports these limits from `riscq/board.mjs`, the module the design rules use.
- The qubit macro fills the first board with room, DSP slices included. A two-board design built with the editor's own operations passes every rule and runs with no fault.
- The 3D control view draws the RF-DACs and RF-ADCs each channel names, and their cables to the qubits. A readout DAC has eight lines.
- "Edit this hardware" on a reproduced paper reruns the paper's own compiled program on the edited chip (`riscq/ftqvm/studio-capture.mjs` `designOverride`).
- Still not editable by hand: the neutral-atom and trapped-ion controllers, which `riscq/ftqvm/optical.mjs` builds in code (S10).

**Folded rounds.** A RISC-Q core's RAM is 64 KiB: the host maps each core into a 64 KiB window (`coreStride = 1 << 16` in RISC-Q's SocSpec). A long program's firmware therefore cannot hold one block of code per pulse. A core whose program does not fit is compiled again with its repeating rounds folded (`riscq/firmware.mjs` `foldRuns`, `riscq/compile.mjs` `assemble`):

- A run of rounds that are identical up to a shift in time P and in bit slots B is one copy of the round's inline code inside a counted loop. Each pass advances the time base `s0` by P and the bit bases `s2` and `s11` by B.
- Phase offsets, which the virtual-Z frame changes every round, are read from a per-round table.
- A round is folded only where the schedule leaves room for the loop step at its end (`FOLD_OVERHEAD`).
- The cores run the same instructions as unfolded firmware, so they keep inline speed.

Results:

- Google's d = 7 memory folded: 133,415 words fall to 31,537, and the largest core from 2,266 to 645. No faults, every operation in its window.
- Google's d = 3 memory folded plays the same pulses at the same times, with the same phases, amplitudes and bits (`tests/riscq-compact.test.mjs`).
- Programs that fit are compiled exactly as before.
- A schedule with no repeating rounds, such as H2's transport on a single core, still does not fit, and the assembler says so.
