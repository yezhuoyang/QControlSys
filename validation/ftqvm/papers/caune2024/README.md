# Caune et al. 2024/2026 — stability-8 with a real-time FPGA decoder (Rigetti Ankaa-2)

L. Caune et al., *Demonstrating real-time and low-latency quantum error correction with superconducting qubits*,
arXiv:2410.05202 (v1 only, 7 Oct 2024); published as **Nature Communications 17, 7383 (2026)**,
doi:10.1038/s41467-026-73331-6. The authors' data, Stim circuits and **the executed Quil and assembly programs** are on Zenodo:
doi:10.5281/zenodo.13961129.

## Files

| file | what |
|---|---|
| `circuit-stability-r5.stim`, `-r9`, `-r25` | noiseless stability-8 circuits; **R = decoding rounds** (the x-axis of the paper's Fig. 3), with R+1 syndrome-extraction rounds. Gate schedule of the LEP runs (Fig. 2(e–j)). |
| `circuit-feedback-n9.stim` | the fast-feedback run with 9 measurement rounds (8 decoding rounds). It uses a different, four-CZ-layer schedule that was executed on 2024-07-17. |
| `feedback.json` | the fast-feedback test, the latency budget with quotes, decoder, bus and sequencer, and how syndrome bits reach the decoder |
| `meta.json` | citation, device, timings (value/unit/quote/section), electronics, decoding, results, exactness, checks |
| `verify.py` → `verify.txt` | checks with stim 1.15 and pymatching 2.4 (`python -I verify.py > verify.txt`) |
| `tools/gen_circuits.py` | generator (`python -I tools/gen_circuits.py . [lep d…] / [feedback n…]`) |
| `tools/text_runs.py`, `tools/extract_zenodo.py` | read the Zenodo HDF5 without h5py (described below) |
| `zenodo/extracted/` | the authors' 20 Stim circuits and 20 executed programs (`main_measNN*` = LEP runs, 2024-06-14; `ff_measNN*` = fast-feedback runs, 2024-07-17), plus `*_groups.json` with the calibration durations |
| `zenodo/*.txt, *.csv` | the authors' LEP, defect-rate and timing tables |
| `src/`, `render/` | arXiv TeX source and the figures rendered to PNG |
| `journal/` | Nat. Commun. article text and Supplementary Information (`si.pdf`, `si.txt`) |

## Method

1. I read the arXiv TeX (main and supplement), rendered all 11 figure PDFs, and read the Nat. Commun. HTML and its Supplementary Information.
2. The Data-availability statement in the journal version pointed to Zenodo. h5py is not installed, so I streamed each HDF5 file through `tools/text_runs.py`. It keeps the printable runs with their newlines. Variable-length HDF5 strings are stored contiguously, so the Stim circuits and the Quil programs come out verbatim. The 740 MB LEP file was streamed and never stored. Only its 1.2 MB of text was kept.
3. I wrote `gen_circuits.py` from the executed programs. `verify.py` then checks that the generator reproduces all 20 published circuits.

## What the circuit is (exact)

- **Qubits.** The ancillas are Q36, Q38, Q50 and Q52. They measure Z37Z43, Z37Z45, Z43Z51 and Z45Z51. The data qubits are Q37, Q43, Q45 and Q51.
  - The "44/45 discrepancy" is not a real conflict. Fig. 1(b) lists the 3×3 patch [Q36…Q52] including its centre, Q44, which is the X-check position and is drawn orange. Methods lists the 8 qubits actually used. Fig. 2 marks the unused qubit as a black dot. No program touches Q44.
  - Ankaa-2 numbering is row-major with 7 qubits per row (col = q mod 7, row = q div 7). Fig. 1(b) and the readout maps both confirm this.
- **Schedule of the LEP runs (Fig. 3).** Fig. 2 matches the program instruction for instruction:
  - (e) RX(−π/2) on the data qubits, once only.
  - (f) RX(+π/2) on the ancillas.
  - (g) CZ 36‑37, 38‑45, 52‑51, 50‑43. Layer duration 176 ns, set by CZ 51‑52.
  - (h) CZ 37‑38, 45‑52, 51‑50, 43‑36. Layer duration 112 ns, set by CZ 37‑38.
  - (i) RX(−π/2) on the ancillas.
  - (j) MEASURE 36, 38, 52, 50, then the per-qubit ring-down DELAYs.
  - In the last round the final rotation is RX(−π/2) on all 8 qubits. The ancillas are read out first, then a FENCE, then the data qubits.
- **No resets.** Every shot begins with a 250 µs passive wait (`recycle_delay`). Because ancillas are never reset, the outcome obeys m_r = m_{r−1} ⊕ s_r. The detectors are therefore m_r ⊕ m_{r−2}, with m_2 alone in round 2. This gives the "edges connecting layers two rounds apart" of SI Fig. S2.
- **Observable.** The four checks multiply to the identity (an over-complete set). The observable is the product of the four round‑1 checks, which is the parity of the four first-round ancilla outcomes. Round 1 yields no detectors, so **decoding rounds = measurement rounds − 1**. The journal states this explicitly. The decoder config word written in every program (DACTLR, top byte) also equals n − 1.
- **Data readout.** Each data qubit is measured in the Y basis it was prepared in. Single outcomes are random, but their 4-bit parity, Y37Y43Y45Y51, is deterministic. Neither the authors nor I use this parity in any detector.

## Uncertainties and caveats

- **Two different schedules.** The fast-feedback runs (Fig. 4) did not use Fig. 2's two CZ layers. They used four layers of two CZs and RX(+π/2) everywhere, which both the program and the published Stim circuit show. The checks, detectors and observable are identical. Only the hook-error structure and the timing differ. Use `circuit-feedback-n9.stim` for the feedback twin.
- **"Rounds" in the feedback experiment are measurement rounds.** The abstract says "9.6 µs for a total of 9 measurement rounds". The main text calls the same run a "9-decoding-round experiment". The programs settle it: the 9-round point has 9 syndrome-extraction rounds and configures the decoder for 8 decoding rounds.
- **Which qubit gets the conditional X.** The paper says only "the qubit controlled by the gate sequencer on the same FPGA as the decoder". The programs identify it as **Q50**:
  - the decoder frame is `Transmon-50_charge_tx`;
  - the branch is `RX(pi) 50`, otherwise `DELAY 50 4e-8`;
  - Q50 is then measured.
- **The fixed delay before the feedback readout** ("≈ N_rounds µs") shows up in the programs as `push 50·N` wait-loop iterations on every sequencer, cancelled on the decoder's own frame. Reading this as the readout-side delay is my interpretation.
- **The quoted 948 ns, 964 ns and 336 ns readout times are summary numbers.** The per-qubit ancilla pulses are 948, 952, 976 and 984 ns, and the ring-downs are 144, 168, 192 and 336 ns. Fig. 2's 948 ns is the minimum, Methods' 964 ns is the median, and 336 ns is the maximum (Q38). The real measurement layer is 976 + 336 = 1312 ns, which gives the 1.68 ≈ 1.7 µs round.
- **Device medians (T1 13.2 µs, T2 10.6 µs, 93.3 % readout, 97.3 % CZ IRB, 99.86 % 1q RB) appear only in arXiv v1 Methods.** The journal version dropped that paragraph.
- **Coordinates and qubit indexing.** The authors' Stim files use 45°-rotated coordinates. I replaced them with lattice positions and kept the authors' qubit indices 0–7. The index-to-device map is derived, not stated in the paper, but it is consistent with the measured-qubit lists, the CZ adjacency and the rotated coordinates for all 8 qubits.
- **Two lines dropped.** The published circuits end with `SQRT_X …; S …` after the last measurement. These act on no recorded bit and do not appear in the executed programs, so I left them out.
- **Decoder register meanings** in `feedback.json` and `meta.json` come from labels and comments in the authors' assembly, not from the paper:
  - 0x1080: control
  - 0x1090: experiment config
  - 0x1098: DASR, the homology bit
  - 0x1800 + 4k: syndrome words
  - I_DFDECODE_STATUS: status poll
- **The control-hardware map is from Zenodo only.** It comes from the frame/hardware objects: instruments tsunami01/02/03 and 08/09/10, i.e. the "six readout regions", with the decoder on tsunami08, card 8. The paper does not give it.
- **Decoding is batch, not streaming.** The syndrome is sent after the last round, and the decoder is started once. The paper's 0.44–0.79 µs is the "mean decoding time per decoding round" of that single decode. I read it as total decode time divided by d, but the paper does not define it further.
- **The LEP comparison is a sanity check, not a reproduction.**
  - Under the paper's own SI noise model at p = 0.03, the simulation gives 9.1 % at d = 5 and 0.2 % at d = 25. That model is far too optimistic for the measured defect rate of 0.32.
  - A device-informed Pauli model gives 25 % → 7 %.
  - The SI model with p = 0.08, chosen to match the measured defect rate, gives 34.6 % → 19.3 %, against the paper's 28.1 % → 20.5 %.
  - Leakage, heating (defect rates rise with round), readout-induced state flips and drift are not modelled.
  - Measurement errors are modelled as classical flips, M(p). An `X_ERROR` before an un-reset measurement would flip the ancilla permanently and remove the two-round edges.
