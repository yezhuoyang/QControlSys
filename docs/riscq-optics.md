# Optics of the RISC-Q workspace

The light in the 3D view is traced, not drawn by hand. [studio/riscq-optics.js](../studio/riscq-optics.js) propagates Gaussian beams through lenses, mirrors, AODs, AOMs, fibers and objectives. [studio/riscq-benches.js](../studio/riscq-benches.js) gives each platform its optical bench and decides from the trace which beams are on at a step. Both are plain modules with no server dependency. The page, the tests and a script compute the same beams:

```js
import * as B from "./studio/riscq-benches.js";
import * as model from "./studio/riscq-model.js";
const bench = B.benchFor(bundle);                     // lasers, trains, parameters with sources
const state = model.stateAt(bundle, index);
const tones = new Map(model.tonesAt(bundle, state.atBatch).map((t) => [t.part, t.um]));
B.beamsAt(bundle, bench, state, { tones });           // the beams on at this step, with hover lines
B.microwaveAt(bundle, state);                         // superconducting: microwave signals on coax
```

## How a beam follows from the trace

1. A RISC-Q core writes a pulse window to a channel. The trace records it with its opening and closing batch, frequency code, amplitude code and phase code.
2. `program.bindings` maps the window's core, channel and slot to an apparatus part: `beam:rydberg`, `site:DG02`, `aod0:x1` or `qubit3`.
3. The bench's trains for that part are traced:
   - the window's amplitude code sets the power fraction (amp / 19896, `soc.mjs AMP_SCALE`);
   - its frequency code sets the RF of the AOM or AOD (the inverse of `soc.mjs freqCode`: code × 16 × f_dsp / 65536).
4. The beam is on from the window's opening batch to its closing batch.

Neutral-atom tweezers: one beam per crossing of an active column tone and an active row tone of one AOD. Its RF is the tone frequency the run's calibration gives for the tone's position: 80 MHz + 188,462 Hz/µm × position.

## The model and its boundary

| Property | Basis | Boundary |
| --- | --- | --- |
| Beam size, waist, Rayleigh range, focus | Complex beam parameter q per transverse axis, ABCD matrices (Siegman, *Lasers*, ch. 17 and 20) | Paraxial, scalar, thin elements, no aberration, no polarization. M² multiplies the divergence |
| Sheets and other astigmatic beams | Separate q for the beam's local x and y | Top-hat shaping by SLMs is drawn as a Gaussian of the same size |
| Beam centre, deflection by an AOD | A centre ray (offset, angle) per axis through the same matrices. First-order deflection θ = sign · λ (f − f_c) / v | First order only, constant diffraction efficiency, no acoustic transit inside the crystal |
| Optical frequency | c / λ plus the RF of every AOM or AOD on the path (first order, +1) | Laser linewidth and drift are not modeled |
| Folding | Mirrors and splitters reflect the direction and the local frame about their normal | Flat optics. A curved mirror is a lens plus a fold |
| Apertures | An objective or AOD that the beam overfills adds a warning | No diffraction by the aperture |
| Fiber | Relaunches the fundamental mode, radius MFD / 2, power × coupling | Single mode only |

## Benches

Every value has a source. *assumed* marks a choice of this project, *derived* marks arithmetic on other values. The full table is `PARAMETERS` in [riscq-benches.js](../studio/riscq-benches.js).

### Neutral atoms (87Rb, ZAC architecture)

| Train | Light | Path | Sources |
| --- | --- | --- | --- |
| `aod<k>` | 810 nm AOD tweezers | AOD x → AOD y → relay telescope f1 = 100 mm (assumed), f2 = 469.7 mm (derived) → beam splitter → periscope → dichroic → objective, NA 0.65, f = 20 mm (assumed) → atom plane | Evered et al., Nature 622, 268 (2023), Methods: 810 nm AOD tweezers, NA 0.65 |
| `slm` | 850 nm static tweezers | SLM → dichroic → objective. The foci are the trap grids of the geometry | Evered et al. 2023 |
| `rydberg-420`, `rydberg-1013` | 420 nm and 1013 nm, counter-propagating | AOM (80 MHz) → two cylindrical lenses → a sheet 10 µm high and 60 µm wide at the centre of the entanglement zone | Evered et al. 2023: wavelengths, 10 µm × 10 µm top-hats, Isomet 80 MHz AOM. The 60 µm width is assumed |
| `raman` | 795 nm global | AOM → lens → 300 µm waist over the array (assumed) | Evered et al. 2023 level diagram |

Calibration. The relay focal length f2 is derived so that the bench reproduces the run's tone map exactly:

- f_obj · (f1/f2) · λ/v = 1/(188,462 Hz/µm), with v = 650 m/s and 188,462 Hz/µm both from `riscq/standards.mjs`;
- the effective focal length f_obj · f1/f2 is 4.258 mm;
- each AOD's mounting sign is chosen so that a higher RF moves the spot toward +x or +y of the ZAC frame.

The tweezer waist that results is 0.55 µm, a diffraction-limited spot of the 9.4 mm beam in the pupil. The table frame's origin is ZAC (0, 0), where the undeflected tweezer hits the atom plane.

### Trapped ions (171Yb+ with 138Ba+, QCCD Studio architecture)

| Train | Light | Path | Sources |
| --- | --- | --- | --- |
| `raman:<site>` (rotate, ms) | 370.3 nm Raman | AOM (200 MHz, assumed) → single-mode fiber (MFD 2.6 µm, assumed) → collimator f = 11 mm → focusing lens → a 30 µm waist (assumed) at the site, 45° to the trap axis, parallel to the surface at the 70 µm ion height | Pino et al., Nature 592, 209 (2021): 370.3 nm co-propagating Raman beams, beams parallel to the surface addressing one zone, RF null 70 µm above the surface |
| `detect:<site>` | 369.5 nm detection | Same delivery, −45° | Olmschenk et al., PRA 76, 052314 (2007) |
| fluorescence | 369.5 nm | A cone from the site to an imaging objective (NA 0.3, assumed) onto PMT channel `zone.<site>.pmt` | Pino et al. 2021: fluorescence imaged onto a PMT array |
| `cool` (`light:cooling`) | 493.5 nm Ba+ cooling | One beam along the trap axis through the gate sites, 60 µm waist (assumed) | Pino et al. 2021 |

Sample positions scale by the geometry's `micrometresPerUnit`: 750 µm for the H2 reconstruction, and 750 µm, assumed, where Studio states no unit. A program with no gate sites, such as `qccd-rotation`, has no light. Its ions move by electrode voltages alone.

### Superconducting qubits

No optics. `microwaveAt` lists every open drive, readout and acquisition window. Each entry gives:
- the wire it travels, from converter to qubit or from resonator back to the ADC;
- the carrier, decoded from the DAC frequency code;
- the amplitude, the phase, and the wire delay from the binding.

## What the tests check

[tests/riscq-optics.test.mjs](../tests/riscq-optics.test.mjs), tested properties, not measured hardware:

- **Closed forms.**
  - A lens focuses a collimated beam to M² λ f / (π w) within 1 %, at its focal length.
  - The Rayleigh range is π w0² / λ.
  - A telescope magnifies by f2/f1.
  - A cylindrical lens focuses one axis only.
  - A mirror folds without changing the beam.
  - A fiber relaunches MFD/2.
  - An AOD deflects by λΔf/v and shifts the frequency by its RF.
  - An overfilled objective is flagged.
- **Neutral calibration.** For every AOD carrier update of `neutral-bv14`, the bench's spot, traced from the raw DAC code, lies within one 16-bit frequency step (0.13 µm) of `model.tonesAt`.
- **Beams follow windows.**
  - At sampled steps of `neutral-bv14` and `qccd-ghz3`, every beam belongs to a window open at that batch.
  - Every open window that drives light has its beam.
  - Nothing is on before the first frame.
  - Tweezers focus at their tone crossing.
  - The Rydberg sheet is 10 µm × 60 µm at the zone.
- **QCCD detection.** A detection window lights 369.5 nm on its own site, focused there, and a fluorescence cone to that site's PMT channel. This test is skipped without the QCCD Studio checkout.
- **Microwaves.** Drive carriers equal the qubit frequencies of the calibration within one code step, and delays equal the bindings'.

Schematic, not checked: the positions of table optics, beam angles in the surface plane, laser powers, and how far each display scale enlarges a beam.
