# Component machines and program compilation

A portable program describes operations on logical targets. A machine supplies component instances, physical links, controller roles and operation implementations. The compiler resolves each operation by role, name, ordered targets and numerical parameters. It emits an instruction image for each FPGA and writes waveform samples into the specified RAM. The Lean executor reads those images and the netlist. No platform name participates in execution. The sample configurations use illustrative drive waveforms. Experimental validation of device observables is documented in the [validation bench](physical-validation.md).

## Run a design

Open the [machine workbench](http://127.0.0.1:7432/machines) and select a design. Choose **Compile and run** and step from a source operation through its control path. Select a part to inspect its last committed state at the cursor. Jump to a causal predecessor to follow an arriving value. The waveform-board example exposes the underlying controller PC, FIFO, bus and converter events. Parts and routes share the machine's millimetre coordinate system.

The three quantum presets open as one 3D installation. The FPGA, memory, bus, DAC, delivery apparatus and occupied register sites share one camera and coordinate frame. **Play trace** steps through the execution. **Next drive sample** jumps to a nonzero terminal receive event and shows the producing path. Select a qubit to inspect its physical coordinates and the last envelope received on each of its inputs. Rewind reconstructs each channel independently, including a two-target pulse in flight.

The overview uses an in-place cutaway around the occupied register. **Enlarge qubits** applies the same continuous radial display transform to equipment, chip geometry, connection vertices and qubit labels. Inside the occupied core the scale is constant. Beyond the outer radius the scale is one. Intervening radii interpolate monotonically between the two boundaries. The overview scale bar refers to the undistorted lab. Turn enlargement off to measure throughout the scene at one scale. **Zoom to qubits** aims the same camera at the physical register. Dragging a component uses physical scale. [Display transform and physical delivery branches](../machine/installation-display.mjs)

| Workbench design | Physical register and dimensional basis |
| --- | --- |
| [QCCD ions](http://127.0.0.1:7432/machines?platform=qccd) | The native H2 theta1 placement at `tsir-6-0` contains 32 ions, with q0 and q1 together in DG01. The trap faces down and the ions sit 70 µm below its electrodes. Their 5 µm axial separation is illustrative. The electrode contours come from Figure 2d. The 268 DC source outputs and 280-pin carrier follow the published inventory. Pin assignments and the FPGA shelf belong to this reference design. [Gate-ready placement](../physical/h2-gate-register.json) · [Moses et al.](https://arxiv.org/html/2305.03828) |
| [Neutral atoms](http://127.0.0.1:7432/machines?platform=neutral) | The 14-atom ZAC snapshot follows transport job 2. Physical atoms 0 and 13 occupy the entangling region at a 2 µm separation. Static 852 nm traps, moving 850 nm traps, 795 nm Raman addressing and opposed 420/1013 nm Rydberg beams have separate paths. Extended Data Figure 1 establishes the optical topology. Shelf coordinates and most housing dimensions belong to the reference design. [ZAC program](../validation/neutral/zac_adapter.py) · [Bluvstein et al.](https://arxiv.org/html/2312.03982v1) |
| [Superconducting](http://127.0.0.1:7432/machines?platform=superconducting) | Room-temperature coax rises outside the cryostat to its warm flange. It descends through five cryogenic stages to the carrier beneath the 9 × 6 mm Metal die. Internal cable lengths are 200, 290, 250, 170 and 140 mm. Plate spacings, package interconnects and warm-shelf placement belong to this reference design. [Krinner et al., Table 1 and Fig. 3](https://doi.org/10.1140/epjqt/s40507-019-0072-0) · [Metal geometry](../validation/superconducting/metal.md) |

An optional machine `device` contains its physical `kind`, `centerMm`, `layout`, full `qubits` inventory and `drives`. Qubit positions are in local millimetres with the second coordinate up. Each drive binds an electronic observation point to explicit physical recipients. The exported `deviceActivity` records the electronic probe receipts. The three reference machines also specify `device.propagation`. The compiler lowers each source channel into identity transfers at the optical or cryogenic stages, timed wires and a separate receiving probe at each addressed site or transmon drive pin. These parts execute in the same Lean event queue as the FPGA. `delivery.stages` maps their IDs to the scene and `terminalActivity` records their receiving events. Opening an older design without propagation uses its original electronic probe binding.

Delivery timing uses routed or installed length in mm and effective speed in mm/ns, rounded up to picoseconds. Internal stage delays are configurable. The gate replay carries a source-referred envelope in µV and keeps the register fixed. Optical power, qubit-state evolution, RF phase and attenuator insertion loss require additional response models and calibration. **Drive an AOD steering channel** executes signed RF samples and projects the recovered tone into the trap plane using a declared 120 ns acoustic delay and 10 nm/kHz slope. **Exercise a trap DC output** sends signed 16-bit setpoints to an individual DAC and socket contact. Its ±10 V conversion scale is a design assumption. [Delivery semantics](../machine/delivery.mjs) · [Native transport replay](http://127.0.0.1:7432/qccd-studio)

The exported `apparatus` lists the installation pieces and route endpoints in the same millimetre coordinate system as the electronic components. Both browser and headless clients can reconstruct the same scene.

### Inspect an individual wire

**Trace a pulse** shows the source location and each producing FPGA, memory, bus, converter and delivery event. The optical carrier has an identifiable source. Channel selection and playback enable have causal branches. Each timestamp opens the corresponding debugger state.

**Wiring inspector** searches by component, port, cable or channel. Selecting a conductor opens its cross-section at the actual cable in the same 3D scene. Coax has a core and return shield. Each parallel bit, strobe and return has an identity. Differential links have positive, negative and reference conductors. A fiber has a guided mode, core, cladding and jacket. A free-space path carries an optical mode. The reference ion DAC bank has a separately routed common return. Fabrication layers inside commercial devices, power distribution and the unpublished electrode-to-pin map remain outside the control netlist.

Parallel word links declare which source bit reaches each destination bit. A connector crossover changes the rendered conductor endpoints and the word the receiver decodes. A remap inside the receiver keeps the cable straight. Each lane can have its own skew in picoseconds. The receiver latches the word after its last required lane arrives.

The transmitter reserves each digital frame until its last symbol launches. The receiver gets a complete word after serialization, propagation and endpoint delay. The reference serial format declares its bit order and framing. Custom rate-only line codes leave symbol contents unspecified. The waveform board executes its own clocked DMA and DAC. Older designs with only a fixed delay keep their original transport semantics. [Wire schema and timing](../machine/interconnect.mjs) · [Executor and non-overlap proof](../QControl/Fabric.lean)

Use the primitive selector and **Add component**, or drag the button onto the 3D assembly. Drag **Move part** to place an existing component. The connection editor offers compatible free inputs. The machine text exposes clocks, RAM contents, physical dimensions, wiring and calibration bodies. **Apply machine text** validates an edit. Saved designs can be reopened with **Open file**. Changing a source or design invalidates the displayed run.

Two documents travel together in a saved bundle. `design` contains `kind: "machine-design"`, `version: 1`, `parts`, `wires`, `roles`, `calibrations` and `maxEvents`. Each part declares its unique ID, label, model, center and size. A wire names its output and input as `{part, port}` pairs and specifies an integral delay in ps. The second document, `source`, is either OpenQASM text or version 1 control IR. A high-level compiler for another language can emit this IR. New operation names and calibrated decompositions live in machine data.

## Accepted source programs

The OpenQASM 3 subset accepts scalar qubits and bits, constant-sized registers with explicit indices, physical qubit references, supported standard gates, constant angle arithmetic, nonparameterized hierarchical gate definitions, measurement into a bit, and a single gate call guarded by that bit. `include "stdgates.inc"` exposes the supported standard gates. Unsupported syntax, out-of-range operands and missing target calibrations have explicit diagnostics. The compiler preserves operand order. Logical qubits in this front end use the operand names in the machine’s bindings. Routing or remapping from an upstream compiler must be explicit. [OpenQASM gate definitions](https://openqasm.com/language/gates.html) · [OpenQASM qubits and registers](https://openqasm.com/language/types.html)

```qasm
OPENQASM 3.0;
include "stdgates.inc";
gate flip_pair a,b { x a; x b; }
qubit[2] q;
flip_pair q[0], q[1];
```

Each of the three example machines implements this program by selecting a drive output and streaming a different envelope. The feedback example adds `result = measure q[0]; if (result) x q[1];`. Here the supplied measurement implementation drives an electrical loopback and a threshold detector. It exercises the timing and branching of a readout interface. A quantum-state measurement requires a suitable device and readout model.

The same three machines also bind `cz q[0], q[1];` to a separate two-qubit waveform board. A program containing `rx(pi/2) q[0]; cz q[0], q[1];` exercises a parameterized single-qubit command followed by a two-qubit command. The joint control endpoint receives 16 DAC samples. This tests targeting and timing. The envelopes are illustrative and need device-specific calibration to implement those unitaries.

Control IR contains concurrent `tracks`. Each has a logical `role` and sequential `body`. Each role maps to one FPGA. Two tracks cannot own the same FPGA in a run. Unused FPGAs receive a halt image. Calibration bodies use the same language as track bodies. This example issues the same calibrated operation twice.

```json
{
  "language": "control-ir",
  "version": 1,
  "tracks": [{
    "role": "control",
    "body": [{"repeat": {"count": 2, "body": [
      {"call": {"name": "x", "targets": ["q[0]"]}}
    ]}}]
  }]
}
```

| IR operation | Execution |
| --- | --- |
| `call {name, targets, params?}` | Resolves a machine calibration. Compound definitions can call other operations. Recursive calibration definitions are rejected when expanded. |
| `stream {ram, words, periodTicks}` | Deduplicates and allocates signed 16-bit samples after the RAM's initial contents. Emits one address write per sample, separated by the given number of FPGA clock periods. A wire must connect that FPGA's address output to the named RAM. |
| `spiWrite24 {command, data}` | Shifts an 8-bit command followed by 16 data bits, MSB first. Each bit uses three FPGA instructions to raise SCLK, present SDI and lower SCLK. CS stays low across the 24 falling edges and rises to commit. Connect the three bit outputs to the intended peripheral. |
| `write {port,value}`, `read port`, `writeAcc port`, `add value` | Drive a port, sample a latched input into the accumulator, drive its value or perform signed wrapping 16-bit arithmetic. |
| `capture bitName` | Reads the FPGA sense input and stores that bit in a local classical register. The two instructions retire on successive clock edges. |
| `ifBit {bit,then,else?}`, `whileBit {bit,body}` | Execute conditional FPGA branches on a stored bit. The loop body can acquire a fresh bit. A read before initialization faults at that instruction. |
| `repeat {count,body}`, `wait ticks` | Statically expand a finite repetition, or consume an issue cycle followed by the specified idle cycles. |
| `at {ps,body}` | Schedule the first instruction of a block at an absolute picosecond time. Compilation checks the FPGA clock grid. Execution waits for that edge or reports a missed issue with the actual ready time. This gives upstream schedulers an explicit timing contract. |

Sequence orders local instruction issue. Arrivals at distant components occur after the declared device and wire delays, including any bus reservation. A calibration that needs settling time or fresh feedback must include that interval. Board inputs reset to zero. Independent tracks begin on their own time-zero edge and communicate through the declared wires.

For parameterized operations, a calibration can declare `paramRanges`, one inclusive numeric interval per argument. An exact parameter match takes precedence. The compiler rejects intersecting ranges for the same operation, targets and parameter count. Inside the recipe, `{"parameter":0,"scale":1000,"round":true}` multiplies the first argument by 1,000 and rounds to the nearest integer, ties away from zero. An optional offset is added before rounding. The compiler checks the resulting RAM and port values and rejects out-of-range arguments. The example machines provide a linear, illustrative `rx` envelope over −π to π. Exporting a two-qubit Qiskit circuit containing `rx(pi/2, 0)` and `x(1)` with `qiskit.qasm3.dumps` gives a source program for these bindings. [Qiskit OpenQASM 3 exporter](https://quantum.cloud.ibm.com/docs/en/api/qiskit/qasm3)

## Primitive contracts

The FPGA operation `{"writeBus":{"address":21,"word":-21846}}` issues an unsigned 16-bit address and a signed 16-bit word on the same clock edge. Its frame exposes both port values in `outputs`. Each physical link independently applies its serialization, pin mapping and propagation. The [Cora Z7 reference](board-validation.md) binds seven address lines, 16 data lines and one strobe through level shifters and a rack connector.

| Component | Inputs → outputs | Semantics |
| --- | --- | --- |
| FPGA | `rx:word, sense:bit → tx:word, address:address, flag:bit` | Independent clock in ps. Writes latch at the destination after transport. Reads sample the most recently committed value. |
| Waveform RAM | `address → word` | Each request returns a signed 16-bit word after `accessPs`. Reads can overlap. Out-of-range addresses fault at the RAM. |
| Bus | `a:word, b:word → word` | One request per transfer. FCFS service occupies `ceil(16/widthBits) × beatPs` after the previous transfer completes. Grant order for simultaneous requests follows event insertion order. This component has an ideal waiting queue and word-sized transactions. |
| DAC | `word → voltageUv` | Quantizes signed PCM to the declared bit depth and full-scale voltage. The simple DAC holds the latest value. |
| Clocked DAC | `in:word, strobe:bit, optional address → voltageUv` | Data and address update separate registers. A rising strobe latches the pending word when the configured address matches. The output holds between accepted strobes. |
| Bus buffer | `in:word, address, strobe → out:word, address, strobe` | Enabled logic-level translation with explicit input and output supply rails. Each signal propagates on its own path. |
| DMA burst counter | `start:bit → sample:bit, done:bit` | The elapsed time for an ordinal is derived from the prefilled count, clock and average record-service interval. A high start while busy faults. |
| Waveform board | `start:word → voltageUv` | Each start launches the existing clocked sequencer/DMA/FIFO/DAC program from reset with the trigger word as input. Its native bus arbitration, packed beats, underruns, filter history and individual microsteps are preserved. Another start during the active acquisition faults. |
| Affine transfer | specified signal → specified signal | Emits `trunc(input × numerator / denominator) + offset`. Use explicit units and a calibration basis for physical conversions. |
| Threshold | `voltageUv → bit` | Emits one when the input reaches or exceeds the configured threshold. |
| Switch | `in:signal, enable:bit → signal` | Latches both inputs and emits the stored data when enabled, otherwise zero. Both contributing events remain inspectable. |
| Probe | specified signal → observation | Records each arrival, its value, route and source operation. |
| Stimulus | timestamped samples → specified signal | Drives declared environmental inputs or recorded values at their exact picosecond timestamps. A passive design can run with empty roles and tracks. |

Signal types are bit, unsigned address, signed 16-bit word, µV, Hz and nm. An output can drive many receivers. An input has at most one driver. Explicit processing components perform conversions. Positive wire delays allow feedback loops. FPGA issues at a timestamp observe all arrivals already due at that timestamp. Insertion order breaks ties of equal priority, seeded by the declared part and wire order. A trace budget ends a nonquiescent run with the explicit status `event limit`. Reachable execution faults retain a debugger frame. Each frame stores a stable ID, a source path, causal parents and the committed state of the affected part. Reconstruct other parts by retaining their most recent state. A fixed-delay legacy wire uses its configured latency. Physical links add their flight time to the endpoint delay and reserve their transmitter for the required bits.

The executable bounds a run at 256 parts, 1,024 wires, 16,384 instructions per FPGA, 65,536 words per RAM and 20,000 events. A component with new physics or a new digital protocol needs executable port and transition semantics. Physics validation belongs to each instantiated response model and operating regime. The existing QCCD Studio route and ZAC replay continue to use their native spatial and scheduling semantics. This compiler does not infer physical waveforms for arbitrary native schedules or infer unitary fidelity from a pulse name.

## Headless use and verification

Build with `lake build`. The bench and CLI share the compiler and Lean runtime. Save a bundle in the workbench, or obtain one of the editable reference bundles from `GET /api/machines/examples` (the `design` and `source` fields). Use the following commands from the project root.

```sh
node machine/cli.mjs --compile machine-and-source.json
node machine/cli.mjs --run machine-and-source.json
node machine/cli.mjs --run design.json circuit.qasm
node machine/cli.mjs --verify machine-replay.json
node machine/cli.mjs --wiring machine-and-source.json
node machine/cli.mjs --pulse machine-and-source.json
```

`--compile` checks the emitted images and netlist in Lean. `--run` emits a replay containing the source, design, source map, compiled image, initial state and physical events. Its exit code is 2 for a partial or faulted run. `--verify` independently re-executes the same input and compares all output fields. A verified partial trace retains its original stop status. The native executable also accepts the compiled program directly and checks its trace with `--check-trace`.

Use `POST /api/machines/compile` or `/api/machines/run` with the saved bundle. `POST /api/machines/ports` accepts an array of primitive models and returns their typed ports from the Lean definitions. The [compositional semantics](../QControl/Fabric.lean) includes a proof that serialized bus work never finishes before the preceding reservation. The [regression suite](../tests/machines.test.mjs) checks compiler routing, physical timing, native board equivalence and deterministic replay. Relating a high-level gate to a physical unitary still requires a calibrated model and an independent measurement.
