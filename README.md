# QControlSys
This is a repo for Simulating, Visualizing lower-level hardware control system for different sorts of quantum hardwares. 

## Run the studio

QControl Studio runs a two-board feed-forward experiment. Board A digitizes a scripted observation and sends a two-bit result over fiber. Board B samples the receive register, looks up pulse amplitudes in waveform memory and drives its RF envelope. The Lean program produces the trace, assembly placements and register values used by the interactive 3D bench.

Install Node.js with npm and Lean's Elan toolchain manager. From this directory run:

```sh
npm ci
npm start
```

Open the [QCCD Studio replay](http://127.0.0.1:7432/qccd-studio), [QCCD broadcast bench](http://127.0.0.1:7432/qccd), [neutral-atom steering bench](http://127.0.0.1:7432/neutral) or [two-board feed-forward bench](http://127.0.0.1:7432/feedforward). Drag to orbit and scroll to zoom. The trace slider includes the initial state and every same-time microstep. **Export trace** saves the run.

### Programmable waveform controller

Open the [FPGA waveform controller](http://127.0.0.1:7432/controller) to follow a program from FPGA instruction issue through RAM, the DAC bus and a buffered converter. The 32-bit reference bus delivers all 16 samples on time. Change it to 16 bits to see the first underrun at 56 ns. Change the input word to take a different branch, or use **Edit program** to change instructions, waveform samples, clock, quantization and filter. The scope, 3D rack and register debugger follow the same events. Export samples or compare an independently acquired, trigger-aligned capture. [Fidelity, assumptions and worked experiment](docs/controller-fidelity.md)

### Composing machines and compiling programs

The home page places the electronics, wiring, apparatus and all qubits in a single orbitable 3D installation. **Next drive sample** jumps to the command envelope arriving at a qubit. **Trace a pulse → Follow from FPGA** opens the producing instructions and connections. In **Wiring inspector**, select a cable and open **Conductors and timing** to locate a pin in 3D. **Enlarge qubits** magnifies the device in place. **Zoom to qubits** shows the register at physical scale. Open the [32-ion QCCD machine](http://127.0.0.1:7432/machines?platform=qccd), [14-atom ZAC machine](http://127.0.0.1:7432/machines?platform=neutral) or [two-transmon chip](http://127.0.0.1:7432/machines?platform=superconducting).

The [machine workbench](http://127.0.0.1:7432/machines) runs machines assembled from typed components. The same OpenQASM source drives the superconducting, neutral-atom and QCCD example assemblies. Each design selects its own controller clock, waveform library, bus and wiring. A fourth example reads an electrical detector and conditionally issues a drive. A fifth instantiates the existing buffered waveform controller as a board inside a larger machine.

Drag a component onto the 3D assembly and connect its ports. **Compile and run** shows FPGA instructions, RAM traffic, waveform samples, arrivals and their source operations. **Save design and source** saves a portable compiler input. **Export replay** adds the compiled image and execution for independent replay. [Machine format, supported source languages, timing semantics and headless access](docs/component-machines.md)

### Measured hardware validation

The [board measurements bench](http://127.0.0.1:7432/board-validation) compares a trapped-ion electrode DAC transient and cold-atom controller measurements. Select a voltage to follow its causal history through the 3D hardware, or enter a FIFO deadline to see which measured transfers missed it. [Calibration, held-out errors and reproduction](docs/board-validation.md)

Open [Hardware validation](http://127.0.0.1:7432/validation) to compare a reconstructed control program with held-out experimental measurements. Each study exposes the criterion, residuals, samples and source data. Click a measured point to replay its control path. QCCD Studio, ZAC and Qiskit Metal supply separate design references with native source provenance. The QCCD studies include two fast transport models that exceeded their error limits. [Hardware models, literature and reproduction](docs/physical-validation.md)

### Physical installations

The QCCD and neutral-atom benches open with the controller and quantum device assembled in one millimetre coordinate system. **Focus** moves the camera between the bench, electronics, vacuum system and qubits. The scale bar changes with zoom. **Inspect** gives the component envelope, its dimensional basis and the lengths of the modeled connections. **Debugger detail** opens the enlarged working diagram at the same event. Symbol sizes for ions, occupied traps and light paths are documented in each physical profile.

- **QCCD** connects an FPGA, selector receiver and DAC to a vacuum feedthrough, ceramic carrier and trap die. A second path carries light to the trap. For H2, the electrode span is 6.58 mm, the isthmus is 2.02 mm wide, the gate pitch is 750 µm and the ions sit 70 µm from the electrode surface. The rack, chamber and their placement are a reference installation. The synthetic broadcast experiment uses its own lanes in the same chip envelope. [Moses et al., figures 1 and 2](https://doi.org/10.1103/PhysRevX.13.041052) · [QCCD physical profile](physical/qccd-installation.json)
- **Neutral atoms** places the FPGA and DDS in a chassis alongside a 900 × 600 mm optical breadboard. The RF cables reach two crossed deflectors. The optical path passes through relay optics, a fold mirror, the objective and a vacuum window to the atom plane. The example's initial trap pitch is 5 µm. The physical profile records manufacturer dimensions for the board, case, deflectors and objective, and identifies assumed mount and cable positions. [Neutral-atom layout and dimensional sources](QControl/NeutralLayout.lean)

Both installations retain the timing declared by the program or Studio profile. Cable route length is a geometric measurement. Measured propagation, electronics delays or optical transfer functions can be supplied by a future timing profile.

### QCCD Studio compatibility

The replay and native editor use Python 3.10+ and a local checkout of the [QCCD Studio compiler branch](https://github.com/yezhuoyang/QCCD/tree/compiler). Place it in a sibling directory named `QCCD` or set `QCCD_STUDIO_ROOT` to its location. Set `QCONTROL_PYTHON` if the interpreter command differs from `python`. The four standalone benches run without the QCCD checkout.

1. Open **QCCD Studio replay**. The H2 example reads Studio's original architecture and 32-qubit GHZ program. Scrub its 947 cycles to inspect ion moves, addressed gates, actual control banks and the input instruction that caused each cycle.
2. Use **Open files** to load an architecture and compiled TSIR, or a version 1 `qccd.studio` design with authored calls. A design that references a compiled artifact also needs its original TSIR. The bridge rebuilds authored geometry from the Studio records. Original machine and program files are available for download. A [small authored design](bridge/fixtures/three-hop.studio.json) exercises a three-hop rotation.
3. **Open native editor** under **Studio source files** opens the local QCCD Studio authoring interface. Export the edited machine and program in Studio, then use **Open files** in QControl to replay them. An authored design restores its edit records, program calls and saved cursor. Supplying an external compiled TSIR opens that program on the resulting machine. Compiled exports preserve the instruction IDs and operands. Extended numeric metadata such as the compiler's unbounded cooling limit is written as the string `"Infinity"` in strict JSON. **Save TSIR** in QControl downloads the original input file. Imported architectures with unknown physical scale open in the topology debugger. The H2 reference additionally opens in its metric installation.

The GHZ32 comparison checks every displayed ion position, traversed rail, gate operand and cycle interval against Studio's own viewer representation. It covers 59 sites, 674 source instructions, 947 expanded cycles, 31 two-ion gates and 32 measurements. The H2 fixture assigns unit durations to its primitives. Its clock is shown in model units. For each import, the Python executor reports the Studio rule verdicts and the Lean checker independently walks the rails, applies placements simultaneously and compares the resulting occupancy. The rules view lists skipped and partial checks. [Conformance and native round-trip tests](tests/studio-bridge.test.mjs) · [Placement checker and proof](QControl/StudioPlacement.lean)

Agents can POST `{"architecture":"<original file text>","program":"<original TSIR text>"}` to `/api/studio/replay`, or send the same object to `python -B bridge/qccd_studio.py`. For a Studio design, pass its file text as `architecture` and omit `program` to execute its own calls. `GET /api/studio/h2` supplies the reference pair. The HTTP replay includes the independent placement verdict. The CLI also accepts an exported Studio trace at `qcontrol --check-studio-placement`. Each frame retains its source index, stable instruction ID, substep, predecessor, start/end, addressed hardware and sparse location changes.

### Neutral-atom steering

The example has two column tones, two row tones, three atoms and one empty trap. At 17,000 ns the DDS writes a column tone. At 18,200 ns that acoustic step reaches the aperture and shifts both traps on that column by 500 nm. Use **Shared tone move** to change the addressed tone or target frequency, then inspect the RF word, delivered tone and new positions. Delivering a row tone moves the entire row, including an empty site. The model checks tone ordering and timing. It uses a linear frequency-to-position calibration and assumes that atoms follow their assigned traps. [Neutral-atom model and proofs](QControl/Neutral.lean) · [Example](examples/neutral-aod.json)

### QCCD broadcast and trapped-ion motion

One to six parallel lanes share a transport DAC. Each lane has an ion, a physical source connection, and a local selector with separate pending and sampled bits. A second optical path delivers a timed pulse to one lane's destination well. The same program supplies the digital trace, electrode voltages, displacement in µm, and exposure result.

1. Open the QCCD bench. The default view is halfway through the shuttle. Ion A is at 60 µm and ion B is at 0 µm.
2. Under **Trap wiring**, change **B · Arrival** to **One edge late**. At the same waveform sample both ions are now at 60 µm. Step back to **Latch all selectors**. B's hold request missed the edge, so its switch retained its enabled reset value.
3. Drag **Hold bias** onto lane B or change **B · Wire** to **Hold bias**. Its ion stays at 0 µm throughout the ramp. **Add lane** creates another independently controlled recipient. Removing a targeted lane reassigns the optical head to the first remaining lane.
4. Select **Lane B** as the optical target and inspect **Open optical gate**. The light reaches the addressed destination even when the well is empty. Reconnect B to **Shared DAC** with the late request to expose its transported ion.

The [QCCD program](examples/qccd-broadcast.json) uses a 5 µs latch edge, a 40 µs shuttle over 120 µm, 2 µs settling time and 40 ns optical delivery delay. These are illustrative operating assumptions. At each waveform knot, enabled ions follow a prescribed quasi-static displacement proportional to delivered differential voltage, rounded down to whole µm. Optical exposure means a settled ion occupies the illuminated destination. Motional excitation and quantum gate fidelity require additional device models. The 3D view enlarges the chip, fibers and ions for inspection. The shared-waveform and selector topology draws on the [WISE proposal](https://doi.org/10.1103/PRXQuantum.4.040313).

The [QCCD semantics and proofs](QControl/QCCD.lean) cover latch persistence across a later write, isolation of held lanes, equality of delivered voltage across enabled recipients, and the occupancy witness required for an optical exposure. The [QCCD regression suite](tests/qccd.test.mjs) exercises arrivals on both sides of the edge, both wiring choices, all selector bit combinations, multiple optical delivery timings and trace tampering.

### Two-board feed-forward

Set **Input bits** to **11** and **Arrival** to **Nominal**. At 1,600 ns the receive, sample, memory lookup and first output occur in order. Inspect that edge with **Next event**. Choose **One edge late** to delay the word by 10 ns in the default program. The receive register eventually updates, while the sampled fault inhibits conditional pulses for the rest of the run.

### Model and verification

- [Executable model and proofs](QControl.lean) defines each instruction, scene assembly, state transition, and the ordering of simultaneous events. The receiver accepts a word committed on its sample edge. Missing it latches a fault. Lean checks that arbitrary subsequent instructions preserve the emitted-pulse count after a fault and that every opcode has a scene assembly.
- [Example program](examples/feedforward.json) fixes the aggregate communication delay at 450 ns. The 1 µs acquisition, approximately 150 ns processing and 450 ns communication are drawn from the QubiC bench. The example's 10 ns clock, 30 ns inter-pulse gap, late-result policy, input emulator and mechanical geometry are model choices. Board placement changes the displayed cable route. Its calibrated aggregate delay changes through the program. The signal monitor displays the RF envelope in millivolts. [Xu et al., listing 1 and figure 3](https://arxiv.org/html/2506.09856v1)
- [Regression tests](tests/bench.test.mjs) check all four two-bit outcomes, exact pulse edges, arrivals on either side of the deadline, causal order, deterministic replay, and invalid program rejection. Run `npm test` to build the formal model and execute these tests.

For headless use, run `lake build` and pipe an example into the executable. On PowerShell:

```powershell
Get-Content -Raw examples/feedforward.json | .\.lake\build\bin\qcontrol.exe
```

On macOS or Linux use `.lake/build/bin/qcontrol < examples/feedforward.json`. Substitute `examples/qccd-broadcast.json` or `examples/neutral-aod.json` for their respective benches. The loopback server also accepts these programs at `POST /api/run`. Both paths return the canonical program, assemblies, initial state and every event snapshot. For the integrated installations, the `system` header includes component sizes, spatial routes, camera targets, physical references and assumptions.

To verify a saved trace, pipe the exported JSON to the same executable with `--check-trace`. It re-executes the embedded program, compares every microstep and the scene header, and identifies the first differing event. This establishes consistency with the executable model.

## Research and design

- [Literature review](docs/literature-review.md) covers classical controllers, superconducting qubits, neutral atoms, trapped-ion QCCD systems, and fault-tolerant feedback.
- [Architecture and development plan](docs/development-plan.md) defines the shared simulator, device models, browser design and debugging tools, formal checks, and implementation milestones.
