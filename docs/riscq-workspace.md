# RISC-Q workspace

`/riscq-studio` shows one controller run on a single screen, laid out like QCCD Studio's design page. The animation sits on the left and the program layers on the right. Both follow the same trace step.

```sh
npm start            # then open http://127.0.0.1:7432/riscq-studio
# a step and a view can be named in the address:
# /riscq-studio?example=qccd-ghz3&step=284&view=chip
```

## Layout

| Region | What it shows |
| --- | --- |
| Element rail (left) | The part kinds of this run with their counts. Hover a kind for what it is and the RISC-Q source it follows. Click to select its parts one after another. Kinds the current view does not draw are marked *off*. Below: the highlight legend, the display-geometry note of the view, and the selected part. |
| Stage (centre) | The 3D view, the card of the executing step, and a badge for every part that acts off view. Under the stage: a time track of the hardware instructions and the transport. A dock below holds the step inspector, the machine state, the trace and a source editor. |
| Program column (right) | Four synchronized layers: **source** (OpenQASM, ZAC, system calls or C), the **intermediate** TSIR program for QCCD runs, the **hardware instructions**, and the **RV32I firmware** of the acting core or of a chosen core. |

In every layer, yellow marks the row of the current step and blue marks instructions whose pulse windows are open at this batch. Hovering a row in one layer tints the related rows of the other layers in violet. It also lights the channels and apparatus those instructions act on. Clicking a row goes to its first frame. On a firmware word, a click goes to the next traced execution of that word.

## Views

The three views show **one world** ([studio/riscq-world.js](../studio/riscq-world.js)), built once per run. A view chooses the camera frame and fades the parts it does not focus on. It never moves or rebuilds a part, so the chip, the control system and the whole machine are the same machine.

The world, from the centre out:

| Ring | Parts | Placement |
| --- | --- | --- |
| Apparatus, radius 100 | The chip, trap or atom array | Chip layout coordinates fitted to what the program uses |
| 150 | Converters (DAC, ADC, digital pins) | At the angle of the apparatus each drives. A shared feedline goes in a free gap at the back |
| 200 | Channels | Beside their converter |
| 275, 300, 325 | Cores, then their inboxes and posted links | At the circular mean angle of the core's channels |
| 350 | A bus ring | Joins every link to the hub |
| Outside the bus | Hub and host | At the front |
| Left of the controller | The optical table of a laser platform | |

- **Chip.** Frames the apparatus with its converters and channels.
- **Control system.** Frames the controller and fades the apparatus.
- **Whole machine.** Frames everything, including the optical table.

Parts outside a view's focus keep running, and their instructions stay in the program column.

The apparatus is drawn in its field's convention:

- **Trapped ions** follow QCCD Studio's map: pink rails, capsule sites coloured by zone, rows of electrodes along the rails, and ions as numbered navy discs. A zone's electrodes glow orange while its transport waveform plays.
- **Neutral atoms** follow neutral-atom paper figures: a dark array, outlined zones, static traps as faint dots, atoms as glowing points, and a glass objective above the array.
- **Superconducting** shows a sapphire die with transmon crosses, meander resonators and couplers.

Electrical signals are objects ([studio/riscq-light.js](../studio/riscq-light.js), from `signalsAt` in riscq-world.js). A pulse leaves its converter when its window opens. It reaches its part after the binding's wire delay, drawn as a bright packet. An acquisition window carries the returning signal back to the ADC. Hovering a packet shows its window, delay, elapsed time and codes.

## Where each picture comes from

| What is drawn | Source | Boundary |
| --- | --- | --- |
| Source line of a hardware instruction | The instruction's `source` field: an OpenQASM line, a TSIR instruction, a ZAC instruction, a system-call index or C function names | For QCCD, a TSIR instruction names OpenQASM operations in `meta.source_op`. `qasmStatements` maps them to lines by expanding a register operand into one operation per qubit. This is a display mapping, tested on the GHZ program |
| Firmware listing | `program.cores[k].image`, disassembled by `studio/riscq-disasm.js` | Prints exactly what Lean's `Instr.text` prints. Tested on every traced instruction of a full trace and of the compiled Helios decoder. Data words, such as issue tables, print as the instruction they decode to |
| Firmware regions | `program.cores[k].sourceMap` | A region starts at a source-map entry and runs to the next one |
| Apparatus positions | `machine.geometry` (`riscq/geometry.mjs`) when present: QCCD Studio architecture coordinates, ZAC architecture in µm, transmon ring | Without it the layout is schematic: a ring or chain of the sites the program names. The QCCD view fits the sites the program uses. The rest of the architecture extends beyond the die |
| Ion position | `model.ionsAt` from `derived.ionMoves` | A moving ion is drawn on the straight line between its sites, at the fraction of its move window that has passed |
| Atom position | `init` traps of the geometry, then the crossing of the atom's column and row tones from `model.tonesAt` while a job carries it | Atoms are assumed to follow their tones. Tested: a carried atom is at its tone crossing, and every atom ends at the target of its last move |
| Driven apparatus | Windows open at the batch, matched to `program.bindings` by core, channel and slot | No quantum state is simulated |

Modules: [page](../studio/riscq-studio.js), [stage](../studio/riscq-stage.js), [layers](../studio/riscq-layers.js), [disassembler](../studio/riscq-disasm.js), [hover texts](../studio/riscq-glossary.js), [tests](../tests/riscq-studio.test.mjs).

## Hardware design editor

`/riscq-design/wiring` edits the control wiring: a `riscq-design` document of [riscq/design.mjs](../riscq/design.mjs). Its **Design** and **Debug** tabs switch between the editor and the workspace above.

| Region | What it does |
| --- | --- |
| Components (left) | The allowed part types: control board, core, DAC, ADC, stage, qubit, resonator. Click one, then click the canvas to place it. **+ Qubit with readout** adds a qubit, its resonator, a core with drive, readout and acquisition channels, two DACs, an ADC and three coax lines. **Wire** joins two parts with a right-angle route in the chosen medium. The outline below lists every part and wire. |
| Canvas (centre) | The parts at their positions in mm, in plan (x–y), side (x–z), front (y–z) or isometric 3D. Dragging a part moves it in the two axes shown. The ends of its wires follow, and their bends stay right-angled. Select a wire to drag its waypoints. Double-click a wire to add a bend. Scroll zooms, and dragging the background pans. |
| Dock (bottom) | **Rules**: the server's check after every edit. An error names the parts it concerns, marks them red and disables Run. **Signal timing**: every wire's routed length and delay, and every calibrated pulse's arrival delay. **Program**: the OpenQASM to run. **Document**: the JSON the server receives. |
| Inspector (right) | The selection's fields: id (renaming updates every reference), position, DAC/ADC index, a core's channels, a qubit's channels and calibration (frequency, X90 and X pulses, readout), its couplers, a wire's medium and route points. With nothing selected, the board's clock and memory sizes and the decoder core. |

**Run on this hardware** hands the design and the program to the workspace, which runs them through the same `run` as `node riscq/cli.mjs --design design.json --qasm program.qasm`. **Save** writes the document for that command. In the workspace, **Edit this hardware** brings a run's design back to the editor.

| Claim | Basis | Boundary |
| --- | --- | --- |
| The rules, the build, the pulse tables and the delays | `check` and `machine` of riscq/design.mjs, via [riscq/design-service.mjs](../riscq/design-service.mjs). The page computes none of them | Loss, dispersion and crosstalk are not modeled. A wire's delay is its length over its medium's signal speed |
| Lengths and delays shown while dragging | [studio/riscq-design-doc.js](../studio/riscq-design-doc.js) `routeLength`, `wireDelayPs` | Tested equal to `wireTiming` for every wire of the ring |
| Calibration of an added qubit or coupler | A copy of an existing qubit or coupler of the design (the x6y3 calibration) | A starting value to edit, not a measured one. Frequencies are not checked for collisions |
| The chip outline in the editor, and part sizes and shapes | Drawn around the qubit and resonator positions | Schematic: the document gives positions, not a die or part sizes |
| Chip view of a design run in the workspace | The design's qubit and resonator positions, seen from above | Converter and channel positions in that view stay schematic |

Tests: [tests/riscq-design-editor.test.mjs](../tests/riscq-design-editor.test.mjs) applies the editor's edits without a browser and runs the result. It covers moving a part, adding and coupling a qubit, removing one, cutting three qubits out of the ring, renaming, and repairing a broken rule.

## Headless use

The page computes nothing that a script cannot. The functions below take a run bundle (`node riscq/cli.mjs --example <id> --out run.json`):

```js
import * as layers from "./studio/riscq-layers.js";
const focus = layers.focusAt(bundle, 283);       // source lines, TSIR lines, hardware instruction, core, pc and firmware row of step 284
layers.firmware(bundle, focus.core)[focus.row];  // { pc, word, text, region }
layers.ionPositions(bundle, atBatch);            // or atomPositions: what the chip view draws
layers.viewParts(bundle, "chip");                // which parts a view draws

// The editor's edits, without a browser:
import * as D from "./studio/riscq-design-doc.js";
import { designService } from "./riscq/design-service.mjs";
const doc = D.firstQubits(designService("/").design, 3);
D.addCoupling(doc, 2, D.addQubit(doc, doc.qubits[0]), doc.couplings[0]);
designService("/check", {}, doc);                 // { errors, warnings, wires, pulses, build }
```
