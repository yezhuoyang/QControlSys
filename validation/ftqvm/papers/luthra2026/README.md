# luthra2026: QLDPC surgery on Quantinuum H2-2

S. Luthra and A. Owens, "Individually Addressed Logical Pauli Measurements by QLDPC Surgery on a Trapped Ion Quantum Computer", arXiv:2610.39067 (v1, 28 Oct 2026, CC BY 4.0). The data and programs come from Zenodo 10.5281/zenodo.23165109.

This directory turns each submitted program into a Stim circuit and checks it against the published shot records.

## Files

| File | Content |
|---|---|
| `data/*-input.json` | The 8 programs that were submitted. Each is QIR (LLVM IR text, despite the `.json` extension). |
| `data/*-output.json` | Shot records for those 8 programs. |
| `data/zenodo-record.json` | The Zenodo record. Every file's md5 matches it. |
| `circuit-XR1.stim` | XR1, prepared in \|++⟩. |
| `circuit-XR1-MinusMinus.stim` | XR1, prepared in \|--⟩. |
| `circuit-XR1-ZeroZero.stim` | XR1, prepared in \|00⟩. |
| `circuit-XR1-OneOne.stim` | XR1, prepared in \|11⟩. |
| `circuit-XR3.stim` | XR3, prepared in \|++⟩. |
| `circuit-SEQ.stim` | SEQ, prepared in \|00⟩. |
| `circuit-SEQ-OneOne.stim` | SEQ, prepared in \|11⟩. |
| `circuit-MEM.stim` | MEM, prepared in \|++⟩. |
| `layout.json` | For each circuit: how output-array positions map to Stim measurement records, the role of each round, and every detector and observable as a labelled list of output positions. |
| `build_circuits.py` | Converts QIR to Stim and adds the detectors. Run: `python -I build_circuits.py .` |
| `verify.py` / `verify.txt` | All checks and their results. Run: `python -I verify.py .` (needs stim, pymatching, numpy). |
| `meta.json` | Citation, device, timings (`{value, unit, quote, source}`), electronics, decoding, results, what is exact, and the checks. |

## Method

1. **What was submitted.** Appendix B of the paper describes the toolchain: a Stim circuit using {M, R, H, X, CNOT} is compiled by PyTKET (optimisation level 2) into {Measure, Reset, Rx, Rz, ZZPhase(0.5)}. Q# then turns this into QIR, which went to H2-2 through Azure with `no-opt`, `no-reduce` and `leakage_repump_enable`. Zenodo holds only this final QIR, not the original Stim circuits. Each program is a single basic block with no branching. It contains only `reset`, `rz`, `rx`, `rzz`, `m` and `result_record_output`.

2. **Gate translation.** Every angle is a multiple of π/2. The table below maps each QIR call to its H2 native gate and its Stim gate. `verify.py §1` checks numerically that each pair is equal up to a global phase.

   | QIR call | H2 native gate | Stim |
   |---|---|---|
   | `rz(π/2)` | Rz(π/2), applied virtually | `S` |
   | `rz(3π/2)` | Rz(3π/2), applied virtually | `S_DAG` |
   | `rx(π/2)` | Rxy(π/2, 0), also called PhasedX or U1q | `SQRT_X` |
   | `rx(π)` | Rxy(π, 0) | `X` |
   | `rx(3π/2)` | Rxy(3π/2, 0) | `SQRT_X_DAG` |
   | `rzz(π/2)` | ZZMax = ZZPhase(0.5) = exp(−iπ/4 Z⊗Z) | `SQRT_ZZ` |
   | `reset` | Reset | `R` |
   | `m` | Measure | `M` |

3. **Exact order and indices.**
   - Stim instructions appear one per line, in QIR order, with the QIR qubit indices. `verify.py §2` re-parses each QIR file and checks that the two instruction lists are identical.
   - QIR result ids are allocated in program order, so Stim measurement record *k* is QIR `%Result` *k*.
   - Each shot in the output files lists bits in the order of the `result_record_output` calls, labelled `k_a(k-1)r`. That order is the original Stim measurement order: rounds SE1, γ, merged rounds, κ, SE2, then data.
   - `layout.json` maps each output position to its record index. Use `Results[0].Shots`, which keeps shot order; `Histogram` merges identical shots.

4. **TICKs and coordinates.**
   - The QIR has no layer structure. A TICK is placed only where the next instruction reuses a qubit since the last TICK, so the TICKs are derived, not part of the program, and carry no timing.
   - `QUBIT_COORDS(q, 0)` just puts program qubit *q* on a line. H2 has no fixed qubit positions, because ions are moved between zones.

5. **Qubit roles.** These were read from the coupling graph and checked against the code (`verify.py §3`).

   | Program qubits | Role |
   |---|---|
   | 0–4 | Ancillas for the X stabilisers S_X,j |
   | 5–14 | Data qubits q0–q9 |
   | 15–19 | Ancillas for the Z stabilisers S_Z,j |
   | 20–22 | κ2, κ3, κ4 for the X̄1 gadget; reused as ν0, ν1, ν2 for the Z̄2 gadget in SEQ |
   | 23 | Gauge check γ0; reused as λ in SEQ |
   | 24–26 | Gadget checks χ2, χ3, χ7; reused as η2, η6, η7 in SEQ |

   The checks match the [[10,2,3]] generalised bicycle code with l=5, a=1+x², b=1+x, H_X=[A|B], H_Z=[Bᵀ|Aᵀ]. The logical operators are as in the paper: X̄1 = X(q2,q3,q7), X̄2 = X(q1,q7,q9), Z̄1 = Z(q2,q4,q5), Z̄2 = Z(q2,q6,q7).

6. **Detectors** (paper Sec. III.C):
   - **SE1 boundary:** the 5 stabilisers in the preparation basis.
   - **Bulk:** each of the 10 stabilisers compared between consecutive cycles. This gives 20, 40, 30 and 40 bulk detectors for XR1, XR3, SEQ and MEM, as in the paper.
   - **Fusion correction:** in the layer where the gadget detaches, m(κ_j) is added to S_Z,j for j = 2, 3, 4. For the Z̄2 gadget, m(ν_j) is added to S_X,j for j = 0, 1, 2.
   - **Gadget checks:** χ compared between merged cycles (6 detectors in XR3).
   - **Gauge checks:**
     - γ0 (and λ) on its own when it is first measured, since κ starts in |0⟩ (ν in |+⟩).
     - γ0 compared between consecutive measurements.
     - The last γ0 times m(κ2)m(κ3)m(κ4).
   - **Final boundary:** each SE2 stabiliser in the measurement basis compared with the data qubits.
   - **One inferred detector:** the product of all 5 SE1 stabilisers in the other basis. These are individually random, but their product is the identity. With it, the detectors plus observables span every deterministic parity, and XR3 has exactly the paper's 62 detectors. The paper does not list its detectors, so this is the one inferred item.

   Totals: XR1 34, XR3 62, SEQ 47, MEM 51.

7. **Observables.**
   - **X̄1,G:** χ2χ3χ7 from merged cycle 1. Appendix A's figure marks R=1 as the non-destructive measurement. The χ repetition detectors make every cycle equivalent.
   - **X̄1,D and X̄2,D:** from the final data qubits.
   - **XR1 with \|00⟩/\|11⟩ preparation:** X̄1,G is random on its own, so the observable is X̄1,G⊕X̄1,D.
   - **SEQ:**
     - Z̄2,G = η2η6η7·m(κ2).
     - Z̄2,D = Z(q2,q6,q7)·m(κ2). This is the fusion correction the paper derives in Sec. III.C.

## Verification results (`verify.txt`)

- **Translation:** all 8 Stim files match the QIR instruction for instruction. With no noise, 1000 shots give all detectors and observables 0, and every `detector_error_model()` call succeeds. `decompose_errors=True` works on all of them, even though this is a qLDPC code.
- **Record layout, verified against the hardware data:**
  - Keeping shots whose SE1 is trivial reproduces the paper's post-verification counts exactly in all 8 runs: 487, 484, 240, 245, 957, 492, 486, 483.
  - In XR3 the rejected shots include every 0-based shot from 351 to 369, as the paper reports.
  - The highest single bulk-detector rate, and where it occurs, matches all 8 entries of the paper's `tab:max_rates`. For example, XR3 on all shots peaks at L4 S_Z2 with 3.80%.
  - Trailing-layer rates with and without the fusion term match `tab:fusion`: 49.6→2.06, 47.1→2.51, 50.1→1.94 and 48.1→2.66 %.
- **Decoding (sanity check only).** Tesseract is not installed here and was deliberately left uninstalled, so two other decoders are used. Both run on the DEM built from the paper's `tab:error-model` noise model.
  - PyMatching.
  - A lookup-table decoder: from 2×10⁶ simulated shots it records the most frequent observable flip for each syndrome.

  Results on the hardware shots, lookup-table decoder versus the paper's Tesseract:

  | Case | Lookup table | Paper |
  |---|---|---|
  | XR1 X̄1,G (\|++⟩, \|--⟩) | 6/971 | 7/971 = 0.72% |
  | XR3 X̄1,G, verified shots | 0/957 | 0/957 (< 0.26%) |
  | XR3 X̄1,G, all shots | 9/1000 | 10/1000 |
  | XR3 X̄2,D | 2/957 | 2/957 |
  | SEQ Z̄2,G | 11/978 | 11/978 = 1.12% |
  | XR3 without the 6 χ detectors | 9/957 | 7/957 |
  | Destructive readouts and MEM | 0 | 0 |

  PyMatching does slightly worse; on XR3 X̄1,G it gets 2/957. Simulated rates with the same model: XR1 X̄1,G about 1.0–1.1%, XR3 about 0.1–0.3%, SEQ Z̄2,G about 0.95–1.06% (the paper simulated 1.000%).

## Timing and hardware

Each entry in `meta.json → timings` gives a value, unit, quote and source.

- **Paper:** gives no per-operation times. It says it lacks "circuit timings, ion routing and the batching of qubits into the gate and readout zones". Its only timing figure is an authors' estimate of about 500 ms per XR3 shot, from "greedy scheduling of the 4 gate zones". The task brief said "44 gate zones"; the correct number is 4.
- **Quantinuum public sources:**
  - 56 qubits and 4 gate/interaction zones (data sheet v4.00). The trap has 8 gate zones, and only the 4 DG zones do gates and SPAM (docs, Moses et al.).
  - Rz is applied virtually.
  - Depth-1 circuit time is 80 ms, later about 70 ms, at N=56 (DeCross et al.).
  - A leakage repump cycle takes about 1 ms (docs).
  - About 17 ms per shot for state preparation and initial cooling at 32 qubits (Moses et al.).
  - Transport is about 60% of circuit time (Moses et al.).
- **Missing H2 numbers:** no public source gives H2 times for a 1Q gate, 2Q gate, measurement, reset or transport primitive. `meta.json` marks these `null`. As clearly labelled non-H2 fallbacks it gives the 2020 H1-precursor values from Pino et al. (Nature 2021): 1Q π/2 5 µs, 2Q 25 µs, measurement 60–120 µs, initialisation 10 µs, shifts 58/283 µs, split/combine 128 µs, swap 200 µs.
- **Derived per-shot times:** `per_shot_other_derived` scales the paper's 500 ms by the number of 2Q batches when gates are packed greedily into 4 zones: XR1 35, XR3 62, SEQ 49, MEM 50 batches. This gives XR1 ≈ 0.28 s, SEQ ≈ 0.40 s and MEM ≈ 0.40 s. These figures are my own estimates, not sourced.

## Uncertainties

- **Detector set:** reconstructed from the paper's text, not copied, since the pre-TKET Stim files are not published. It is fixed by the exact matches to verification counts, `tab:max_rates` and `tab:fusion`. The SE1 product detector is inferred from the count of 62. The choice of cycle for X̄1,G (cycle 1) only matters for decoding with a single round.
- **Reset quirk:** the program never resets the γ0 ancilla (qubit 23) between its first measurement after SE1 and its measurement in merged cycle 1. Later γ0 and λ measurements are reset. The detectors compare consecutive measurements, which handles this; noiseless checks confirm it.
- **Noise model used here:** simplified. The idle term is Z with probability 1.2e-4/7 × ⌈n2q/4⌉ for every TICK containing 2Q gates. The 1Q error is applied only to `rx`-type gates. Simulated rates are therefore approximate. The paper's idle model uses its own greedy 2Q depth, and its rates are from the 2026-09-14 performance-validation page; today's H2-2 page shows different values (in `meta.json`).
- **Decoders:** neither is Tesseract. The lookup table is trained on simulated data with this approximate model, and falls back to PyMatching (or to no correction, in the χ-ablation case) for syndromes it never saw. Differences of ±1–2 errors from the paper are expected.
- **Timing:**
  - No per-operation H2-2 times are public. The 500 ms figure is the authors' estimate, not a measurement.
  - Neither the paper nor the Zenodo files give transport schedules, zone assignment or ion routing. A digital twin must model these itself.
  - Job dates are not in the files. The bibliography gives the H2-2 access period as June 12 – July 31, 2026.
- **Quotes:** a few `meta.json` quotes, marked "via research pass", were collected by a delegated web search and not re-fetched. All others were checked against the fetched page or PDF.
