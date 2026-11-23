# Coherent return transport in an RF Paul trap

Use only the eleven blue sideband-Rabi thermometry markers in Walther et al. Figure 3(a). Sort markers by dwell time. Reserve sorted indices 0, 3, 6 and 9 for calibration and hold out the other seven. The published solid pseudo-energy curve has an ambiguous inverse above roughly 50 phonons and is excluded throughout.

The acceptance criterion is an RMSE at most 10 mean coherent phonons across the seven held-out dwell settings. The tolerance addresses the approximately 100-phonon sweep. It cannot resolve ground-state fidelity near the minima. This protocol was fixed before numeric residuals were computed.

Use the independently measured axial frequency of 1.41 MHz. Represent each 280 µm, 11.2 µs transport by 28 well-centre updates, spaced 400 ns apart, following the published sin² spatial trajectory. Round the plotted dwell to the nearest 20 ns timing increment. The coherent oscillator amplitude from each transport is proportional to the sum of its delivered position steps multiplied by the oscillator phase at each actual DAC strobe. Recombine the forward and return amplitudes coherently. Fit one nonnegative phonon scale and a single relative transport phase using only the four calibration markers. Search relative phase over one full turn at a spacing of 0.1 degrees and choose the least unweighted squared residual. Use no fitted frequency, background, or per-case parameter.

The real experiment used a segmented RF Paul trap, a ground-state-cooled calcium ion, low-pass-filtered trap electrodes and independent sideband thermometry. The replay's DAC value represents the target well centre. The individual electrode voltages, channel impulse responses and field solver are unavailable. [Walther et al., Physical Review Letters 109, 080501](https://doi.org/10.1103/PhysRevLett.109.080501) · [Versioned author manuscript and figure source](https://arxiv.org/abs/1206.0364v1)

## Reading the measurements

Run `python validation/qccd/extract_pair.py` to regenerate `pair-data.csv`. The standard-library extractor reads `pE_curves.eps` from the versioned author-source archive, SHA-256 `cd68af567727854bd7a26a4a665fac8cea72deb6de6499305910a2b0cb41930d`. The EPS member SHA-256 is `74c3f643b486187f2591abee0ca5743fd1a78bf005d7f94233e0f8525e509dc1`. The first blue series contains eleven open-circle centres. Their X coordinates are converted with the 0 and 3 µs ticks (EPS 504 and 4390), and log₁₀ mean phonon numbers with the 0.1 and 100 ticks (EPS 2878 and 4406). The output retains the original plot coordinates. Its canonical LF SHA-256 is `d0839fa255daebfda442ad14edccb3ba18e742747625bf6ee5948252ea64734e`. The digitization grid is about 0.77 ns horizontally and 0.45% per unit vertically. Additional printed decimal places allow a repeatable transform. They do not express measurement precision.

Only numerical readings are included here. The figure and manuscript remain available from the authors' arXiv submission under its non-exclusive distribution license. [Original source archive](https://arxiv.org/src/1206.0364v1) · [arXiv license](https://arxiv.org/licenses/nonexclusive-distrib/1.0/)

The plotted dwell is rounded first to the nearest nanosecond, then to the 20 ns clock with midpoint ties rounded up. The marker at 1489.964 ns programs a 1500 ns dwell. The replay stores both values. At every setting, the native controller produced 56 DAC updates without underrun, including a gap of 400 ns plus the programmed dwell between the legs.

## Result

The seven held-out markers produced an RMSE of **10.4405 phonons**, exceeding the predeclared threshold of 10. The largest error occurred at 1700 ns, where the model predicted 39.379 phonons and the plotted spectroscopy result was 20.001. Near the minimum, the 1580 ns marker gave 0.104 phonons while the model predicted 2.877. The independently reported axial frequency and successful digital timing replay do not establish quantitative accuracy at these settings.
