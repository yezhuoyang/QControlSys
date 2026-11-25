# Bluvstein et al. 2025: Stim circuits and hardware timeline for a digital twin

Paper: D. Bluvstein et al., *Architectural mechanisms of a universal fault-tolerant quantum computer*, arXiv:2506.20661v1, published as *A fault-tolerant neutral-atom architecture for universal quantum computation*, Nature 649, 39–46 (2025), doi:10.1038/s41586-025-09848-5.
All quotes come from the arXiv v1 HTML, saved as `anc/arxiv-2506.20661v1.txt`. The Nature text was not read.

## Files

| file | what it is | status |
|---|---|---|
| `original-noisy.stim` | The authors' `Stim_circuit_repeated_QEC_Xbasis.txt`: d=5, 4 rounds, X basis, with their noise | byte-identical copy |
| `circuit-qec.stim` | Same file with only the 160 noise lines removed (`PAULI_CHANNEL_1/2`, `X_ERROR`) | exact. TICKs (8), DETECTORs (96), OBSERVABLE_INCLUDE (1) and the 66 `I` idle markers are verbatim. The file has no `QUBIT_COORDS`. Inferred coordinates are in `schedule-qec.json → qubits` |
| `schedule-qec.json` | Hardware timeline from `RawExperimentalCommands_SurfaceCodeQEC.pdf`: 238 steps on one clock, the four parsed AWG streams, geometry (SLM↔µm, combs, zones, per-qubit positions), totals per round, and the Stim line labels | command durations are exact. The alignment between AWGs is fitted |
| `circuit-surgery.stim` | Lattice surgery Z_L1·Z_L2 between two d=5 codes: merged 5×10 lattice, 2 rounds, final Z readout. Observable = data Z_L1Z_L2 ⊕ seam outcome | reconstructed (not published) |
| `circuit-surgery-xx.stim` | Same, with final X readout. Observable = X_L1X_L2 | reconstructed |
| `circuit-surgery*-noisy.stim` | The surgery circuits plus the Pauli part of the paper's error model, placed exactly as in the authors' file | reconstructed |
| `verify.py` → `verify.txt` | All checks (stim 1.15, pymatching). Result: **ALL CHECKS PASSED** | |
| `meta.json` | Citation, device, timings, electronics, decoding, results, exactness, checks. All 89 quotes are machine-checked as verbatim substrings of the sources | |
| `gen_surface.py`, `build_surgery.py`, `awg_parse.py`, `build_schedule.py`, `build_meta.py` | Generators: rerun `python -I build_schedule.py; python -I build_surgery.py; python -I verify.py > verify.txt; python -I build_meta.py` | |
| `anc/` | arXiv ancillary files, plus the paper HTML/text and the extracted .docx texts. The ~1 GB Zenodo data was not downloaded | |

## Method

1. **Published circuit → template.** The published CZ layers give each ancilla's partners. Ancilla (ra,ca) at a plaquette centre touches these data qubits:
   - layer a: (ra+½, ca−½)
   - layer b: (ra−½, ca−½)
   - layer c: (ra+½, ca+½)
   - layer d: (ra−½, ca+½)

   The round orders are abcd, acbd, dbca, dcba ("N Z Z_r N_r"). `gen_surface.py` encodes these rules, including the boundary-ancilla early/late basis changes with local Y echoes, the global Y echoes and the idle/noise placement. It reproduces the published file **instruction by instruction, with and without noise** (`verify.txt` §3).
2. **Command strings → timeline.** `awg_parse.py` extracts the four command strings from the PDF: Moving AOD, Raman, Raman AOD and Rydberg. The PDF uses U+2010 for minus signs and no-break spaces. Verbatim text is kept in `details`, and NBSP is normalised to a space.
   - The Moving-AWG clock is the reference (t=0 at `SEGMENT[4]`, "Start of circuit").
   - Each other AWG gets one constant offset, fitted so that its 16 CZ anchors coincide with the 16 `Wait[10 us]` CZ holds. Residuals are ≤0.03 µs for Rydberg, ≤2.6 µs for Raman and ≤1.4 µs for Raman-AOD.
   - Each local Raman pulse is paired with the Raman-AOD row tones lit during its 5.82 µs slots.
3. **Timeline → Stim.** Every step has `maps_to_tick` (the TICK layer of `circuit-qec.stim`: 0 = prep, 1/3/5/7 = rounds, 8 = readout) and `stim_lines` (exact 1-based lines).
   - Rydberg pulse k is the k-th `CZ` line.
   - Raman local pulses are the `SQRT_Y` and `Y` lines. Their lit Raman-AOD rows predict all 34 target sets exactly.
   - The `SC1_ECHO` global π pulses are the 8 `Y`-on-all-49 lines.
   - AOD moves are the idle `I` markers of their CZ gap or block exchange.
   - The final spin-to-position moves are the `M` lines.
   - Every Stim operation line is realized by at least one hardware step.

## Key findings

- **4.45 ms per round is consistent across all sources.**
  - Moving AWG, rounds 2–4: 4 × 470 µs (195 µs move, 10 µs CZ hold, 195 µs move back, 70 µs local gates) + 2570 µs exchange (1250 µs return + 1250 µs pick-up + 70 µs) = 4450.0 µs. This matches the paper's "0.47 ms … 2.57 ms".
  - Rydberg: 4 × (2.2 + 467.8) + 2570.02 = 4450.02 µs.
  - Raman: 4449.16 µs. Raman AOD: 4449.8 µs.
  - The **noise model in the authors' Stim file uses the same clock**: idles of 2 × 235 µs per gap and 2 × 1285 µs per exchange give 4450 µs per round.
  - Round 1 differs. The first ancilla block is placed before the circuit, and the round starts with the data π/2 pulses, "fake" ancilla π/2 pulses (Raman AOD tones off) and a 76 µs global echo.
  - Notes inside the command string contradict its own durations: "1 ms" exchange (commands give 2 × 1.25 ms), "Move data back … 1.2 ms" (1.85 ms), and "SSR on half, 1.2 ms" (2.1 / 1.9 ms).
- **Physical atoms are not Stim qubits.** The 24 ancilla indices are reused across rounds, but each round uses a fresh block of 24 atoms. The 121 measurements equal 121 atoms. All atoms are read out once at the end, by spin-to-position conversion (two half-array moves of 0.5 SLM ≈ 2.3 µm in 0.7 ms) after a 4.7 ms Raman bright-state transfer.
- **Geometry**
  - Data (r,c) sit at SLM (16+3c, 2+2r), which is a 13.8 × 9.8 µm pitch.
  - The ancilla home is (16.36+3ca, 2+2ra). A CZ pair is separated by 0.36 SLM ≈ 1.66 µm.
  - The 7 gate-site rows are at y = 0…12 SLM, a 59 µm extent (paper: 60 µm).
  - The storage/readout rows are 21+1.98j, 40 µm away (paper: 40 µm).
  - The array is 36 columns wide, 165.6 µm (paper: 165 µm).
  - The six interlaced blocks sit at x offsets 0 (data), 1, 1.938, 17.959, 18.972 and an unused fifth.
- **PyMatching on the authors' noisy circuit** (Pauli only, no loss, 400k shots):
  - LEPR(d=5) = 0.196 ± 0.004 % in the X basis. Averaged with the generated Z-basis circuit it is 0.194 %.
  - The paper reports 0.62(3) % with the hybrid ML+MLE decoder on real data including loss, and "toward 0.1 % per round on shots with no qubit loss".
  - The Pauli-only number sits between the two, as expected when loss (about half the errors) is absent. The d=3/d=5 ratio is 4.2 here versus 2.14(13) in the experiment. Here d=3 is a standalone patch, not a quadrant.
- **Lattice surgery**
  - With the paper's choice ("the seam checks from the final data qubit measurement are not included"), Z_L1Z_L2 has time-like distance 2. A single seam disagreement between the two rounds is ambiguous.
  - PyMatching gives a ZZ error of 9.9 % (4.4 % after error detection on the 3 seam Z checks, 81 % acceptance) and an XX error of 0.92 %.
  - The ZZ error rises steeply with injected ancilla measurement error (9.7 → 20.9 % at p=0.04), while XX rises only 0.95 → 1.16 %. This qualitatively reproduces Fig. 3c.
  - If the final seam detectors are included instead, ZZ becomes a product of detectors and can never fail. This is shown in `verify.txt`.
  - The paper gives no numeric lattice-surgery error in its text, only Fig. 3c,d.

## Uncertainties and approximation boundaries

- **Cross-AWG alignment** is fitted, not given. Raman blocks slip by up to ±2.6 µs against the 470 µs Moving period because the Raman waveform is one phase-continuous string. The `SEGMENT[6]` start is placed at the end of the Raman bright-state transfer (an assumption). `SEGMENT[1]` loops until a trigger, so its time is `null`. `SEGMENT[2]` is placed back-to-back before t=0.
- **Durations not stated in the commands** (rules are in `schedule-qec.json → duration_rules`):
  - The Rydberg `Pulse[]` segment of 2.2 µs is inferred. The gate itself is 270 ns.
  - `BB1_FIXED` and `CPROBUST180` are taken as their time argument.
  - Optical pumping is taken as 24 × 8.53 µs.
  - Raman-AOD tone switches are taken as 0 µs.
  - Camera exposure for this experiment is unknown, so the image step has `duration_us: null`. The deep-circuit experiments used 10 ms imaging, a different setup.
- **Positions**
  - The µm values use the paper's approximate 4.6 / 4.9 µm per SLM unit.
  - The AOD trajectory profile (linear, minimum-jerk, …) is not given.
  - The Raman-AOD row coordinates come from an unpublished file. Data rows `r0_d…r5_d` are six labels for five data rows, so one row addresses an empty tone row. Which one is not determinable.
- **The surgery circuit** is a reconstruction. The assumptions are:
  - code 2 is the mirror of code 1, so the merged lattice is a standard 5×10 code;
  - the 2 rounds use orders abcd and acbd;
  - the per-round timing and idle model are the same as in the QEC circuit;
  - one joint PyMatching decode stands in for the paper's two MLE decodes.

  The paper's hardware placement of the two ancilla blocks per round, and which block supplies the seam column, is not specified.
- **Noise.** Only the Pauli part of `Error_model.docx` is used. Loss, superchecks and the delayed-erasure decoding cannot be expressed in Stim/PyMatching. The LEPR values are sanity checks, not reproductions of the experiment.
- **Global π pulses outside the Stim echo lines.** The data-prep echo `SC1_ECHO[6]`, the round-1 `SC1_ECHO[76]`, and echoes that hit stored ancilla blocks only flip signs. They are absent from the authors' Stim file and are marked as such in the schedule.
