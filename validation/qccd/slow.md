# Sideband spectroscopy after slow ion transport

Jain and coauthors moved a single beryllium-9 ion about 30 µm along either the x or z axis of a microfabricated Penning trap. A one-way transfer took about 300 µs. They compared sideband scans following transport with stationary scans of equal waiting time. The figure covers magnetron, cyclotron and axial motion, with spectra on the red and blue sidebands. Optical state detection gives the bright-state population. [Published experiment and Extended Data Fig. 2](https://doi.org/10.1038/s41586-024-07111-x)

## Inputs and replay

| Stage | Representation |
| --- | --- |
| Transport control | A version 2 Lean program plays a nominal 30 µm return path. The paper specifies four transport repetitions for the radial modes and ten for the axial mode. We interpret a complete repetition as outward and return. One leg uses five equal 60 µs intervals and half-cosine position knots. Both the interpolation and the DAC mapping are reconstruction choices. |
| Stationary control | The program holds the starting position for the same number of clock cycles as its transported partner. |
| Probe setting | A final word carries the signed detuning. The physical experiment used Raman sideband interrogation. Time-multiplexing this separate control coordinate onto the reference DAC reproduces its setting in a single executable trace. The laboratory probe-carrier waveform, exact electrode samples, wiring, photon shots and absolute probe timing are unavailable in the deposit. |
| Trace checks | The response model reads the actual conversion times and calibrated DAC outputs. It requires complete transport legs, initial and final returns, and permits ±1% in knot timing and ±0.3 µm in the reconstructed command. It declines trajectories outside this domain. These thresholds constrain executable inputs and do not describe measured tracking precision. |
| Device hypothesis | For this slow return, the transported ion preserves its matched stationary sideband spectrum. The final delivered detuning selects a bright-population prediction by linear interpolation on the matching stationary scan. Queries just outside the stationary scan take its nearest measured endpoint. |

Calibration uses all **229 stationary measurements**. Every one of the **201 visible transported measurements** is held out, including both travel axes, all three modes and both sidebands. The step from the verified controller to the bright probability is a calibrated endpoint hypothesis. The model does not compute the intermediate ion trajectory from electrode fields, estimate a post-shuttle phonon occupation, generate a Raman transition from first principles, or determine the full dephasing of the internal qubit.

The criterion selected before extracting observations was held-out absolute bright-population RMSE ≤0.10, an engineering tolerance of ten percentage points. The actual RMSE is **0.08095**. The largest residual is **0.29283** at +2.729 kHz for blue-sideband interrogation of the magnetron mode following x-axis transport. Passing the aggregate criterion therefore coexists with substantially larger errors at individual settings. This endpoint comparison is independent of the faster Clark calcium-ion trajectory, which misses its own position-error criterion. [Jain et al.](https://doi.org/10.1038/s41586-024-07111-x) · [Clark et al.](https://doi.org/10.1103/PhysRevA.107.043119)

## Data provenance

The ETH Zürich data repository deposits the Fig. 2 and Fig. S1 tables. Its archive omits the source setpoints and camera-coordinate associations for Fig. 3 as well as numerical tables for Extended Data Fig. 2. The transport benchmark uses the authors' original vector file `FigS2.pdf` from arXiv v2. The extractor selects the measured red diamonds and blue circles with centers inside each displayed x axis, and maps each center against that panel's −10, 0 and +10 kHz ticks and 0–1 probability grid. The colored fits, error-bar caps and markers clipped outside the plot are excluded. The local rows round detuning to 0.001 kHz and population to five decimal places for extraction reproducibility. [Authors' source](https://arxiv.org/src/2308.07672v2) · [ETH research deposit](https://doi.org/10.3929/ethz-b-000627348)

| Artifact | SHA-256 |
| --- | --- |
| arXiv v2 source | `0ca9a27d15a054a5d5d7cbb2d45a76ec3ce7d5af8543ccf3d0cc1afec82016b5` |
| `FigS2.pdf` | `0b864cfd8c37970fe78af091d8e60fb1283b3b8f2d243f969afb5a012a836942` |
| `slow_fig_s2.csv`, LF newlines | `99766aaa392e2589bb14554fada4a2c1da4617e17d535130a3bdf199393f0253` |
| Companion ETH deposit archive examined for raw source tables | `0bdaaa175ffc02e44946c263f70263b98750df81a838f9649910d51005a83d05` |

Attribution belongs to Shreyans Jain, Tobias Sägesser, Pavel Hrmo and coauthors, *Penning micro-trap for quantum computing*, Nature **627**, 510–514 (2024). The published article is licensed CC BY 4.0. The preprint is distributed under the arXiv non-exclusive license. The local CSV contains extracted factual coordinates and condition labels. [Article license](https://creativecommons.org/licenses/by/4.0/) · [Preprint metadata](https://arxiv.org/abs/2308.07672v2)

Run `python -B validation/qccd/extract_slow.py` to regenerate the CSV, or pass a local versioned source archive as its argument. Only regeneration requires PyMuPDF 1.28.2. Scoring uses the checked table, Python's standard library, and the native Lean controller.
