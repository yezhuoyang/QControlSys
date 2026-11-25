# Lacroix et al. 2025: color code on Willow

Paper: N. Lacroix, A. Bourassa et al., "Scaling and logic in the color code on a superconducting quantum processor", Nature 645, 614-619 (2025), arXiv:2412.14256. Data: Zenodo 10.5281/zenodo.14238944.

This folder contains Stim circuits and a sourced timing table for running the paper's experiments on a digital twin of its 72-qubit Willow device. `meta.json` has every number together with a verbatim quote and the section it comes from. `verify.txt` is the output of `python -I verify.py`.

## Files

| file | what | exactness |
|---|---|---|
| `memory-d3-{east,north,west}-{X,Z}-r{03,05,09}.stim`, `memory-d5-{X,Z}-r{03,05,09}.stim` | the authors' `circuit_ideal.stim`, copied byte for byte from `dataset_0/<patch>/<basis>/r<R>/` in the Zenodo zip (`data/zenodo/SOURCES.tsv` maps each file to its source) | exact |
| `data/zenodo/*.noisy_si1000.stim`, `*.metadata.json`, `memory-d5-Z-r05.chromobius_si1000_prior.dem` | the authors' noisy circuits, metadata and one decoder prior, used by the checks | exact |
| `circuit-teleport.stim` | lattice-surgery teleportation of \|1_L> from L1 to L2 (the Fig. 15 example), with L2 read out in Z | reconstructed |
| `circuit-teleport-{0,1,plus,minus}.stim` | the four input states the paper reports, with L2 read out in the eigenbasis of the input | reconstructed |
| `build_teleport.py` | generator for the teleport circuits. It contains the gate tables transcribed from Fig. 15 and derives the detectors and observables | |
| `teleport-records.json` | for each teleport circuit: the meaning of each measurement, the measurement set of each detector, the observable, the m1 (M_XX) and m2 records, and the figure-to-chip coordinate map | |
| `verify.py`, `verify.txt`, `verify-summary.json` | the checks and their output | |
| `meta.json` | citation, device, timings, electronics, decoding, results, exactness list and checks | |

The Zenodo record holds only the memory (state-preservation) experiments. It has the patches d3_east, d3_north, d3_west and d5, the bases X and Z, and the round counts r03 to r29 in odd steps plus r20. There is no r01. We copied r03, r05 and r09.

All 240 `.stim` entries in the zip have the same CRC32 in datasets 0 to 3, so the dataset_0 copies represent all four datasets. The 738 MB zip was read with HTTP range requests, so only the needed members were downloaded.

## Method: memory circuits

The memory circuits are the authors' own files and were not edited. Coordinates are `QUBIT_COORDS(row, col)` on the chip grid, with the same axes as the paper's Fig. 8. The circuits are already compiled to native gates (H and CZ). They also already include the readout-line role swaps of App. C.3, which is why the two auxiliaries of a tile are not neighbours.

- **Detector coordinates.** The 4th coordinate is Chromobius's basis/color code. The first two are abstract coordinates chosen by the authors, not chip positions.
- **Sweep bits.** These encode the random initial bitstrings.
- **Reset-only qubits.** Some qubits are reset every cycle but never gated or measured: 2 per d=3 patch and 4 for d=5. The paper does not say why.
- **Unused listed qubits.** d3_east and d3_west each list one qubit that the circuit never touches.

## Method: teleportation circuit

The paper published no circuit file for this experiment, so we rebuilt it from the figures.

1. **Gates.** The paper's LaTeX source contains Fig. 15 as a vector PDF. We rendered it at 6x and transcribed every CNOT in panels 0-29.
   - Each cycle has 8 CNOT layers: a Bell-pair preparation of the two auxiliaries, 3 layers that collect the Z parity (data to auxiliary), 3 layers that collect the X parity (auxiliary to data, same pairs in the same order) and the final Bell-measurement CNOT.
   - The auxiliaries are measured as M_X on the one reset into |+> and M (Z basis) on the other.
2. **Stabilizers** come from Fig. 5c-e and match every statement in the text:
   - **L1 and L2.** Each is a 7-data-qubit d=3 color code with three weight-4 tiles. L2 is L1 mirrored, with the red and green colors swapped.
   - **Merge (3 cycles).** The green tile of L1 and the red tile of L2 grow to weight 6 by adding the two interface data qubits. Those two qubits are prepared as a Bell pair in merge cycle 1 and measured in the Bell basis in merge cycle 3.
   - **Interface stabilizers.** Two new X-only stabilizers (the hatched tiles) are measured by the row-4 auxiliary pairs. Read off the figure, their weights are 5 and 3. The paper gives no weights; it only says "two new X-basis stabilizers".
   - **Hatched-tile Z outcome.** On a hatched tile, the Z outcome of the auxiliary pair is a deterministic check of the auxiliaries themselves. It acts as a flag and is annotated `-1` (ignored) for Chromobius.
   - **Split (1 cycle).** The split cycle and the final readout are identical to the initialization cycle (panels 20-29).
3. **Detectors** are not written by hand. For each stabilizer measured in a cycle, `stim.Circuit.solve_flow_measurements` finds two sets of measurements, one cycle at a time: the set that reveals the stabilizer in this cycle, and the set that fixed its value at the end of the previous cycle. A detector is the XOR of the two sets. If a stabilizer is not fixed by the previous cycle alone, the solver steps back one more cycle and repeats.
   - The superdense circuit applies conditional data flips, which the paper handles "in pre-processing". These flips show up as extra auxiliary-measurement terms in some detectors.
4. **Observables** follow the paper's frame update Z_L^m1 X_L^m2 on L2.
   - **Z-basis inputs.** OBSERVABLE 0 = Z_L2 xor m2, where m2 = Z_L1 is read from L1's final data measurement.
   - **X-basis inputs.** OBSERVABLE 0 = X_L2 xor m1. The flow solver independently finds m1 to be exactly the M_X outcomes of the two interface stabilizers in merge cycle 3, multiplied by the M_X of the interface data qubit. That matches App. I.1: "The M_XX parity outcome is the product of the two interface X stabilizers and the additional data qubit read out in the X basis".
   - m1 itself is random, so it cannot be a Stim observable. Its measurement indices are stored in `teleport-records.json`.
5. **Layout.** Data qubits are initialized in the same layer as the auxiliary resets, as in panel 0. Data qubits that idle during an auxiliary readout get an explicit `I`, standing for the XY4 dynamical decoupling. This is the same convention the authors' Zenodo circuits use.

## Verification summary (`verify.txt`)

- **Determinism.** Every circuit gives all-zero detectors and observables over 1000 noiseless shots. That is 24 memory and 5 teleport circuits. The memory circuits were also run with 20 random sweep-bit initial strings.
- **Counts match the paper.**
  - d=3: 7 data + 6 auxiliary = 13 qubits ("three 13-qubits subsets").
  - d=5: 19 + 18 = 37 ("37 qubits of a 72-qubit quantum processor").
  - Each memory cycle has 10 CZ layers: 8 CNOT layers plus "only two layers of two-qubit gates" from App. C.3. That is 30 CZ per cycle for d=3 and 102 for d=5.
  - Adding up the App. B durations over the files' layers (7 H layers at 18 ns + 10 CZ layers at 37 ns + 600 + 160 + 53 ns) gives **1309 ns**, against the paper's "approximately 1.3 µs". This sum is our own derivation.
- **Noisy circuits are the ideal ones plus SI1000.** Applying an explicit SI1000 rule set (p = 1e-3) to each ideal file reproduces the authors' `circuit_noisy_si1000.stim` instruction for instruction in all 24 cases. The rule set:
  - 2-qubit gates: DEPOLARIZE2(p).
  - 1-qubit gates and idling: p/10.
  - Reset: flip 2p, with idlers getting an extra 2p.
  - Measurement: flip 5p, then DEPOLARIZE1(p) on measured qubits, and 2p on idlers except those under dynamical decoupling.

  Stripping all noise from each noisy file also gives back the ideal file exactly.
- **DEMs** (`decompose_errors=False`):
  - d3, r09: 54 detectors and 1375 or 1382 error mechanisms.
  - d5, r09: 162 detectors and 5097 or 5101 error mechanisms.
  - For d5-Z-r05, our DEM matches the authors' `chromobius_decoder_with_si1000_prior/error_model.dem` hyperedge for hyperedge (2637 of 2637, identical probabilities).
- **Chromobius on simulated SI1000 data** (20 000 shots; this is not the experimental data):
  - d3, r09: logical error 0.028 to 0.033.
  - d5, r09: 0.026 to 0.033.
- **Teleport circuits.**
  - Size: 32 qubits, 88 measurements and 71 detectors. The detectors plus the observable span the entire 72-dimensional space of deterministic measurement parities (checked by GF(2) rank against noiseless samples), so no detector is missing.
  - Correctness: the raw noiseless observable equals the expected logical bit for \|0>, \|1>, \|+> and \|-> (0, 1, 0, 1), and m1 comes out random.
  - Circuit distance: the shortest undetectable logical error that `search_for_undetectable_logical_errors(3, 3)` finds has weight **3**, which equals d. This is the same search the paper ran in App. C.2 (an upper bound).
  - Decoding: under SI1000 noise, the DEM has 1947 error mechanisms. Chromobius decodes it, with a simulated logical error of 0.036 to 0.037 for Z-basis inputs and 0.015 to 0.016 for X-basis inputs.

## Uncertainties and limits

1. **Teleport chip placement is assumed.** The paper gives no chip coordinates for the teleportation experiment. We place Fig. 5's figure grid at offset (+0, +3), so the qubits occupy rows 0-8 and columns 3-8, with the interface on row 4. We chose this placement because it fits the 72-qubit grid and overlaps most with the paper's d=5 patch, not because the paper says so.
2. **Teleport compilation is unknown.** Fig. 15 draws plain CNOTs in the untransformed layout, where the two auxiliaries of a tile are neighbours. The memory runs used H+CZ compilation and the readout-line role swaps, which the paper says "are applicable to arbitrary distances". The paper does not say whether the teleportation run used those swaps. Our circuit is the circuit as drawn, and its cycle-time estimate (≤ 1218 ns: ≤ 9 H + 8 CZ layers + readout + reset) is our own.
3. **Not modelled in the teleport circuit:**
   - Y-basis tomography of L2. Its value is random for Pauli-eigenstate inputs, so it has no Stim observable.
   - Dynamical-decoupling pulse timing.
   - DQLR, which the paper states only for state-preservation experiments.
   - The 0.044π phase offset is not modelled; it belongs to the injection experiment anyway.
4. **Teleport sign conventions are relative.** Pauli signs and frame-update signs are handled by Stim's reference frame. Detectors and observables are therefore deterministic relative to the noiseless reference, and the raw logical values match the expected eigenvalues.
5. **One CNOT in Fig. 15 lacks its dashed box.** Fig. 15 panel 18 draws the interface Bell-measurement CNOT without the dashed "last cycle only" box. We apply it only in merge cycle 3, because applying it in every merge cycle would destroy the merged stabilizers. Panels 11 and 19 do box their interface operations.
6. **Decoding was offline, by inference.** The paper never uses the word "offline". It decodes with AlphaQubit fine-tuned on experimental data, an MLE decoder that is about 1000x slower than Chromobius, and Chromobius, which it calls "a promising candidate for real-time decoding in the near future". It also applies the teleportation frame updates "in post-processing".
7. **Quotes are rendered as plain text.** The paper's LaTeX math (for example `$35\text{\,}\mathrm{ns}$`) appears as plain text ("35 ns") in the quotes.

## Reproduce

```
python -I build_teleport.py   # rewrites circuit-teleport*.stim and teleport-records.json
python -I verify.py           # writes verify.txt and verify-summary.json (about 20 s; needs stim, numpy, chromobius)
```
