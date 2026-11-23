# AOD drive frequency and measured Cs atom position

The calibrated single-axis model predicts five held-out atom positions with a root mean square error of **0.05040 µm**. The largest absolute error is **0.07620 µm**. The engineering acceptance limit of **0.25 µm RMSE** was chosen before opening the observations. It corresponds to 5% of a 5 µm array pitch.

## Measurement

Brooks et al. varied the RF frequency driving an acousto-optic deflector in a 938 nm tweezer and imaged a trapped caesium atom. Their Fig. 4(a) dataset contains 11 Gaussian-fitted camera centroids and a reported position error of 0.2027841 µm per setting. The experiment used a Spectrum M4i.6622-x8 arbitrary waveform generator sampling at 625 MS/s and an IntraAction ATD-1803DA2.850 deflector. The image coordinate decreases as frequency increases. [Paper, sections 2 and 5](https://doi.org/10.1088/1367-2630/ac0000) · [Deposited measurements](https://doi.org/10.15128/r1k3569440m)

Each case reconstructs a 32-sample segment of the published RF tone at a 1600 ps sample period. The control program moves signed waveform words from RAM through DMA and the FIFO into the DAC. The position estimator reads the delivered voltage samples and exact strobe times. It estimates the RF frequency from the recurrence `v[n−1] + v[n+1] = 2 cos(2π f Δt) v[n]`. The sample amplitude, phase, FPGA instruction order and segment length are reconstruction choices. The published figure supplies equilibrium positions and RF settings. The segment represents the tone during a hold and carries no claim that the atom travels to its final position within 51.2 ns.

## Calibration and held-out settings

Sort the settings by RF frequency and use zero-based even indices for calibration. Fit a position offset and a signed slope by ordinary least squares using only those six measurements. All five odd-index positions are held out. Measurements in the two groups share an apparatus and a sweep. This tests interpolation on that apparatus. Independent laboratory replication, multitone deflection, transport transients and atom survival require additional observations.

| RF setting (MHz) | Source row | Measured position (µm) | Predicted position (µm) |
|---:|---:|---:|---:|
| 135 | 1 | 12.04484 | 12.00642 |
| 155 | 3 | 5.65043 | 5.57864 |
| 175 | 5 | −0.92534 | −0.84914 |
| 195 | 7 | −7.29301 | −7.27693 |
| 205 | 9 | −10.48858 | −10.49075 |

The fit gives **−0.321388 µm/MHz** and a position of **0.757832 µm** at 170 MHz. As a separate optical check, inserting the paper's 938 nm wavelength, 35.24 mm objective focal length, 25× telescope and 4200 m/s sound speed into its equation (2) gives a slope magnitude of 0.314811 µm/MHz. The benchmark uses the measured apparatus calibration. The studio's illustrative crossed-AOD layout has its own calibration.

## Provenance

R. V. Brooks, S. Spence, A. Guttridge, A. Alampounti, A. Rakonjac, L. A. McArdle, J. M. Hutson and S. L. Cornish, *Preparation of one ⁸⁷Rb and one ¹³³Cs atom in a single optical tweezer*, New Journal of Physics 23, 065002 (2021). The 367-byte CSV preserves all four columns of the authors' deposit, including the original row identifier and reported error. Durham distributes the data under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Dataset record](https://researchdata.durham.ac.uk/files/r1k3569440m)

To verify the checked-in table against the primary archive, run the following from the repository root with Python's standard library.

```python
import hashlib, io, pathlib, urllib.request, zipfile

archive = urllib.request.urlopen("https://researchdata.durham.ac.uk/downloads/r1k3569440m").read()
assert hashlib.sha256(archive).hexdigest() == "59f2c7ef470f2e936c921a66e71c0b6255a38c09f657079bb5566c83d24f6df4"
with zipfile.ZipFile(io.BytesIO(archive)) as z:
    raw = z.read("Preparation of one 87Rb and one 133Cs atom in a single optical tweezer/"
                 "[fig4] tweezer control/fig4a_data.csv")
assert hashlib.sha256(raw).hexdigest() == "d1f55acc53db86e8791a3b30195e05af8e3a2b52dbf3469cc50cc85452b34b17"
local = pathlib.Path("validation/neutral/fig4a_data.csv").read_bytes()
assert raw.splitlines() == local.splitlines()
```

## ZAC design replay

The adapter reads an original two-AOD architecture and its paired 14-qubit Bernstein–Vazirani ZAIR compiler result. Both files, their native IDs and the upstream BSD 3-Clause licence are in `zac/`. The pinned commit is `e5083362f99e6915f20c2bd0eaa88b6d1cdcecac`. The code file identifies the matching architecture in its own `architecture_spec_path` field. [Architecture](https://github.com/UCLA-VAST/ZAC/blob/e5083362f99e6915f20c2bd0eaa88b6d1cdcecac/hardware_spec/full_architecture_2aod.json) · [Native compiler output](https://github.com/UCLA-VAST/ZAC/blob/e5083362f99e6915f20c2bd0eaa88b6d1cdcecac/result/zac/arch_eval/full_2aod/code/bv_n14_transpiled_code.json) · [Lin, Tan and Cong, HPCA 2025](https://arxiv.org/abs/2411.11784)

Each `rearrangeJob` in this circuit carries one native `activate`, `move:big` and `deactivate` instruction. The adapter checks all 26 jobs and 78 phases. It verifies site bounds, row and column tone ownership, preservation of tone order, consistency of recorded atom coordinates with the SLM pitch and origin, chronological occupancy at pickup and release, AOD availability, and preservation of atom identity. This adapter accepts the three-phase transport pattern present in the pinned fixture. Its checker reports unsupported transport patterns. Single-qubit and Rydberg instructions supply context in the original circuit, outside the transport replay. [Architecture fields and microsecond timing](https://github.com/UCLA-VAST/ZAC/blob/e5083362f99e6915f20c2bd0eaa88b6d1cdcecac/hardware_spec/README.md)

Job 5 is the first single-atom job. AOD 1 picks up qubit 0 from SLM 1 at row 0, column 0. The move crosses from (35, 307) to (39, 297) µm. The atom returns to SLM 0 at row 99, column 13. Native pickup, motion and release span 150.149–165.149, 165.149–227.731 and 227.731–242.731 µs respectively.

For the X projection, translating the requested +4 µm into a frequency change using the **nominal optical geometry** gives 170.000000 MHz at pickup and 157.293950 MHz at release. Both frequencies lie inside the measured range. Two actual controller traces deliver the RF samples. Applying the **independently fitted camera calibration** to those traces predicts a +4.083579 µm displacement, or +0.083579 µm relative to the ZAC command. The native −10 µm Y command and transfer times come from the compiler. Durham measured a different apparatus's static X response. The available observations establish neither a measured endpoint for the ZAC circuit nor its handoff, two-axis trajectory or gate fidelity.

From the repository root, reproduce the native replay and regenerate the website's compact design data:

```text
lake build
python -B validation/neutral/zac_adapter.py
python -B -m unittest discover -s validation/neutral -p test_zac.py
```

`design.json` records the exact upstream hashes, native phase coordinates and times, the two runnable controller programs, and their predicted displacement. `zac_adapter.py --output PATH` writes a separate copy for comparison. The regression tests check both AODs, an inconsistent endpoint, a swapped tone track, and the effect of changing delivered strobe timing on estimated RF frequency.
