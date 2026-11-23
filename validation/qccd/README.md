# Fast axial transport of a calcium ion

Clark et al. programmed a 120 µm linear transport of a single calcium-40 ion above a GTRI surface-electrode trap in 1.2 µs. An independent stationary scan first mapped the probability of 854 nm optical deshelving against trap position. The authors then applied the probe during transport and used that mapping to infer ion position at each delay. Figure 2(b) shows the measured probabilities from 100 repetitions per delay. Figure 2(c) shows the inferred positions. [Paper](https://doi.org/10.1103/PhysRevA.107.043119) · [Versioned preprint](https://arxiv.org/abs/2301.05279v2)

## Measurement and scoring

| Item | Definition |
| --- | --- |
| Input | 30 updates separated by 40 ns, with 120 µm commanded travel. Each repeat uses the same transport and a different probe delay. |
| Observation | The black marker in Fig. 2(c) at each plotted delay, in µm. The local table also retains Fig. 2(b) probabilities and the plotted vertical error-bar endpoints from both panels. |
| Simulated signal | A signed 16-bit DAC represents the normalized along-axis potential-minimum command. The 30 reconstructed positive words correspond to 4, 8, …, 120 µm. The model places the first update at the end of the first 40 ns interval. |
| Physical approximation | The ion follows the delivered well command at each zero-order-held DAC update. We average displacement uniformly over the 200 ns 854 nm pulse starting at the stated delay. This approximates a time-integrated nonlinear optical measurement and its inversion by the authors. |
| Calibration | Only the first 100 ns of the transport series, 11 plotted settings, register one output position offset. This is a nuisance offset from early dynamic measurements. The paper's separate stationary optical scan performed a different calibration. |
| Held-out observations | All 150 later probe delays in the same sweep, including the transition and final plateau. These are held-out settings on one waveform. |
| Criterion | Unweighted held-out RMSE ≤12 µm, chosen before scoring as 10% of specified travel. It is an engineering tolerance. Statistical confidence bounds for the device would require a separate analysis. |
| Result | The common Lean runner gives 19.895 µm held-out RMSE and 48.751 µm maximum absolute error. The fast shuttle misses the criterion. |

The trap used a two-pole electrode filter with 608 kHz bandwidth and an axial trapping frequency around 2.2 MHz. Filtering different electrode voltages can change both the position and curvature of the potential minimum. The source archive supplies plotted observations and the commanded trajectory but omits per-electrode traces, the electrostatic basis, the complete filter transfer functions, and individual photon shots. The controller therefore simulates a physically dimensioned effective command. The position residual is evidence against instantaneous command following for this apparatus and waveform. The authors' red empirical position fit and derived velocities are excluded from the score. [Methods and Fig. 2](https://arxiv.org/pdf/2301.05279v2)

## Source and extraction

`fig2.csv` was extracted from the authors' vector graphics, with each row corresponding to a plotted marker. The origin and scale come from each panel's axis spines. The fit curve is a separate colored vector object. Both panels expose 161 marker centers across 0–1500 ns, implying a plotted interval around 9.375 ns. The caption reports a nominal 10 ns sweep. We preserve the plotted x positions, rounded to 0.01 ns. We round positions to 0.001 µm and probabilities to six decimal places. These digits support reproducible extraction, and the experimental error bars describe much larger uncertainty. The raw fluorescence records are unavailable in the archive. [Versioned source archive](https://arxiv.org/src/2301.05279v2)

| Pinned artifact | SHA-256 |
| --- | --- |
| arXiv v2 source archive | `817ccada93fe9638f4836502c571ebed833e614ffdbcb1b844a511f051260f27` |
| Archive member `20230324_Transport_Fig2_3panel.pdf` | `59f87b37058b61f6c310c90f7bc7724a0afc52cd5de5d23d17430396e7bb30da` |
| Extracted `fig2.csv`, LF newlines | `ceeac8c994a8e0e5814bb71b27092ed7cb222e578d99bb1772d049a457277c6e` |

Attribution belongs to Craig R. Clark and coauthors, *Characterization of fast ion transport via position-dependent optical deshelving*, Phys. Rev. A **107**, 043119 (2023). arXiv lists its non-exclusive distribution license for this source. This repository contains the extracted factual measurements and source hashes. The authors' paper, artwork and typesetting stay at the source. [arXiv rights statement](https://arxiv.org/licenses/nonexclusive-distrib/1.0/)

Run `python -B validation/qccd/extract.py` to download the pinned source and regenerate the table, or pass the source archive path for offline regeneration. This optional extraction uses PyMuPDF 1.28.2. Ordinary experiment replay reads the checked CSV with Python's standard library and runs the project's Lean executable.

## Native QCCD Studio design

`design.json` records source instruction 2 from the sibling QCCD Studio H2 GHZ32 program. In native step `tsir-2-0`, ion `q0` moves from `AUXD0` through edge `e00` to `DG01`. Action `L0:+1` engages channel `zone.AUXD0`. The declared interval is 1–3 model units. Run `python -B validation/qccd/verify_design.py` against a configured QCCD checkout to replay and verify the selected source instruction, placement transition, assigned channel and enclosing run totals. This native design supplies routing semantics. Clark's separate apparatus supplies the physical transport measurement. [Pinned Studio program](https://github.com/yezhuoyang/QCCD/blob/97c94dbcb92c63cc529c451363603f1a813388cf/Reproduce/moses2023/demo/ghz32.tsir.json)
