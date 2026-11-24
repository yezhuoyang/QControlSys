# RISC-Q controller model and the three lowering paths

This part of QuantumOS takes a program for a quantum computer down to the machine code of its control processors and executes that machine code in a Lean model of the controller. It covers superconducting qubits, trapped-ion QCCD machines and neutral-atom arrays with one controller design, [RISC-Q](https://github.com/Wu-Quantum-Application-System-Group/RISC-Q). No quantum state is simulated. Measurement results are inputs.

## Run it

```sh
npm ci
lake build
node riscq/cli.mjs --list
node riscq/cli.mjs --example superconducting-feedforward --outcome c=1 --out run.json
node riscq/cli.mjs --verify run.json
node riscq/cli.mjs --qasm circuit.qasm                      # transmon ring
node riscq/cli.mjs --qasm circuit.qasm --platform qccd      # QCCD Studio compiler, H2 machine
node riscq/cli.mjs --example superconducting-repetition --outcome s0=1   # system calls with a decoder core
node riscq/cli.mjs --calls program.json                     # your own system-call program
npm start        # then open http://127.0.0.1:7432/riscq
```

`--out` saves the source, the hardware instructions, firmware statistics, the Lean program, every trace frame and the summary. `--verify` re-executes the saved program in Lean and names the first frame that differs. The server offers the same runs at `GET /api/riscq/examples` and `GET /api/riscq/run?example=<id>&outcome=c=1`, and compiles OpenQASM sent to `POST /api/riscq/run` as `{"platform":"superconducting","qasm":"…","outcomes":{"c":1}}` or with `"platform":"qccd"`. A system-call program goes to the same address as `{"platform":"superconducting","calls":{…}}`. The QCCD paths need Python and the QCCD Studio checkout in the sibling directory `QCCD`. The exit code of the CLI is 2 when a run reports a fault.

## From a program to machine code

Each platform has three levels below the source program. A hardware instruction is one physical operation with a start time and a duration. A channel action is one timed register write on one control core. The firmware is the RV32I program that issues those writes.

| Platform | Source | Hardware instructions | What a control core drives |
| --- | --- | --- | --- |
| Superconducting | OpenQASM 3 | `x90`, `x`, `frame` (virtual Z), `cz`, `measure`, scheduled as soon as their qubits are free | One core per qubit: a drive channel, one more drive channel per CZ partner, a readout tone and a demodulation window |
| Trapped-ion QCCD | OpenQASM compiled by [QCCD Studio](https://github.com/yezhuoyang/QCCD/tree/compiler), or a Studio TSIR program or design | The cycles of Studio's own replay: `transport`, `rotate`, `ms`, `measure`, `cool`, `frame` | Transport cores with one DAC channel per Studio electrode control channel. One core per gate zone with three laser modulators and a photon counter. One core for broadcast light |
| Neutral atoms | A compiled [ZAC](https://github.com/UCLA-VAST/ZAC) program | `pickup`, `move`, `drop`, `raman`, `rydberg`, at ZAC's times | One core per AOD with one RF tone channel per row and column. One laser core |

[Superconducting lowering](../riscq/platforms/superconducting.mjs) · [QCCD lowering](../riscq/platforms/qccd.mjs) · [Neutral-atom lowering](../riscq/platforms/neutral.mjs) · [Firmware generation](../riscq/firmware.mjs) · [Assembler](../riscq/rv32.mjs)

**Superconducting.** The machine is the eight-transmon ring of RISC-Q's example calibration on the RISC-Q `x6y3` build: 500 MHz dspClk, 8 GS/s DAC, 2 GS/s ADC. Durations, amplitudes, frequencies and phases come from that calibration: 35 ns and 70 ns drive pulses, a 400 ns CZ played as one tone on each qubit's drive line, and a readout tone followed by a demodulation window. [Extracted calibration](../validation/riscq/x6y3-calibration.json) · [Extraction script](../validation/riscq/extract_calibration.py). Standard gates decompose into `x90`, `x` and frame updates. A measurement whose bit conditions a later gate ends a segment. The measuring core publishes the bit through the board hub, all cores meet at a barrier, and the conditioned gate runs in the next segment.

**System calls on the transmon ring.** A program can also be a list of the virtual machine's system calls on physical qubits: `gate`, `measure`, `decode_syndrome` and `pauli_frame_update`. The build then has one more RISC-Q core, the decoder. The measuring cores publish their bits through the hub. After the cores have met at a barrier, the decoder reads the syndrome as one field of the shared word, looks the correction up in a table in its RAM, stores the decoded bits and publishes those that condition a gate. A frame update flips bits of a qubit's frame word in the decoder's RAM and reports the word to the host. It plays no pulse. A gate conditioned on a decoded bit runs after one more barrier. `request_ancilla`, `route` and `request_magic` are rejected on this machine: its calibration has no reset pulse, its couplers are fixed, and it has no factory. [Example program](../riscq/examples.mjs) · [Tests](../tests/riscq-decode.test.mjs)

**Trapped ions.** QCCD Studio already states, for every cycle, which ions move over which edges and which electrode control channels act. The lowering plays one waveform per engaged control channel, sets the angle and phase of each gate pulse from the TSIR parameters, and fires one detection pulse per gate zone. Each ion in the zone has its own photon-counter line, and one firmware loop counts the rising edges on those lines during the pulse. An OpenQASM circuit reaches this path through Studio's compiler ([bridge](../bridge/qccd_compile.py)). The full H2 GHZ program, 947 Studio cycles and 32 measurements, runs on eight cores.

**Neutral atoms.** Each active AOD tone ramps its RF amplitude up at pickup, holds it during the move and ramps it down at drop. During the move its frequency steps every 2 µs along the path. The position of a tone is read back from the carrier updates in the trace through the same linear calibration that produced them.

## The controller

One core runs one RV32I program from its own RAM. A store into the put window becomes a posted register write. The write crosses a pipelined link to one channel next to the converters. The channel holds a pulse table, a start time and timed queues. Writing a slot number to `fire` schedules that table entry at the current start time. The queues release each parameter early by exactly its pipeline latency, so the pulse opens at the converter on the scheduled batch. Reports travel back to core-local sinks. A board hub gives the cores shared bits, counted barriers that return one common time, and mailboxes. Every message to the hub waits in a queue of eight per core, and a round-robin arbiter passes one message per batch for the whole board. A barrier arrival directly behind another for the same barrier waits one more batch. A message into a full queue is dropped and reported as a fault.

One batch is one dspClk cycle. It carries 16 DAC samples or 4 ADC samples. All times in the model are whole batches. `atPs = atBatch × dspPeriodPs`.

| Register (core address) | Behaviour | RISC-Q source |
| --- | --- | --- |
| `time` 0xBFF8 | Batch time. The core's copy lags the converter edge by the link | `ControlMemMaps.scala` |
| `timeCmp` 0x4000, `waitTimeCmp` 0x4008 | A read of `waitTimeCmp` stalls the core until `time + 3 ≥ timeCmp` | `ControlMemMaps.scala` |
| `done` 0x4010 | Sticky completion flag | `ControlMemMaps.scala` |
| Sinks from 0x4200, 0x20 apart | Readout result (`res` stalls until settled, `real`, `imag`) or an input-edge queue (`pop`, `time`, `seq`, `count`) | `EventLink.scala` |
| `board` 0x4300, `release` 0x4320, mailboxes 0x4340 | Shared group words, barrier release time, unicast words | `PutHub.scala` |
| Put window from 0x10000, 0x10000 per node | Nodes 0–15 are the core's channels. Higher nodes reach the hub | `map.py` |
| Channel: `fire` +0, `freq` +4, `dcOffset` +8, `phaseOffset` +0xC, entry *i* at (*i*+1)·16, `startTime` +0x4100 | 16-bit fields sit in bits 31:16 of the written word | `PulseParamBuffer.scala` |
| Host window from 0x40000000 | Write only. Results for the host | `HostWindow.md` |

| Latency in batches | Value | Basis |
| --- | --- | --- |
| Store to channel | 1 + link depth | `PutBridge.md`, `PutLink.md` |
| Fire to queue push | 2 | `PulseParamBuffer.md` |
| Queue push to earliest pop, pops apart | 3, 2 | `TimedQueue.scala`, RegHead implementation |
| Parameter leads: amplitude, phase, envelope address, duration | 34, 35, 11, 2 | Derived in Lean from the block latencies of `PulseGenerator.md` |
| Carrier update leads: carrier, phasors | 36, lanes + 36 | Same derivation. Phasors regenerate serially |
| Generator to DAC port | adder tree + 2 | `map.py` `dac_pipe` |
| Decoder | 9 | `ReadoutDecoder.md` |
| Publish to every core's board | 3 × link depth + 11: 23 at link depth 4 (RISC-Q's figure), 17 on the x6y3 ring (depth 2), plus the wait at the arbiter | `PutHub.md` |
| Hub throughput, queue per core | 1 message per batch, 8 | `PutHub.md` |
| Sink queue depth | 8 | `EventLink.md` |
| Core time lag | link depth | Assumed. RISC-Q states a constant lag without a number |
| Report to sink | 3 + 2 + link depth + 1 | Assumed worst case of the stages in `EventLink.md` |
| Taken branch or jump, load or store | +5, +1 | Assumed upper bound from the pipeline stages in `RISCV.md`, and `LsuPlugin.md` |

[Lean model](../QControl/RiscQ/Soc.lean) · [Timing contracts and proofs](../QControl/RiscQ/Timing.lean) · [RV32I semantics](../QControl/RiscQ/Rv32.lean) · [Address map and latency parameters](../riscq/soc.mjs)

**Firmware.** A program is a sequence of segments. A segment starts when all active cores meet at a barrier, which gives them one time base. Each timed write is issued 96 batches before its start time, the lead RISC-Q's own software uses. A segment of plain timed writes is issued by a loop over a four-word table: issue time, start time, register address, data. A core issues one write at a time, so a burst of simultaneous writes is issued earlier, and the whole segment starts later when the burst is wider than the lead allows. A channel's queues hold one entry more than the build's queue depth, five on the default build. The compiler rejects a schedule that would overflow them.

**Trace.** Every event is one frame with a stable ID, the part it acts on, the parts it targets, its causal parents, the firmware address and source operation that caused it, and the committed state of its part. Parts and links form a schematic floorplan after RISC-Q's two-region layout, in tenths of a clock region. They are not physical dimensions. At equal batches, converter-edge and link events apply before a core acts, and cores act in index order. A core frame carries the register it wrote, so the register file is rebuilt by replaying frames. With `--trace io` only instructions that touch a control register are recorded.

## A compiled decoder on a control core

The decoder of the examples above is a lookup table. A real one runs too. [Helios](https://github.com/NamiLiy/Helios_scalable_QEC) is the FPGA union-find decoder that the RISC-Q group's QEC system uses ([Liu et al., arXiv:2603.16203](https://arxiv.org/abs/2603.16203)). Its repository carries a C program, `software_code/union_find.c`, that computes what the hardware computes and that its test benches are checked against. That file is compiled here, changed only in its distance constant, with clang for `rv32i_zmmul` and RISC-Q's own `start.S`, `muldiv.c`, `riscq.h` and linker layout. The image runs on a RISC-Q core in the Lean model. A small file layer feeds it syndromes from RAM and stores each output line as one word in the host window.

```sh
node riscq/cli.mjs --example decoder-helios-d3        # also decoder-helios-d5
node validation/decoders/helios/make-reference.mjs    # rebuild references and images (needs gcc and clang)
```

| Distance (rounds) | Nodes | Decode time in the model | Checked against |
| --- | --- | --- | --- |
| 3 (3) | 12 | 17 µs with no defect, 34 µs to 58 µs with defects | Helios's own test vectors and the natively compiled program: 14 of 14 syndromes |
| 5 (5) | 60 | 94 µs to 285 µs | the natively compiled program: 9 of 9 |
| 7 (7) | 168 | 274 µs to 813 µs | the natively compiled program: 7 of 7 |

For comparison, the same algorithm in FPGA logic is reported at 56 ns for a worst-case distance-3 pattern, and 65 ns and 90 ns on average at distances 5 and 7 for p = 0.001 (arXiv:2603.16203). The compiled program is a reference model that visits every edge on every pass, and it runs here on a soft core with the assumed cost of one batch per instruction. The comparison shows what decoding in control-core software costs, not what Helios costs. The program reports the root node of every node. It does not derive a correction, so it is not yet wired to `decode_syndrome` on a machine: the eight-transmon ring is too small for a surface code. Micro Blossom's embedded MWPM firmware targets `riscv32i` too, but needs its accelerator in the FPGA fabric, which this model does not have.

[Build flow](../riscq/toolchain.mjs) · [Decoder module](../riscq/decoders/helios.mjs) · [File layer](../riscq/decoders/libc/rq_libc.c) · [Vendored source, vectors and images](../validation/decoders/helios/) · [Tests](../tests/riscq-helios.test.mjs)

## Hardware designs

A pulse-controlled machine can be given as a document instead of code: a control board, cores, DACs, ADCs, qubits, resonators and passive stages with positions in mm, the channels of each core, wires with a medium and a routed path, and the calibrated pulses of each qubit and coupling. The simulator checks it against rules and derives the build, the pulse tables and every propagation delay from it. A wire's delay is its routed length over the signal speed of its medium, so where a board stands and how a cable runs changes when a pulse arrives.

```sh
node riscq/cli.mjs --ring-design > machine.json                 # the built-in ring as an editable design
node riscq/cli.mjs --design machine.json --qasm circuit.qasm    # run a program on your design
```

- **Rules.** One board. 1 to 64 cores, 1 to 16 channels each. A pulse channel names a DAC and a demodulation channel an ADC. Every wire starts and ends at its parts. Every calibrated pulse has a wired path from its converter to the part it acts on, and every resonator a path back to its ADC. A readout whose tone returns after the acquisition window opens is reported as a warning.
- **Checked.** The ring written as a design plays exactly the pulses of the built-in ring. Moving the chip 2 m farther delays every arrival by 10 ns and changes nothing at the converters. Driving three qubits from one core runs the feed-forward program without any message through the hub.
- **Boundary.** This covers machines whose gates are pulses on fixed qubits. The ion and atom machines still take their control hardware from code. Loss, dispersion, crosstalk and the placement of logic inside the FPGA are not modeled. The posted-link depth is one number for the board.

[Design format, rules and the ring as a design](../riscq/design.mjs) · [Tests](../tests/riscq-design.test.mjs)

## Standard values

Where a program or calibration does not state a physical parameter, the model uses a published value. Each is listed with its source in [riscq/standards.mjs](../riscq/standards.mjs), every platform accepts overrides, and a run names the values it used in `machine.provenance`.

| Parameter | Value | Source |
| --- | --- | --- |
| Ion shuttle, per Studio time unit | 58 µs plus 10% | Pino et al., Nature 592, 209 (2021), Table II |
| Ion rotation, two-qubit gate, detection, Doppler cooling | 5 µs, 25 µs, 120 µs, 550 µs | Pino et al., Table III |
| Bright ion, threshold | 10 photons per window, bright above 1 | Composite: Wright et al. 2019, Egan et al. 2021 |
| AOD scale | 188 kHz per µm | Endres et al., Science 354, 1024 (2016), derived |
| AOD acoustic response | 6.2 µs | Derived: 4 mm beam at 650 m/s |
| Atom moves, transfers, Rydberg pulse | from the ZAC program | Lin, Tan, Cong, HPCA 2025 |
| Coax, fibre, free space | 200, 204, 299.79 mm/ns | [machine/interconnect.mjs](../machine/interconnect.mjs) |

A Studio design that states its own times in µs keeps them. The H2 program reports unit times, so it takes the values above.

## Step through a run

The page at `/riscq` loads a run and steps through its frames. It offers the reference programs, compiles OpenQASM typed into it for the transmon ring or the ion machine, and opens a run saved by the CLI with `--out`.

- **Controller scene.** One 3D part for each core, posted link, inbox, channel, converter, the board hub, the host and every bound apparatus part. The acting part, its targets and the causal path back to the core instruction are lit at each step, and open pulse windows stay lit while they are open. Selecting a part shows its state and steps between its frames.
- **Step inspector.** The frame, its time in batches and seconds, the firmware address and disassembly, the hardware instruction and source line it came from, its causes and the state it committed.
- **Machine state.** Pulse tables, start times, carriers, queues, sinks, hub groups and registers at the current step, rebuilt from the frames up to that step and from nothing else. With the `io` trace the page marks registers that no recorded frame wrote.
- **Channel timeline.** Every pulse window, carrier update and digital update of the run. Late, misaligned or overlapping pulses and the fault list are drawn in red.
- **Apparatus view.** Ions by trap site as transport cycles complete, AOD tone positions in µm from the carrier updates, or the qubits and resonators a pulse has reached.

[State reconstruction](../studio/riscq-model.js) · [Its tests](../tests/riscq-debugger.test.mjs) · [Page](../studio/riscq.js)

The [RISC-Q workspace](riscq-workspace.md) at `/riscq-studio` shows the apparatus in physical layout beside the program layers. Its **Play** advances the batch time continuously by default (*Whole run in 30 s*), so an ion is drawn partway along its segment and an atom partway along its move between trace steps. Step playback (*25 steps/s* and so on) jumps from step to step: a 64 µs shuttle covers few trace steps, so it shows the ion jumping between sites.

The tests replay runs and require the state the page rebuilds at the last frame to equal the summary Lean computes from its own state, a state asked for out of order to equal a replay from reset, every frame to act on a part of the scene, every chain of causes to end at a core instruction, and no two parts to share a position. The page itself was exercised with scripted checks in headless Chrome. The controller scene is a schematic floorplan. The physical 3D installations of the three machines on the machine workbench are not yet driven by these runs.

## What is proved, what is tested, what is assumed

**Proved in Lean, about the model.**

| Theorem | Statement |
| --- | --- |
| `land_exact` | If a write is ready no later than its lead before the start time, the parameter lands exactly when the batch-time register reads the start time |
| `land_independent_of_arrival` | Two writes that both meet the margin land on the same batch, whatever link latency separates them |
| `land_late` | A write that misses the margin lands late by exactly the amount it missed |
| `popCycle_ge_push`, `popCycle_spacing` | A queue entry pops at least 3 batches after its push and at least 2 after the previous pop |
| `default_leads` | The leads derived from the block latencies equal 34, 35, 36, 52, 11 and 2 |
| `fire_fire_contiguous` | A second fire is scheduled exactly one duration after the first |
| `explicit_start_wins` | Writing `startTime` after a fire discards the automatic advance |
| `fire_preserves_table`, `decode_layout` | A fire changes no table entry. The register addresses firmware writes decode to the intended fields |
| `readRam_writeRam_word` | A word read returns what a word write stored |
| `nextSource_waiting`, `nextSource_isSome` | The hub arbiter grants only a core that has a message waiting, and grants one in every batch in which any core has |
| `Cpu.setReg_zero`, `exec_selfJump_pc` | Register x0 is never written. A jump to itself is a fixed point |

**Conformance tests, against RISC-Q artifacts.** Three firmware binaries from the RISC-Q repository run unmodified and reproduce what RISC-Q's RTL simulations assert: `pulse_sched.elf` opens one gate pulse on DAC 8 exactly at its start time for six batches. `xcore.elf` gives both cores the same barrier time, delivers the word 0x77 to core 1's mailbox, opens core 1's pulse at that time plus 1024 and leaves core 0 silent. `host_window.elf` writes its ramp, byte lanes and sentinel and raises `done`. A publish reaches every board after 23 batches, as RISC-Q documents. The hub arbiter follows the statements of RISC-Q's `PutHub.md`, not an RTL trace: eight simultaneous bits reach every board after 23 to 30 batches in core order, eight simultaneous barrier arrivals are counted two batches apart, and eight cores that publish without pause overflow their queues. [Hub tests](../tests/riscq-limits.test.mjs) [Firmware conformance](../tests/riscq-firmware.test.mjs) · [Vendored binaries and license](../validation/riscq/firmware/)

**Conformance tests, against independent references.** Arithmetic, shifts, comparisons, multiplies, loads, stores, branches and links are checked against values computed outside the model, and every word the assembler emits is decoded by Lean as the same instruction. Gate decompositions are checked as 2×2 matrices up to a global phase. [Instruction semantics](../tests/riscq-rv32.test.mjs) · [Superconducting path](../tests/riscq-superconducting.test.mjs) · [QCCD path](../tests/riscq-qccd.test.mjs) · [Neutral-atom path](../tests/riscq-neutral.test.mjs)

**Assumed or schematic.** The three assumed latencies in the table above. The arbiter starts its round at core 0 and is modeled at the dispatch stage. The cost model of the core: one batch per instruction plus the two penalties. Pulse timing does not depend on it while the lead margin holds, which is what `land_exact` states. Decode times do depend on it. The controller floorplan positions. The mapping of one Studio time unit to one shuttle. The path inside a neutral-atom move. The positions of the ring written as a hardware design.

**Not modeled.** Carrier synthesis is represented by its latency. A pulse frame reports the scheduled codes, and a waveform is drawn from them for display. Electrode voltages, ion motion and heating remain QCCD Studio's models. A frequency step is not phase continuous on the RISC-Q generator. The two ring pairs whose CZ needs a pulse on the second excited level are not offered. Multi-board operation over White Rabbit, interrupts and CSRs are absent.

## First system-call measurements

The companion paper models each service of a fault-tolerant computer by one latency and one capacity. [These measurements](../riscq/syscalls.mjs) read the corresponding costs from controller runs. [Tests](../tests/riscq-syscalls.test.mjs)

| Quantity | Run | Result |
| --- | --- | --- |
| Route latency | ZAC 14-qubit program, 26 rearrangement jobs | 90.5 µs to 145.1 µs, median 101.2 µs. One declared latency of 145.1 µs overcharges the median route by 43% |
| Route latency | Studio rotation, 4 cycles of 24 control channels | 5 µs per cycle. Issuing the 24 simultaneous waveforms delays the segment by 2.24 µs |
| Feedback | Transmon ring, measured bit conditions an X on another core | Result at the measuring core 34 ns after the window closes, at the hub 70 ns, at every core 86 ns, conditioned pulse 344 ns |
| Issue rate | Table loop at 100 MHz | At most 29 posted writes per µs per core, two per timed write |
| Program memory | H2 GHZ program | 4 words per timed write. 16 control channels on one core need 16,577 words and the core RAM holds 16,064 |
| Gate concurrency | *n* pulses on one batch from one core, 100 MHz | All open on the same batch after (*n* − 1) · 32 batches of preroll: 480 batches for 16 pulses |
| Pulse rate | Back-to-back train of 60 pulses on one channel | Shortest pulse 48, 31, 29 and 16 batches at queue depth 1, 4, 8 and 32 |
| Link depth | One pulse issued 96 batches ahead | On time up to 13 link stages. At 14 the phase lands late while the window still opens. This depends on the assumed core time lag |
| Classical bandwidth of the hub | *n* cores publish one bit on the same batch, 500 MHz | One bit per batch for the whole board: 500 bits/µs. Bit *k* reaches every core after 23 + *k* batches. One core offers a bit every 4 batches, so four cores fill the hub and eight overflow its queues |
| Barrier | *n* cores arrive on the same batch | Every core holds the common time after 23 + 2 · (*n* − 1) batches at link depth 4: 37 batches for 8 cores, which is 74 ns at a 500 MHz clock and 370 ns at 100 MHz |
| Syndrome to decoder | Repetition-code round, 2 syndrome bits | The last bit is in the decoder's board register 86 ns after its window closes. The same 86 ns holds for 8 bits here, because this ring's readout windows end at different times |
| Decode | Lookup decoder on a RISC-Q core | The decoder has met the other cores and reads the syndrome at 112 ns. The lookup and stores take 14 ns plus 14 ns per decoded bit, and 8 ns more for each decoded bit that is published to another core: 64 ns for three bits with one published, decoded at 176 ns |
| Pauli-frame update | Frame word in the decoder's RAM, no pulse | The first update is stored 22 ns after the decode, the second 16 ns later |
| Feed-forward through the decoder | X on a data qubit conditioned on a decoded bit | The decoded bit is at every core at 196 ns and the pulse opens at 490 ns. A pulse conditioned directly on a measured bit opens at 344 ns |

[Limit sweeps](../riscq/limits.mjs) · [Their tests](../tests/riscq-limits.test.mjs)

These are costs of the classical controller and of the scheduled operations in the model. They are not measurements of hardware, and they say nothing about gate fidelity. The decoder here is firmware on a soft core, with the assumed cost of one batch per instruction. A decoder in dedicated logic would have other numbers. The hub carries one bit per message, so syndrome traffic at the rate the paper's factory model needs (132,496 bits/µs) would need a wider path than this hub.

## What comes next

1. Realize the remaining system calls: `request_ancilla` as an active reset, `route` as one call on the ion and atom machines, and `request_magic`. Accept the paper's program text as well as the JSON form.
2. Compare the measured decode and frame-update times with the declared `decoder_bandwidth`, `decoder_latency_ns` and `pauli_frame_update_ns` of the paper's machines. Add a decoder for a code with more than one round, and a variant that decodes on a fixed deadline without the second barrier.
3. Sweep machine parameters (link depth, queue depth, channels per core, clock) and report where a schedule stops fitting.
4. Give the ion and atom machines their control hardware from a hardware design too, and let a design state its own transport and gate durations.
5. Compile OpenQASM through the ZAC compiler as well, and add routing for the transmon ring.
