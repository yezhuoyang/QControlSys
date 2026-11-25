# From FormalRV system calls to simulated machines: plan

**Goal.** QuantumOS implements, on simulated superconducting, trapped-ion QCCD and neutral-atom machines, everything a FormalRV `.sysprog` listing needs. It derives from those machines the **system specification** FormalRV takes as input: a `.machine` file and a `.sysspec` file. It then runs FormalRV's own compiled listings on the machines and checks, operation by operation, that the hardware keeps the specification.

The checked results go to the FTQVM paper (`OSDI2027FTVM`, §5.2, "Results pending"):
- how well one latency and one capacity per service describe real control;
- where a derived specification is loose or cannot be met.

**Ground rules** (owner decisions, 2026-11-24):
1. FormalRV is used unchanged: its language, compiler, VM and machine format. QuantumOS adapts to it.
2. The VM is not modified. We supply system specifications. Any mismatch is reported as a property of the specification, not fixed in the VM.
3. The decoder latency is not assumed. The decoder is compiled to the control system's virtual FPGA (RISC-Q cores) and measured.
4. Where no measurement of ours exists, a value from the literature is used and cited, and can be replaced later (`riscq/standards.mjs`).

**Horizon.** 8 weeks, 2026-11-24 → about 2027-01-19, then writing. The aim is a credible §5.2, not a complete solution.

---

## 1. What the study found

### 1.1 FormalRV's system layer, as it is

- **A `.sysprog` instruction acts on physical qubits.** `data[9*a + j]` is qubit j of block a. Rounds and lattice surgery are written out as H, CZ, CNOT and measure at absolute times. The listings below the system calls are therefore hardware circuits.
- **Ten instructions.**
  - Gates and measurement: `H S Sdg X Z`, `CNOT CZ CY`, `measure`.
  - `request_ancilla` and `release_ancilla`, with a `patch` form.
  - `route`.
  - `request_magic`, for the states T, CCZ, AutoCCZ and Y+.
  - `decode_syndrome`, in four forms: plain, `input_ns`, `streamed window_ns` and `decoder_latency_model`.
  - `pauli_frame_update` and `parity`.
  - Control: loops (`every P`, `step S`), calls, `when` and `case`.
- **What the back end reads.** `qec_sys input.qec --machine M.machine --system-spec S.sysspec -o out.sysprog`.
  - `M.machine` holds 4 capacities, 3 bandwidths and 8 latencies, plus optional decoder fields.
  - `S.sysspec` holds the program spec and one resource contract per round gadget (`surfaceRound`, `surfaceRoundLogicalAncilla`, …), together with `spec factory*` and `spec maintenance`.
  - Neither file contains geometry. These two files are what QuantumOS produces.
- **What `route` means.** One latency, whatever the distance. It licenses two-qubit gates among its operands. The fixed cost is deliberate (`FormalRV/System/SysProg.lean:164-173`).
- **How a merge is lowered.** A merge measures the logical Z⊗Z through one check qubit, which runs a CZ ladder onto the logical representatives of both blocks under one `route`. The machine must therefore bring one ancilla next to 3 + 3 qubits of two different blocks.
- **What the evaluator of record, the OCaml VM, does not check.**
  - That each gate's qubits were routed before it.
  - Record SSA.
  - Gate content: F16 in `docs/design/QEC_TO_SYS_PASSES.md` says that no checker of the final listing looks at it.
  - Quantum correctness.
  - Lower bounds.
- **Machines in the audits.**
  - Superconducting, from GE2021:

    | Item | Value |
    | --- | --- |
    | 1-qubit / 2-qubit gate | 25 / 50 ns |
    | Measure | 550 ns |
    | Reset | 250 ns |
    | Route | 100 ns |
    | Decoder | 10 µs |
    | Frame update | 40 ns |

  - Neutral atoms, from Zhou2025:

    | Item | Value |
    | --- | --- |
    | Route | 500 µs, constant |
    | 2-qubit gate | 100 µs |
    | Measure | 500 µs |
    | Decoder | 1 ms |
    | T / CCZ factory | 7 / 34 ms |

  - Trapped ions: no machine exists.

**Verified on 2026-11-24 with the built binaries, FormalRV unchanged:**
1. `prepare_qec ZZmerge.qppm --code surface --distance 3 --specialize a=0 --specialize b=1`.
2. `qec_sys` with `ZZmerge.machine` and a two-contract `.sysspec`.
3. `run-symbolic` reports `RESOURCE_VALIDATED`.
4. `ftq_vm.sysprog.expand`, imported as a library, gives **411 operations and 6 calls**:

   | Operation | Count |
   | --- | --- |
   | CNOT | 150 |
   | measure | 55 |
   | route | 54 |
   | request_ancilla | 50 |
   | release_ancilla | 50 |
   | H | 31 |
   | CZ | 18 |
   | decode_syndrome | 2 |
   | pauli_frame_update | 1 |

   They end at 73.3 µs. Every operation has its start time, duration, qubits, record reads and writes, and source line.

So the expansion needs no new code in FormalRV: QuantumOS reads FormalRV's own expansion.

### 1.2 QuantumOS, as it is

- **What runs today.** `gate`, `measure`, lookup-table `decode_syndrome` (1–10 bits) and `pauli_frame_update`.
  - Calls are written as JSON, on the 8-transmon ring, executed in the Lean SoC model on RISC-Q RV32I cores.
  - Latencies are measured from the trace. A measured bit reaches every core in 86 ns. The lookup decode takes 14 + 14k ns. The correction pulse starts 490 ns after the measurement window closes.
- **What is missing.**
  - A `.sysprog` front end.
  - `route` on ions or atoms as a call.
  - Reset, and with it `request_ancilla`.
  - Factories.
  - `parity`.
  - Surface-code layouts.
  - Neutral-atom imaging.
  - QCCD split, merge and junction timings, which are defined but unused.
  - Helios connected to `decode_syndrome`: Helios runs, but returns roots, not a correction.
  - Any capacity beyond one hub, at most 500 bits/µs per board.
  - More than 64 cores per design.
- **What can be reused.**
  - `riscq/syscalls.mjs`: samples per call, using the paper's r(N,D).
  - `riscq/limits.mjs`: capacity sweeps.
  - Design documents (`riscq/design.mjs`).
  - QCCD Studio: shuttle and junction timing in µs.
  - ZAC: AOD moves with t = √(d/a), a = 2750 m/s², and a 15 µs transfer. FormalRV ships a ZAC surgery architecture in `Example/neutral_atom/surface3_surgery_arch.json`.
  - Helios union-find in C, compiled for RV32I. At d=3 it takes 17–58 µs on one 500 MHz core.

### 1.3 What a derived specification may show (hypotheses, not results)

| # | Specification field | What the hardware does | What the derived value will show |
|---|---|---|---|
| H1 | `route_latency_ns`, one constant | Atoms: 2×15 µs transfer + √(d/a), i.e. 30–140 µs for 10–300 µm. Ions: split, shuttle, junctions, merge and recool, 0.3–1 ms. SC: SWAP chains or couplers, depending on distance | The spec must be the worst route, so typical routes have slack. We measure the slack and its effect on the makespan |
| H2 | `qubit_routing_bandwidth`, a rate | AOD rows and columns move together and cannot cross. QCCD junctions are exclusive | The derived rate depends on the move pattern. We report the range |
| H3 | `max_parallel_gates` | SC: one channel per qubit. Ions: one gate per zone. Atoms: one global Rydberg pulse per zone | The value differs by orders of magnitude between platforms |
| H4 | `measure_ns` per qubit | Atoms: a ms camera exposure after a move to the readout zone. Ions: 120 µs per zone | Batched readout folded into one latency |
| H5 | `reset_ns`, `ancilla_bandwidth` | SC: active reset. Ions: cooling and pumping. Atoms: reload from a reservoir | Platform-specific supply rates |
| H6 | `classical_data_bandwidth`, one rate | Core → hub → board links | The per-board limit sets the machine-wide value |
| H7 | `decoder_latency_ns` / `decoder_latency_model` | Measured on the compiled decoder (rule 3) | A measured f(n), to compare with the 10 µs and 1 ms of the audits |
| H8 | (none) | Control issue rate (≤ 29 timed writes/µs per core) and instruction memory | No field exists, so the cost must be folded into gate slots or latencies. We report how much |
| H9 | `spec maintenance` | Rounds share channels, cores and the hub with the computation | Interference the reservation does not show |
| H10 | GE2021 decoder | The paper's text says 9.45 µs; `GE2021.machine` says `decoder_latency_ns: 10000` | Ask which one the results used |

---

## 2. The result to aim for

**Claim for §5.2.** For small logical programs compiled by FormalRV, QuantumOS derives a system specification per platform. Under that specification:
- the VM admits the listing;
- the simulated hardware executes it at the listed times;
- every operation finishes within its specified latency.

Every margin is measured: per call, the specified value minus the simulated one, and the VM's makespan minus the simulated dependency-driven makespan. Where no single value fits well (H1, H3, H8), we show the distribution, and what that does to the paper's RSA-2048 machines.

**Verifiable compilation.** Lowering a listing onto a machine produces a **refinement certificate**: for every listing operation, the trace events that implement it. A checker validates the certificate. A Lean theorem says that acceptance implies the VM's admission holds for the hardware run (§4).

**Paper outputs.**
1. **A table, system call × platform.** The derived value, and the simulated min, median and max. Also the coverage (the fraction of calls whose simulated cost is at most the specified one) and the slack.
2. **A figure, VM makespan against simulated makespan.** One point per pair of program and platform, both under the derived specification and under the paper's audit machine.
3. **A figure, route latency against distance** on atoms, ions and superconducting hardware, with the specified constant drawn as a line.
4. **Decoder latency against syndrome size,** measured on the virtual FPGA, compared with the audits' assumed values and with published FPGA decoders.
5. **A theorem and a checker,** with negative controls: a planted late pulse, an unrouted CZ and a dropped gate must all be refused.

---

## 3. Architecture

```
FormalRV (unchanged):   .prog → .qppm → .qec ──┐
QuantumOS:  hardware design ── [S] derive spec → M.machine + S.sysspec
FormalRV (unchanged):   qec_sys(.qec, M, S) → .sysprog ── run-symbolic → RESOURCE_VALIDATED
QuantumOS:
   [A] read FormalRV's expansion (ftq_vm.sysprog.expand) → ops with start, duration, qubits, records
   [B] place: listing qubit → hardware site            (layout generator per platform)
   [C] realize each op on the platform                  (pulses, transport, reset, readout, decode)
   [D] firmware for the RISC-Q cores                    (existing lowering, extended)
   [E] execute in the Lean SoC model → trace            (existing)
   [F] certify: refinement checker (listing ↔ trace)
   [G] measure → the next spec, from [S]; repeat until the spec holds
   [Q] Stim samples the same physical circuit → measurement records → [E]
```

**[S] Spec derivation** is the central new component. For each platform design it produces both files.

`M.machine`:
- **Durations.** `gate1q_ns` and `gate2q_ns` are the longest calibrated pulses, plus the control overhead. `measure_ns` is readout plus demodulation, or the move to the readout zone plus the exposure. `reset_ns`. `route_latency_ns` is the longest route the layout needs. `decoder_latency_ns`, or `decoder_latency_model: f(n)`, is measured on the compiled decoder. `pauli_frame_update_ns`. `magic_state_latency_ns`.
- **Capacities.** `max_parallel_gates` comes from channels and zones. `decoders` is the number of decoder cores. `factories`. `qubits` is the number of sites.
- **Bandwidths.** `classical_data_bandwidth` is the measured sustained rate of the hub and board links. `qubit_routing_bandwidth` and `ancilla_bandwidth` are measured sustained rates.

`S.sysspec`:
- **Round gadgets.** For `surfaceRound` and its relatives: the qubits, the span of one simulated round, and its peak services.
- **`spec maintenance`**, from simulated rounds.
- **`spec factory`**, from a simulated injection gadget (§3, `request_magic`).

Every value records how it was obtained: measured (with a trace hash), a cited constant, or derived.

**[A] needs no new FormalRV code.** A bridge script (`bridge/ftqvm_expand.py`) imports `ftq_vm.sysprog` from the FormalRV checkout and writes the operation list as JSON. QuantumOS checks that list against the `RESOURCE_VALIDATED` verdict of `run-symbolic`. The Python oracle refuses guards, but the small programs need none. If one does, its `witness` arm is chosen and reported.

**Two execution modes.**
1. *Time-triggered.* Every operation is posted at its listed start, as RISC-Q's timed queues do. An operation that finishes late violates the spec. This mode gives conformance and the per-call slack.
2. *Dependency-driven.* Operations run in program order as soon as the hardware allows. This mode gives the realized makespan.

Graham's anomalies make the two modes differ. Only mode 1 supports the theorem.

**[C] Realization per platform.** Everything the listing asks for is implemented; nothing is refused for being inconvenient.

| Listing op | Superconducting | QCCD ions | Neutral atoms |
|---|---|---|---|
| `H S Sdg X Z` | DRAG pulses, virtual Z | Raman rotation in a zone | Raman or local addressing |
| `CZ CNOT CY` | CZ on a tunable coupler (+ H) | MS in a zone (+ rotations) | Rydberg pulse in the entanglement zone |
| `route` | Brings the operands into coupler range: SWAP chains through routing qubits planned from the coupling graph, or a layout with dedicated long couplers. Both are designs; we compare them | Split, shuttle, junction, merge and recool, planned with QCCD Studio's router | Pick up, AOD move and drop, with ZAC timing; rows and columns must not cross |
| `request_ancilla` | Active reset pulse (cited) | Doppler and sideband cooling, then optical pumping | Atom from a reservoir, moved into place |
| `release_ancilla` | Nothing (the site becomes free) | The ion returns to storage | The atom is dropped, or returned to the reservoir |
| `measure` | Readout tone and demodulation (exists) | Detection with PMT counts (exists) | Move to the readout zone, then the camera (new; cited exposure) |
| `decode_syndrome` | Decoder core(s) running Helios union-find compiled from C, with peeling to a correction | same | same |
| `pauli_frame_update` | Frame word on the decoder core (exists) | same | same |
| `parity` | XOR on the decoder core | same | same |
| `request_magic` | The factory is a gadget of its own: T injection on a d=3 patch, compiled by FormalRV, run here, and summarized into `spec factory`. A distillation factory scales that measured contract by FormalRV's own rule (`DistanceScaling.lean`) and says so | same | same |

**[B] Layouts are generated design documents.**
- Superconducting: a square grid of tunable-coupler transmons, holding d=3 rotated patches with routing space between them.
- QCCD: gate and storage zones with junctions, in QCCD Studio's architecture format.
- Atoms: storage, entanglement and readout zones, starting from `surface3_surgery_arch.json`.

The placement map is part of the certificate.

**[Q] keeps the QuantumOS rule of no quantum state in the controller model.** Stim is a separate component. It turns the physical circuit into measurement records, which the controller receives as inputs. That makes the decoder's input real syndromes. It also checks the logical result (the merge parity, a logical CNOT's frames), which covers F16.

**The decoder.**
- Helios's C union-find is extended with its peeling step, so that it returns a correction.
- It is compiled for RV32I and run on one or more decoder cores. The latency is measured per syndrome size and fitted to `decoder_latency_model: a + b*n`.
- One decoder core per `decoders` unit. Their input rate is the hub's measured rate.
- Published FPGA decoders (Helios 56 ns at d=3) appear only as a comparison row.
- Possible extension: Helios's Verilog under Verilator. This needs Verilator installed.

---

## 4. Verification

| Kind | Statement | Where |
|---|---|---|
| Proved (Lean) | **Refinement soundness.** Suppose an execution is time-triggered at the listed starts, the trace events of each op lie in [s, s + δ_spec), and every hardware resource maps to a service under a declared mapping with load ≤ capacity. Then the hardware run meets the VM's order (I2), capacity (I3) and span (I4) | New `QControl/FTQVM/Refinement.lean`. It states FormalRV's sweep rule in the same form and does not import FormalRV |
| Proved (Lean) | **Licensing.** A two-qubit pulse is emitted only while its sites are interaction-adjacent in the trace state | New. It uses the trap and AOD position semantics of `QCCD.lean` and `Neutral.lean` |
| Checked (executable) | **The certificate checker.** Per op: its events, interval containment, dependence order, adjacency at each two-qubit pulse, and the peak per service. Negative controls are included | `riscq/ftqvm/certify.mjs` with tests |
| Conformance | **Stim logical outcomes match the `.qec` program** for the small programs | tests |
| Measured (model) | **Latency and capacity distributions** per call and platform | §5 |
| Assumed (cited) | **Platform constants,** each with its source | `riscq/standards.mjs` |

The paper keeps these kinds apart.

---

## 5. Benchmarks and experiments

Every program is compiled by FormalRV, unchanged, from `.prog` or `.qppm`.

| ID | Program | Physical size | Exercises |
|---|---|---|---|
| P0 | d=3 memory, r = 1…10 rounds | 17 | ancillas, rounds, decode; derives the round contract and `spec maintenance` |
| P1 | Z⊗Z merge (`ZZmerge.qppm`): 411 ops, verified to compile | ≈ 25 live | `route`, merge ladder, decode, frame |
| P2 | Logical CNOT by surgery (the paper's Fig. `cnot`) | 60–80 | packing, pipelining, 3 decodes |
| P3 | Logical Bell or GHZ-3, measured in X and Z | 40–60 | end-to-end logical outcome |
| P4 | T injection on d=3, then a teleported T | ≈ 40 | `request_magic`; derives `spec factory` |
| P5 | A 2-qubit DJ, or a 1-bit adder with Toffoli via CCZ | 60–100 | a small logical algorithm |

**E1. Derive and conform.** For each platform, derive M and S, compile, admit and run in mode 1. Report per call: the specified value against the simulated min, median and max, the coverage and the slack. Fit route against distance (atoms, ions) or SWAP count (superconducting), and decode against syndrome bits.

**E2. Capacity.** Concurrency probes in the style of `limits.mjs`:
- simultaneous routes (AOD and junction conflicts);
- gates per zone;
- hub bits/µs per board;
- decoder cores;
- issue rate per core (H8).

**E3. End-to-end.** Compare three makespans: the VM's under the derived spec, the simulated in mode 2, and the VM's under the paper's audit machine for that platform. Attribute the residual to calls.

**E4. Consequences for the audits.** Put the derived per-platform values beside the values in the audit machines (GE2021, Zhou2025, Beverland2022, Pinnacle). Run the existing VM on the existing RSA-2048 listings at the derived values, where they differ. Only machine inputs change: neither the VM nor the listings do. Changed latencies need a recompile, which uses FormalRV's own compiler.

**E5. Checker cost and negative controls.** Checker time per op. Every planted fault must be refused.

---

## 6. Schedule (8 weeks)

| Week | Dates | Deliverable | Done when |
|---|---|---|---|
| 1 | 11-24 → 11-30 | `bridge/ftqvm_expand.py` (imports FormalRV, writes ops JSON); `riscq/ftqvm/` loader; scripted compile of P0 and P1 with a first hand-written spec | P1's 411 ops load with their VM times |
| 2 | 12-01 → 12-07 | Layout generators (SC, QCCD, atoms) as design documents; placement map; SC reset; atom readout zone and camera | P0 runs in mode 1 on SC; first derived round contract |
| 3 | 12-08 → 12-14 | `route` on atoms (ZAC moves) and ions (QCCD Studio shuttles); SC SWAP routing; Helios with peeling, wired to `decode_syndrome` | P1 runs on all three platforms |
| 4 | 12-15 → 12-21 | [S] spec derivation end to end; refinement checker with negative controls; Lean theorem; Stim oracle | P1 compiled against a derived spec, admitted, run and certified; parity correct |
| 5 | 12-22 → 12-28 | P2–P4; factory gadget and its derived `spec factory`; multi-board link model and core cap raised | P2–P4 certified on ≥ 2 platforms |
| 6 | 12-29 → 01-04 | E1 and E2 complete; specs frozen | Derived-spec table final |
| 7 | 01-05 → 01-11 | E3 and E4; figures | Figures drafted |
| 8 | 01-12 → 01-19 | §5.2 text, abstract and intro claims; artifact README; P1 and P2 in the 3D workspace | Section complete |

**What to cut first if time runs short:**
1. P5.
2. Noise-aware logical error.
3. Helios Verilog.
4. The second SC routing design.
5. The third platform.

**Minimum publishable core:** P0–P2 on atoms and ions, with E1, E3 and the decoder measurement.

---

## 7. Risks

- **Scale of the Lean SoC model.**
  - The case: 80 qubits and 1–2·10^4 ops, against the 64-core cap.
  - Mitigation: one core per zone (ions, atoms), a higher cap, and profiling in week 2.
- **A spec that no constant fits.** Example: atom routes from 30 to 140 µs. This is a finding, not a failure. Report the worst-case spec and the slack distribution.
- **Factory realism.** A 15-to-1 factory is far beyond the size QuantumOS can run, so we measure injection and state the scaling rule.
- **Decoder speed on soft cores.** The compiled union-find is µs-scale where FPGA decoders are ns-scale. Report both. Keep the measured value as the spec, by rule 3, and the published FPGA value as a comparison.
- **FormalRV's rules.**
  - We do not edit FormalRV.
  - We call its binaries and import its Python reader.
  - Scratch outputs go to our tree, never to theirs.
  - Our checker is a QuantumOS conformance checker, not a FormalRV evaluator.
- **Two sessions in this tree.** Commit by explicit path.

---

## 8. Progress

### 2026-11-24: P1 (the Z⊗Z merge) on a generated transmon chip, with a derived spec

**Pipeline.** Each step uses FormalRV unchanged.
- [`riscq/ftqvm/formalrv.mjs`](../riscq/ftqvm/formalrv.mjs) calls FormalRV's built `prepare_qec` and `qec_sys`, then `run-symbolic` (the OCaml VM).
- [`bridge/ftqvm_expand.py`](../bridge/ftqvm_expand.py) imports `ftq_vm.sysprog` to expand the listing.
- [`spec.mjs`](../riscq/ftqvm/spec.mjs) writes `.machine` and `.sysspec`, with each value's source.
- [`place.mjs`](../riscq/ftqvm/place.mjs) assigns sites. Data qubits sit at row-major lattice points; each ancilla takes the free half-integer point nearest the data it gates with, and identities that never live at once share a site.
- [`sc-chip.mjs`](../riscq/ftqvm/sc-chip.mjs) builds a riscq-design chip: one transmon and one core per site, one coupler per gated pair, multiplexed readout, and a 160 ns reset.
- [`sc-run.mjs`](../riscq/ftqvm/sc-run.mjs) executes the listing time-triggered in the Lean SoC model and checks the trace against the listing.
- [`derive.mjs`](../riscq/ftqvm/derive.mjs) runs the derivation loop and the contract pass.
- [`cli.mjs`](../riscq/ftqvm/cli.mjs) is the headless entry.
- Tests: [`tests/ftqvm-formalrv.test.mjs`](../tests/ftqvm-formalrv.test.mjs) and [`tests/ftqvm-transmon.test.mjs`](../tests/ftqvm-transmon.test.mjs), including a negative control in which a CNOT promised 100 ns sooner is refused.

**Results.** All values are model results (the Lean SoC on a chip calibrated as below), not hardware measurements.

| | FormalRV test profile | Derived from the trace |
|---|---|---|
| gate1q / gate2q / measure / reset / route (ns) | 25 / 50 / 550 / 250 / 1000 | 36 / 472 / 1420 / 160 / 2 |
| Conforming ops (of 408 realized) | 100 (reset, route, release) | 408 |
| VM makespan | 72.1 µs (not met by the chip) | 102.6 µs (met) |
| `surfaceRound` contract | the whole machine | 17 qubits, 10,122 ns, 4 gates, 2 bits/µs, 56 qubits/µs ancilla |

The loop converges in two iterations, and the contract pass compiles a third time. FormalRV's VM admits every iteration.

**Findings so far.** These concern the specification, as rule 2 requires.
1. **One two-qubit field.** CZ is charged CNOT's 472 ns, but needs 400 ns. A listing with many CZs, such as the merge ladder, carries 72 ns of slack per CZ.
2. **Readout lengths differ per qubit** (x6y3 calibration): measurements need 1024 / 1198 / 1420 ns (min / median / max). The spec must take the maximum, so the median measurement leaves 222 ns unused.
3. **Route on a chip with a coupler for every gated pair.**
   - It takes no time. 2 ns, one batch, is the smallest value FormalRV accepts.
   - FormalRV's rate rule then charges an 8-qubit route ⌈1000·8/2⌉ = 4000 qubits/µs, which this chip does not consume.
   - The cost moves into hardware instead: the merge needs 23 couplers longer than nearest-neighbour, up to 4.5 lattice pitches.
4. **The round gadget.** It spans 10,122 ns in the listing and 9,918 ns on the hardware. It uses at most 4 of the 41 gate slots, because the compiler's dependences serialize the checks.

**Assumptions** (also recorded in `chip.json` → `provenance`):
- Site k reuses the calibration of x6y3 qubit k mod 8.
- Every coupler, long or short, reuses an x6y3 400 ns CZ.
- The reset is the cited unconditional 160 ns pulse, with an illustrative amplitude.
- Crosstalk, frequency collisions and loss are not modeled.

**Not realized yet, and listed in every report:** `decode_syndrome` and `pauli_frame_update` (week 3: Helios with peeling on the decoder core), `parity` and `request_magic`.

**Next.** In this order:
1. Helios wired to `decode_syndrome`.
2. The P0 memory program.
3. Atom and ion realizations of `route`.
4. A nearest-neighbour superconducting chip with SWAP routing, as the second design point.

### 2026-11-24 (later): every system call on all three platforms, two designs each

- **System calls realized.** All of them except `parity`, which no small FormalRV program emits; it is implemented in the frame core firmware but has no listing yet.
  - **`decode_syndrome`:** Helios union-find compiled for RV32I and measured per syndrome (riscq/ftqvm/decoder.mjs). At d = 3 an empty syndrome takes 17.2 µs, and 34–51 µs with defects. Up to 8 bits a lookup decoder is measured directly; 9–10 bits follow the line through the measured 1- and 8-bit times.
  - **`pauli_frame_update`:** timed on the frame core, 74 ns at 500 MHz.
  - **`request_magic`:** an injection factory on the output block's patch. It runs reset, T on a corner qubit, d rounds of every check, and two Helios decodes. The factory contract is derived: 44.6 µs, output 9, workspace 8, 8 gates, 1 decoder.
- **Placement** recognizes ancilla blocks (whole-block requests, magic outputs) and factory workspace. A patch's measure sites belong to its own checks.
- **Designs** (riscq/ftqvm/corpus.mjs `DESIGNS`):
  - transmons: sc-A (2 qubits per core, one 1-core decoder) and sc-B (4 per core, two 4-core decoders);
  - atoms: atoms-moving and atoms-static;
  - ions: ions-qccd and ions-modules.

  The optical engine is riscq/ftqvm/optical.mjs. Constants are cited: Bluvstein et al. 2024, Norcia et al. 2023, ZAC, Pino et al. 2021.
- **Corpus** (riscq/ftqvm/corpus.mjs): memory d3/d5, DJ, Bell d3/d5, Z⊗Z merge d3/d5, GHZ-3, checked_measurement, T injection, checked_loop. Results: validation/ftqvm/results (`node riscq/ftqvm/sweep.mjs`).
- **Finding, ions.** On ions-modules most routes need no motion; only the merges shuttle (1.18 ms). The single `route_latency_ns` must still cover the worst route, so the VM's makespan equals that of ions-qccd (68.5 ms for the merge). The spec cannot express the better design.
- **Limits found.**
  - Bell-d5 and Z⊗Z-d5 on sc-B need more than one 64-core board.
  - Bell-d3 on both atom designs does not conform yet (under investigation).

**Next, at the owner's request:** reproduce published experiments with system calls on hardware designs built from each paper's device: Google's surface-code memory (Willow), Lukin's logical processor (Bluvstein 2024), and Quantinuum's logical teleportation (H2). Another agent collects these papers for the course; this work is the system-call and hardware side.

### Published experiments on digital twins

**Workflow.**
1. Write each experiment as a FormalRV program.
2. Build the machine it ran on as a fixed twin (riscq/ftqvm/twins.mjs).
3. Compile the program with its system calls onto the twin. Every placed qubit must be a device qubit and every gated pair a device coupler (`onDevice`).
4. Derive the spec from the twin's trace and require conformance.

Runner: `node riscq/ftqvm/papers.mjs google 10`, which writes validation/ftqvm/papers/google-2025.{json,md}.

**1. Google Quantum AI, Nature 638, 920 (2025): surface-code memory on Willow.**
- **Program:** FormalRV's own surface-code declaration, then R rounds of `extract` and a `decode` (riscq/ftqvm/papers.mjs `googleMemory`).
- **Twin:** the distance-7 patch of the 105-qubit square grid (97 qubits). Durations: 25 ns XY and 42 ns CZ, from the paper; 500 ns readout and 160 ns reset, from the group's 2023 paper, because the 2025 text gives neither.
- **Results:**

  | d | Qubits | Ops | Conforms | FormalRV round | Paper cycle | Gates per round | Decoder, 10 rounds (compiled Helios) |
  |---|---|---|---|---|---|---|---|
  | 3 | 97 | 601 | yes | 2.46 µs | 1.1 µs | 4 | 34.3 µs |
  | 5 | 97 | 1,881 | yes | 3.21 µs | 1.1 µs | 12 | 94.1 µs (paper: 63 µs, software) |
  | 7 | 97 | 3,841 | yes | 3.97 µs | 1.1 µs | 24 | 274.5 µs |

- **Finding:** on the same durations, FormalRV's round is 2.2–3.6 times Google's cycle. Its round schedule runs at most (d²−1)/2 gates at once, while the device can run all checks in parallel; four CZ layers, two H, measure and reset come to about 0.95 µs.

**2. Bluvstein et al., Nature 626, 58 (2024), Fig. 2: logical Bell pair by transversal CNOT.**
Runner: `node riscq/ftqvm/papers.mjs bluvstein 3,5,7`, which writes validation/ftqvm/papers/bluvstein-2024.{json,md}.

- **Program** (riscq/ftqvm/papers.mjs `bluvsteinBell`), at FormalRV's encoded level:
  - |+⟩_L in a logical ancilla block;
  - `transversal CX` onto the data block;
  - one stabilizer round on each block;
  - the logical Z⊗Z or X⊗X readout.

  FormalRV's *staged* back end compiles it with `--opt pipeline-loops`, so the nine (d=3) transversal pairs start within 8 ns. The code declaration is FormalRV's own, transversal H̄ row included. Two encoding constraints:
  - FormalRV's staged back end does not yet expand a transversal H on one block, so |+⟩_L is prepared directly, as the paper does.
  - The algorithm level (`.prog`) decomposes H and CX into Pauli-product rotations with |Y+⟩ ancillas, not into one transversal gate.
- **Twin** (riscq/ftqvm/optical.mjs `bluvstein-2024`):
  - gate sites at 10 µm pitch, 100 of them (5 × 20);
  - one global Rydberg pulse (270 ns) for every gate site, and a global Raman layer (about 1 µs);
  - a 200 µs AOD job per route, with 2 AODs;
  - readout is a 200 µs move to the readout zone plus 500 µs imaging;
  - up to 280 atoms, and global optical pumping (100 µs, from Norcia 2023).
- **Results:**

  | d | Bases | Conforms | Placed qubits | Ops | Transversal CNOTs spread over |
  |---|---|---|---|---|---|
  | 3 | Z, X | yes | 34 | 519 | 816 µs |
  | 5 | Z, X | not yet | 98 | 2,347 | |
  | 7 | Z, X | not admitted | | | |

  At d=3 the derived CNOT is 4.1 µs, against 2.27 µs of pulses: the spec absorbs the waits for shared global pulses. A single AOD job would move all nine pairs in about 200 µs.
- **Findings for the paper:**
  1. **Global pulses need synchronized layers.** FormalRV schedules each gate on its own clock with its own duration. On global-pulse hardware all gates of a kind in a zone must coincide, and FormalRV cannot ask for layers. At d=5, H layers and the H gates inside CNOTs still collide on the one Raman beam, so it does not converge yet.
  2. **A route is not an AOD job.** Routes that start together share one AOD job on the device, but FormalRV charges each route on its own. The twin must declare its 2 AODs as the routing capacity, so the transversal gate's per-pair routes run a few at a time.
  3. **The integer rate rule overcharges slow platforms.** ⌈1000·N/D⌉ charges every concurrent request at least 1 item/µs, however long its duration. On atoms and ions, resets, routes and measurements of 100 µs or more must be stated as concurrent-request capacities, not physical rates. At d=7, 120 concurrent 701 µs readouts reserve 120 bits/µs against a 100 bits/µs hub, though they need about 0.17 bits/µs physically. A camera readout model, one exposure for every atom, is the missing piece of the twin.
  4. **Background maintenance is not executable.** The staged back end reserves rounds for idle blocks without emitting them as operations, so the twin cannot execute them. The bridge expands the listing without those reservations and records that it did.

**3. Ryan-Anderson et al. 2024 (arXiv:2404.16728): Steane-code teleportation on H2.**
Runner: `node riscq/ftqvm/papers.mjs quantinuum`.

- **Program** (`quantinuumTeleport`), on FormalRV's own Steane declaration:
  - a Bell pair between two logical ancilla blocks by `transversal CX`;
  - one round on each block;
  - `transversal CX` from the source block;
  - X and Z readouts;
  - Pauli-frame corrections.

  The staged back end compiles it. Placement now accepts any block size n (7 here) and splits multi-block requests. The decoder uses Helios only for surface blocks and decodes everything else by lookup.
- **Twin** (`quantinuum-h2`), from QCCD Studio's `arch/h2_racetrack.arch.json`: 40 zones in one loop, 2 ions per zone.

  | Operation | Duration | Source |
  | --- | --- | --- |
  | MS | 25 µs | 2305.03828 |
  | One-qubit gate | 5 µs | 2305.03828 |
  | Measurement | 120 µs | 2305.03828 |
  | Split, merge | 80 µs each | 2510.23519 |
  | Shuttle | 5 µs per zone | 2510.23519 |
  | Reset | 50 µs | 2510.23519 |

  Each two-qubit gate carries its own transport, and `route` is empty.
- **Results:**
  - **32 qubits:** refused by FormalRV, because background maintenance reserves measure qubits for every live block (budget 19 against a request of 26). The paper used up to 30 ions.
  - **56 qubits:** conforms, with 39 ions and 611 operations. The derived two-qubit gate is 295 µs (worst trip plus MS); gates actually need 35 µs at minimum and 215 µs at the median.

### The Reproduce section of the site

- **`/reproduce`:** a list built from riscq/ftqvm/reproductions.mjs.
- **`/reproduce/<id>`:** one paper page (studio/reproduce/paper.html with reproduce.js), filled from validation/ftqvm/papers/<id>.json. It shows the paper, the program, the twin's parameters with sources, results against the paper, findings and limits, and one run in detail: compiled listing, derived spec with sources, per-kind conformance and slack, the FormalRV program, and the command.
- **Menu:** "Reproduce" in studio/site-nav.js.
- **Another session** (qcontrolsys-7e) adds two magic-state reproductions in new files (riscq/ftqvm/magic*.mjs): Google's cultivation, and QuEra's distillation.

## 9. Open question

- **H10.** Which GE2021 decoder latency did the paper's results use: 9.45 µs (text) or 10 µs (`GE2021.machine`)?
