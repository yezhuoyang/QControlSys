# Waveform controller fidelity

The [controller bench](http://127.0.0.1:7432/controller) answers a specific hardware question. Given a sequencer program, a finite-width bus and a DAC sample clock, which waveform RAM word reaches each DAC strobe? The example is a reference design. No instrument serial number, firmware image, measured bus capture or analog calibration is associated with it.

## What each bench executes

| Bench | Executed behavior | Fidelity boundary |
| --- | --- | --- |
| Waveform controller | Instruction fetch and branches, waveform RAM reads, DMA, periodic bus grants, FIFO backpressure, sample deadlines, signed conversion and a programmable sampled response | One clock domain, one DMA master and one DAC. A grant mask represents reserved service slots. Vendor RTL, DDR command timings, clock jitter, RF mixing and downstream device dynamics remain outside this profile. |
| Two-board feed-forward | Scripted acquisition, timed register sampling, conditional pulse selection and a rectangular envelope | Fiber uses an aggregate latency. The program specifies the experiment sequence. |
| QCCD broadcast | Shared voltage knots, per-zone selector latching, prescribed ion displacement, settling and optical edges | Motion and electrode response use a reduced model. The independent controller bench shares the installation geometry. Its DAC samples do not drive these ions. |
| QCCD Studio replay | Native TSIR operations, locations and gate order compared with Studio. An independent Lean checker verifies placement. | The H2 fixture uses architectural time units. Its 947 cycles have no measured duration in nanoseconds. |
| Neutral-atom AOD | Timed tone changes, acoustic delivery and trap movement on the reference array | Frequency-to-position mapping and timing are profile assumptions. The controller's DAC path is independent of this model. |

## Reproduce a bandwidth failure

1. Open **FPGA waveform controller** and keep the input word at zero. The example requests 16 signed samples. A 32-bit beat every 8 ns supplies up to 500 MB/s. The DAC consumes one 16-bit word every 4 ns, also 500 MB/s. All 16 deadlines are met. Eight accepted beats move 32 bytes in the full 96 ns run, giving 333.333 MB/s including processor startup and shutdown.
2. Change **Bus width** to **16 bits**. The peak becomes 250 MB/s. The same DAC strobes now underrun at 56, 64, 72, 80 and 88 ns. At 56 ns select the underrun, inspect the empty input and step forward to the coincident bus transfer. The arriving word becomes eligible for the following strobe.
3. Restore **32 bits** and choose **Alternate slots**. The bus retains its 500 MB/s raw peak. The grant schedule allocates 250 MB/s on average and the first underrun occurs at 48 ns. Grant phase changes which deadlines are missed. The debugger distinguishes a reservation by another user from the destination FIFO declining a beat.
4. Restore **All slots** and set the **Input word** to 1. The conditional branch reads the bipolar waveform starting at address 16. Select a negative sample to inspect the original PCM value, signed DAC code, output voltage, producer beat and instruction address.

All rates use decimal MB/s. Granted capacity assumes a continually requesting master with space for every beat. Measured model throughput counts only the accepted payload and uses the full run duration as its denominator.

## Program and signal semantics

The editable [reference program](../examples/waveform-controller.json) and [Lean transition system](../QControl/Controller.lean) define the instrument. The instruction set belongs to QControl. QICK's documented timed processors and waveform generators are real examples of this architectural separation. QICK firmware and instruction binaries require their own adapter. [QICK timed processor manual](https://docs.qick.dev/latest/tprocv2_trm.html) · [QICK firmware](https://docs.qick.dev/latest/firmware/index.html)

| Instructions | Semantics |
| --- | --- |
| `load`, `add`, `jnz`, `jump` | Initialize or update a 16-bit wrapping accumulator and change the zero-based program counter. A nonzero input starts the example on the alternate branch. |
| `dma` | Issue a signed 16-bit waveform RAM range to the bus engine. A second DMA instruction retries until the first retires. A short final beat transfers only its remaining words. |
| `wait` | Skip the specified number of subsequent issue edges. The independent bus and sample clocks continue. |
| `play` | Request a number of DAC strobes and suspend issue until the final strobe. An empty FIFO inserts zero. Late data remains queued in address order. |
| `halt` | Halt instruction issue and finish after outstanding DMA retires. Instruction-fetch faults and cycle-budget exhaustion retain the last state and a stop reason. |

On each active core edge the DAC samples first, the bus commits second and the sequencer issues last. Clocks start at cycle zero. Time is in integer nanoseconds. Every recorded operation includes its timestamp, post-state, source instruction when applicable, predecessors and physical component IDs. Edges with no state change take time and produce no trace row. The bounded detail profile accepts up to 64 instructions, 256 waveform words, 32 FIFO words and 256 core cycles.

Each DAC strobe applies integer gain to signed PCM, reduces it to the selected 2–16 bit resolution, saturates the result, and maps it to a bipolar integer-microvolt output. At 12 bits and ±1 V, the extreme signed codes are −2048 and +2047. The positive extreme reports 999,511 µV. Up to eight signed Q15 filter taps define the sampled output response. Prior inputs start at zero. The trace holds each reported value until the next strobe, including after playback finishes. The example uses two taps with weights 0.75 and 0.25. Its coefficients are illustrative. No analog measurement was used to fit them.

## Experimental profiles and timing

The [hardware validation bench](physical-validation.md) composes the control model with device and readout profiles. A fractional core period uses `clockNs` for whole nanoseconds and `clockSubNsPs` for a remainder in picoseconds. For the 625 MS/s AOD experiment the period is exactly 1,600 ps. Traces from fractional clocks carry integer `atPs` and decimal `atNs`. A version 2 program can issue `playTriggered`, which resets the sample divider on issue and strobes one full sample period later. It supports two 400 ns update trains separated by a dwell on a 20 ns grid. Version 2 supports up to 4,096 core cycles and stops after a clock edge reaches its 1,024-event recording budget.

## Validation against a physical controller

The [Cora Z7 board measurements](board-validation.md) now give held-out voltage, propagation and DMA throughput residuals for a cold-atom installation. The [four-channel capture importer](controller-capture.md) compares synchronized instruction issue, bus payloads, sample strobes and connector voltage on the programmable waveform controller.

Choose a particular board, clock tree, firmware revision, DAC output, load and measurement bandwidth. Capture DMA grants, accepted beats and sample strobes on a shared trigger, and record the voltage at the chosen output. Include a clean run and one close to a bandwidth limit. Use one capture to fit parameters such as gain and filter coefficients. Reserve another program or operating point to test the fit.

**Save sample CSV** exports the simulator's signed waveform. **Compare an edge-sampled capture** accepts a trigger-aligned CSV with `timeNs,outputUv` and one measured row per corresponding DAC strobe. It reports RMS and peak voltage error and the largest absolute strobe-time error. Preserve the measured timestamps. For a continuously sampled scope trace, extract the values at observed strobes before import. The comparison checks sampled voltage and timing. An independent acquisition is necessary to assess accuracy. Agree on tolerances for the intended use, clock and instrument uncertainty before fitting. NIST discusses intended use, verification, validation and uncertainty in assessing digital twin credibility. [NIST credibility considerations](https://www.nist.gov/publications/credibility-consideration-digital-twins-manufacturing)
