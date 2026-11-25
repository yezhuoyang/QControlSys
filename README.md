<p align="center"><img src="studio/quantumos.svg" width="72" height="72" alt="QuantumOS logo" /></p>

# QuantumOS

**Build and evaluate your fault-tolerant quantum operating system.**

A fault-tolerant program reaches the hardware only through system calls: allocate ancillas, route qubits, decode syndromes, request magic states, update the Pauli frame.
QuantumOS runs those calls on a real quantum computer, simulated down to its control system, and measures what each call costs.
The machine can be superconducting, trapped-ion or neutral-atom.

![QuantumOS architecture: a logical quantum program is lowered by fault-tolerant compilation to the Fault-Tolerant Quantum Execution Interface (QSysASM), physical instructions interleaved with system calls; the Quantum OS manages resources and executes it on RISC-Q control hardware for superconducting, trapped-ion and neutral-atom qubits, and measured costs flow back up](docs/media/quantumos-architecture.svg)

| System call | On the hardware | In QuantumOS today |
| --- | --- | --- |
| `request_ancilla` / `release_ancilla` | reset pulse · re-cooling and pumping · atom reload | next |
| `route` | couplers or SWAPs · ion shuttling · AOD tweezer moves | measured: ion shuttles 64–128 µs, AOD moves 90–145 µs |
| `H` `CNOT` `CZ` … | microwave pulses · laser beams · Rydberg and Raman light | **runs** |
| `measure` | readout, demodulation, threshold, publish to every core | **runs**: the bit reaches every core 86 ns after its window closes |
| `decode_syndrome` | syndrome bits to a decoder core | **runs**: 2-bit lookup in 64 ns; Helios union-find on a core, 17–58 µs at d = 3 |
| `request_magic` | one magic-state factory run | next |
| `pauli_frame_update` | frame bits flip, no pulse | **runs** |

Times are results of the model, read from the trace of the shipped examples, not hardware measurements.

![Ions shuttle between gate zones of a trap while the control cores around it drive the electrodes and lasers](docs/media/riscq-ions.gif)

**Trapped ions · a GHZ circuit, end to end.** OpenQASM compiled by [QCCD Studio], lowered to firmware for the control cores around the trap, executed in Lean. Ions shuttle between gate zones while each electrode waveform and laser pulse travels from its core to the trap. Played in machine time: 1 s of the animation is about 87 µs of the machine.

<http://127.0.0.1:7432/riscq-studio?example=qccd-ghz3&outcome=q0=1&outcome=q2=1&view=chip> → **Play**

## What you get

- **An operating-system interface.** Fault-tolerant programs written as system calls, each with a measured latency and the shared service it holds.
- **Three platforms underneath.** Superconducting transmons, trapped-ion QCCD machines, neutral-atom arrays.
- **The control system is modelled, not assumed.** Control cores that execute RV32I firmware, links, timed queues, DACs, electrode selectors, AOD tones.
- **Real inputs.** OpenQASM, [QCCD Studio] programs, [ZAC] programs, fault-tolerance system calls, and unmodified [RISC-Q] firmware binaries.
- **Real decoders on the controller.** The C union-find of the [Helios] decoder, compiled for a RISC-V control core, runs and matches Helios's own test vectors.
- **Your hardware, not ours.** Describe a machine as parts, positions and routed wires. Rules are checked, and every wire's length sets when its signal arrives.
- **A debugger for the hardware.** Every step has a stable ID, a part in the 3D scene, its causes and a state you can rebuild. Step forward, step back, click a part.
- **The same run without a browser.** A command line and a JSON API replay the same program and return the same trace, for scripts and agents.
- **Checked, with the limits stated.** Proofs in Lean about the model, conformance tests against RISC-Q and QCCD Studio, comparisons with published measurements.

It simulates the classical control system and the operations it schedules.
No quantum state is simulated. Measurement outcomes are inputs.

## Learn it

[QuantumOS Learn](http://127.0.0.1:7432/course/) follows the control loop from qubit physics through signal generation, readout, programmable logic and decoding. Tutorials include an editable switch-level FPGA cell, native [IBM Manila pulse schedules](http://127.0.0.1:7432/course/M1), the [Bluvstein transport experiment](http://127.0.0.1:7432/course/M2) and the [Quantinuum H2 phase scan](http://127.0.0.1:7432/course/M3). The workspace lessons retain their trace-based exercises. [Background](http://127.0.0.1:7432/learn) groups component tutorials, papers and technical references by the job they explain.

## Examples

Start the server ([quick start](#quick-start)), then open the address under a picture.
The animations are photographed from the running app ([how](docs/media/README.md)). The first two play in machine time; the others show one trace step per frame.

### Neutral atoms · a ZAC program on a zoned array

![AOD tweezers carry atoms from the storage zone into the entanglement zone](docs/media/riscq-atoms.gif)

A 14-qubit program compiled by [ZAC]. Two AODs pick atoms up, carry them into the entanglement zone and set them down; the control cores step each AOD tone frequency along the path. Atom positions are read back from the tone frequencies in the trace. 1 s of the animation is 70 µs of the machine.

<http://127.0.0.1:7432/riscq-studio?example=neutral-bv14&view=chip> → **Play**

### Superconducting qubits · feed-forward

![A measured bit travels through the controller and opens a conditional pulse](docs/media/riscq-feedforward.gif)

An OpenQASM program on a transmon ring. The measured bit leaves q0's readout, crosses the board hub to every control core, and opens the X pulse it conditions on q2.

<http://127.0.0.1:7432/riscq?example=superconducting-feedforward&outcome=c=1>

### Trapped ions · 32 ions around the H2 racetrack

![Ions shuttling around a racetrack trap and into its gate zones](docs/media/qccd-h2-racetrack.gif)

QCCD Studio's 32-qubit GHZ program: the whole register rotates, four ions enter the gate zones, laser pulses address them, single ions shuttle between sites. Physical view, drawn in millimetres.

<http://127.0.0.1:7432/qccd-studio> → **Focus: Trap electrodes and ions** → cycle 689

### Trapped ions · one DAC, many lanes

![An ion shuttles along one trap lane while the other lane holds](docs/media/qccd-broadcast.gif)

Two trap lanes share one transport waveform, and each lane's selector decides whether its ion follows. Ion A shuttles 120 µm, ion B holds, then the gate light opens on A. Enlarged working diagram.

<http://127.0.0.1:7432/qccd> → **Debugger detail**

### Neutral atoms · crossed AOD tones

![Atoms move with the tones of two crossed deflectors](docs/media/neutral-aod.gif)

Two crossed acousto-optic deflectors (AODs) place the tweezers. Stepping a column tone carries both atoms on that column, 500 nm per step. A row tone then moves its whole row, empty trap included. Enlarged working diagram.

<http://127.0.0.1:7432/neutral> → **Debugger detail**

### Fault tolerance · a decoder core and a Pauli frame

![A decoder core reads the syndrome and stores a Pauli-frame update](docs/media/riscq-decoder.gif)

A repetition-code round written as system calls. The decoder core reads two syndrome bits from the board hub, looks up the correction and records a Pauli-frame update. No pulse is played.

<http://127.0.0.1:7432/riscq?example=superconducting-repetition&outcome=s0=1&step=803>

### Classical control · two-board feed-forward

![Two control boards joined by a fiber link](docs/media/feedforward-boards.gif)

Board A digitizes a readout and sends two bits over fiber. Board B samples them on its clock edge, reads waveform memory and drives the RF pulse.

<http://127.0.0.1:7432/feedforward>

### Your own hardware · design editor

![A hardware design in 3D: control cores and converters on a board, coax routed to a transmon chip](docs/media/riscq-design.png)

Place boards, cores, DACs, ADCs, qubits and resonators, then route the wires in 3D. Each wire's delay follows from its routed length. Rules are checked on every edit. Then run a program on the result.

<http://127.0.0.1:7432/riscq-design> → **Run on this hardware**

### Also runnable

```sh
node riscq/cli.mjs --example decoder-helios-d3                 # Helios union-find, compiled C on a control core
node riscq/cli.mjs --ring-design > machine.json                # a machine as an editable design document
node riscq/cli.mjs --design machine.json --qasm circuit.qasm   # run a program on your design
```

<!-- More examples go here. Copy a block above: heading, GIF, one caption line, one address or command.
     Add the GIF as a scene in docs/media/capture.mjs and rebuild it by name. -->

<a id="run-the-studio"></a>

## Quick start

```sh
npm ci
npm start        # builds the Lean model, then serves http://127.0.0.1:7432
```

- Needs Node.js with npm and Lean's [Elan](https://github.com/leanprover/elan) toolchain manager.
- The QCCD Studio examples also need Python 3.10+ and the [QCCD Studio] compiler branch in a sibling folder named `QCCD`.
- Without a browser, after `npm start` or `lake build`:

```sh
node riscq/cli.mjs --list
node riscq/cli.mjs --example superconducting-feedforward --outcome c=1 --out run.json
```

Pages: `/` home · `/course` the course · `/riscq-studio` RISC-Q workspace · `/riscq-design` hardware design editor · `/riscq` controller debugger · `/qccd-studio` · `/qccd` · `/neutral` · `/feedforward` · `/controller` · `/validation` · `/board-validation`

## Deploy

```sh
docker build -t quantumos .
docker run -p 8080:8080 quantumos      # then open http://localhost:8080
```

The image builds the Lean model and installs [QCCD Studio] with its pinned compiler for the trapped-ion examples. The public site, https://quantumos.it.com, runs beside QCCD Studio as a systemd service. [deploy/README.md](deploy/README.md) gives the DNS records, how the site is updated, and the Docker alternative. Without Docker, run `npm start` behind a reverse proxy with these settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 7432 | Port to listen on (`QCONTROL_PORT` is also accepted) |
| `QUANTUMOS_HOST` | 127.0.0.1 | Address to listen on. Use `0.0.0.0` to accept outside connections |
| `QUANTUMOS_MAX_RUNS` | 4 | Simulations that run at once. Each runs the Lean executable, and QCCD runs also Python |
| `QUANTUMOS_MAX_QUEUE` | 16 | Simulations that may wait. Further requests are answered 503 until a slot frees |
| `QUANTUMOS_CACHE_SECONDS` | 300 | How long browsers may cache pages, scripts and images |
| `QCCD_STUDIO_ROOT` | `../QCCD` | QCCD Studio checkout for the trapped-ion examples |
| `QCONTROL_PYTHON` | `python` | Python 3.10+ executable for the QCCD Studio bridge |

Every simulation runs inside step, event and time budgets (`riscq/examples.mjs`, `server.mjs`), and request bodies are size-limited. The server has no accounts and stores nothing; progress in the course stays in each visitor's browser.

## How it works

| Level | What it is |
| --- | --- |
| 1. Source | OpenQASM, a QCCD Studio program, a ZAC program, or a list of fault-tolerance system calls |
| 2. Hardware instructions | Timed physical operations: pulses, ion shuttles, AOD moves |
| 3. Firmware | RV32I machine code for [RISC-Q] control cores |
| 4. Execution | A Lean 4 model of the controller runs the firmware and emits a trace |
| 5. Debugger | The browser steps through the trace. Scene, plots and inspector are derived from it |

- This chain is the controller debugger at `/riscq`, for all three platforms.
- `/qccd`, `/neutral`, `/feedforward` and `/controller` work the same way on their own programs: the Lean model executes, the page replays the trace.
- `/qccd-studio` replays QCCD Studio's own execution, and Lean checks every ion placement.

## What is verified

- **Proved in Lean, about the model.** For example, a register write issued early enough lands exactly on its start time ([`land_exact`](QControl/RiscQ/Timing.lean)).
- **Tested against other people's artifacts.** Three unmodified RISC-Q firmware binaries reproduce what RISC-Q's RTL simulations assert. The H2 replay is compared with QCCD Studio's own viewer on all 947 cycles.
- **Not hardware measurements.** Timings are results of the model, with published values where a program states none ([sources](riscq/standards.mjs)). The controller scene is a schematic floorplan.

[What is proved, what is tested, what is assumed](docs/riscq-controller.md#what-is-proved-what-is-tested-what-is-assumed)

## Documents

- [Studio guide](docs/studio-guide.md): every bench step by step, the Lean model, headless use. This was the README.
- [RISC-Q controller model](docs/riscq-controller.md): lowering paths, register map, latencies, proofs, tests, first measurements
- [Machine workbench](docs/component-machines.md): machine format, source languages, timing semantics
- [Waveform controller](docs/controller-fidelity.md): fidelity, assumptions, a worked experiment
- [Hardware validation](docs/physical-validation.md) · [Board measurements](docs/board-validation.md) · [Capture format](docs/controller-capture.md)
- [Literature review](docs/literature-review.md) · [Architecture and development plan](docs/development-plan.md)
- [Development rule](AGENTS.md) · [How the animations are made](docs/media/README.md)

## License

QuantumOS is released under the [MIT License](LICENSE). Vendored third-party files keep their own licences: RISC-Q firmware and runtime (MIT, [validation/riscq/firmware/LICENSE](validation/riscq/firmware/LICENSE)) and the Helios decoder (BSD-3-Clause, [validation/decoders/helios/LICENSE](validation/decoders/helios/LICENSE)).

[QCCD Studio]: https://github.com/yezhuoyang/QCCD/tree/compiler
[ZAC]: https://github.com/UCLA-VAST/ZAC
[RISC-Q]: https://github.com/Wu-Quantum-Application-System-Group/RISC-Q
[Helios]: https://github.com/NamiLiy/Helios_scalable_QEC
