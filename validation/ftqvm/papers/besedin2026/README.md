# besedin2026: lattice split of a d=3 surface code into two d=3 repetition codes

Besedin et al., "Lattice surgery realized on two distance-three repetition codes with
superconducting qubits", Nat. Phys. 22, 189-194 (2026), arXiv:2501.04612,
doi:10.1038/s41567-025-03090-6. ETH Zurich 17-transmon device.

## Files

| file | content |
|---|---|
| `circuit.stim` | main run: logical \|0>_L, 4 X + 3 Z cycles (X first), split by Z readout of D2 D5 D8, 2 Z cycles, Z-basis data readout. 36 detectors, observable 0 = Z_L1 Z_L2 (Pauli-frame updated) |
| `circuit-bell-XX.stim`, `circuit-bell-YY.stim` | same run, X- or Y-basis tomography readout (D4 D6 in Y, others in X for YY) |
| `circuit-inject-{0,1,plus,minus,plusi,minusi}-*.stim` | state-injection inputs (Fig. 4a pattern) for the six cardinal states |
| `generate.py` | the only place where the schedule is written down. It writes all circuits |
| `verify.py` → `verify.txt`, `verify-results.json` | checks (a)-(d), see below |
| `make_meta.py` → `meta.json` | citation, device map, timing table with verbatim quotes, derived schedule, results, exactness, checks |
| `src/` | arXiv TeX source (`x/`), figure crops, ETH data record (`record/`) |

Regenerate: `python -I generate.py && python -I verify.py > verify.txt && python -I make_meta.py`.

## Method

* **Schedule.** The schedule comes from the gate-sequence figure (TeX `figs/fig_3a.png`, Methods), read at full
  resolution. Each stabilizer cycle has 8 steps: (1) pi/2 pulses, (2, 3) CZ, (4) pi echo on the data,
  (5, 6) CZ, (7) pi/2 pulses, (8) readout. The rotation angle of every Y pulse comes from pixel analysis of
  the box shading against the figure legend (-pi/2, pi, +pi/2). An X cycle applies Ry(-pi/2) to the data and
  Ry(+pi/2) to the ancillas, then an echo, then Ry(-pi/2) on both. A Z cycle applies Ry(+pi/2) and Ry(-pi/2)
  to the ancillas only, plus the data echo. The CZ partners per step are:
  X: (D1-X2, D5-X3, D7-X4), (D2-X2, D6-X3, D8-X4), (D3-X1, D5-X2, D9-X3), (D2-X1, D4-X2, D8-X3).
  Z: (Z2-D4, Z3-D2, Z4-D6), (Z1-D1, Z2-D5, Z3-D3), (Z1-D4, Z2-D8, Z3-D6), (Z2-D7, Z3-D5, Z4-D9).
  After the split, the CZs on D2, D5 and D8 are dropped.
* **No reset.** No qubit is reset except at the start. The preselection readout on all 17 qubits is kept as `M`.
  Detectors use the paper's definition sigma_N = s_N s_{N-1}, where s_N = m_N xor m_{N-1} for an ancilla
  that is not reset. So each detector is m_k xor m_{k-2}. In rounds 1 and 2 the partner is the preselection
  outcome, which is postselected to 0 and therefore left out. In the split round, Z2 and Z3 also include
  z_D5 z_D8 and z_D2 z_D5 (App. "Pauli Frame Update").
* **Detector counts.** There are 24 Z detectors, matching the published experimental decoder graph
  (source data sigma_0..sigma_5 for Z1..Z4), and 12 X detectors, matching App. Fig. F1.
* **Pipelining.** The readout of one stabilizer type shares a TICK with step 1 of the other type, as drawn in
  Fig. 3a. The split readout (X ancillas + D2 D5 D8) and the post-split Z readouts are separate layers, also
  as drawn.
* **Coordinates.** `QUBIT_COORDS` is the chip grid of the micrograph (Fig. 1e). It is the schematic rotated
  by 45°. The schematic coordinates and the mm values are in `meta.json`.

## Verification (verify.txt)

* **(a) Detector error model.** `detector_error_model(decompose_errors=True)` succeeds for all 9 circuits
  under a paper-like Pauli model: p1 = 0.09 %, p2 = 2.2 %, readout 1.5 %, and the idle channel of
  App. Simulation with T1 = 51 µs and T2E = 50 µs.
* **(b) Noiseless determinism.** All detectors are 0 and all observables are deterministic over 1000 shots.
  Tableau runs give constant physical parities. The logical action matches the fanout
  a|+> + b|-> -> a|++> + b|-->:
  * Z_L1Z_L2 flips between injected |0> and |1>.
  * X_L1 and X_L2 flip between |+> and |->.
  * Y_L1Z_L2 flips between |+i> and |-i>.
  * X_L1X_L2 is the same for every input.
* **(c) Counts.** All match the paper:
  * 17 qubits; cycle order XZXZXZXZZ (m = 3, n = 2).
  * 12 CZ per surface-code cycle and 8 per repetition-code cycle, 100 CZ in total.
  * 4 CZ steps per cycle.
  * 62 measurements: 17 preselection + 36 ancilla + 3 mid-circuit + 6 final.
  * Derived duration: 8.53 µs.
* **(d) Distance and decoding.**
  * Circuit distance of Z_L1Z_L2 is 3. The paper says the smallest undetectable logical fault has weight three.
  * X_L1X_L2 has distance 1, because phase flips are not detectable after the split.
  * No matching-graph edges join the two repetition codes after the split round.
  * The pymatching sanity estimate (200k shots) compares with the paper as follows:

    | quantity | this estimate | paper | paper's own simulation |
    |---|---|---|---|
    | ZZ raw | 0.21 | 0.189 | 0.243 |
    | ZZ decoded | 0.54 | 0.730 | 0.626 |
    | ZZ postselected | 0.997 | 0.998 | 1.0 |
    | Bell fidelity, raw / decoded | 0.365 / 0.462 | 0.382 / 0.546 | not reported |

  * The decoded value is lower than the paper's. The paper uses per-pair gate errors and weights from
    correlations in the measured data. Here a uniform average error model (2.2 % mean CZ error, with
    ±1.7 % spread) is decoded. Postselection keeps 1.6 % of shots here, against 5.5 % in the paper.

## Uncertain or not stated

* **Rotation sign convention.** The paper does not state the sign convention of its "Y rotation". This work
  assumes Ry(t) = exp(-i t Y/2), so +pi/2 = SQRT_Y. Flipping the convention changes only constant outcome
  signs. Detectors and distances do not change.
* **Observable signs.** The raw-record parity of an observable can differ from the paper's value by a known
  constant frame. The sources are the Ry(pi) echoes (5 on D1 D3 D4 D6 D7 D9, 3 on D5) and the readout mapping
  of ancillas that are not reset. For example, the noiseless Z_L1Z_L2 record parity is 1 for the +1 state.
  verify.txt (b) gives the mapping for each circuit.
* **Exact timing.** Per-step timing is not published. Only these values are given:
  * 48 ns single-qubit pulses;
  * CZ of 101.5 ns on average, plus 20 ns buffers on each side;
  * readout of 175-300 ns;
  * 1.66 µs between cycles of the same type.

  Individual CZ lengths, readout lengths per qubit, and the overlap of readout with the following steps are
  not given. `meta.json/derived_schedule` fits the layers to the 1.66 µs grid and is marked DERIVED.
  The first cycle and the split cycle come out 120 ns off the grid. The post-split cycle time is assumed to
  stay at 1.66 µs; it is stated only for the separate repetition-code experiment.
* **Injection pulses.** For the injected states the paper gives the initial-state pattern but not the pulses.
  This work uses the minimal Clifford pulses. The 45° states of Fig. 4 are non-Clifford, so they are left out.
* **Syndrome indexing.** The paper's split-syndrome index (sigma_4 with s_4 s_3) is inconsistent with the
  source data, which uses sigma_0..sigma_5. The construction here follows the physics.
* **Control electronics.** Not stated.
* **Decoding.** Offline only (MWPM with pymatching). Pauli-frame updates are virtual. The data record
  (doi:10.3929/ethz-c-000783470) contains only figure source-data CSVs: no circuits, schedules or code.
* **Not modelled.** Leakage (runs with |2> are rejected in the experiment), measurement-induced dephasing,
  crosstalk, and the coherent 0.11π phase rotation on L1.
