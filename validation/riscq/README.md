# RISC-Q reference artifacts

Files in this directory come from [RISC-Q](https://github.com/Wu-Quantum-Application-System-Group/RISC-Q) at commit `243d814dc2bdb323dbca891f6c6a263d18ab853f` (MIT license, see `firmware/LICENSE`). They are inputs to the conformance tests of the controller model.

| File | RISC-Q path | Use |
| --- | --- | --- |
| `firmware/pulse_sched.elf`, `.S` | `src/riscq/soc/sim/sw/` | One core schedules a gate pulse. Checked by RISC-Q's `PulseTableSocCpuSim` |
| `firmware/xcore.elf`, `.S` | `src/riscq/soc/sim/sw/` | Two cores publish, signal, meet at a barrier and schedule. Checked by `XcoreCpuSim` |
| `firmware/host_window.elf`, `.S` | `src/riscq/soc/sim/sw/` | Stores to the host result window. Checked by `HostWindowCpuSim` |
| `fw/start.S`, `fw/muldiv.c`, `fw/riscq.h` | `software/fw/` | RISC-Q's firmware runtime, unmodified. C firmware is linked with it ([riscq/toolchain.mjs](../../riscq/toolchain.mjs)) |
| `sim-2q.json`, `sim-dio.json`, `x6y3.json`, `zcu216-14q.json` | `software/configs/` | Build descriptions: cores, channels, converters, link depth, clock |
| `x6y3-calibration.json` | extracted from `examples/cal-config-x6y3.yaml` | Durations, amplitudes, frequencies and phases of an eight-qubit ring |

SHA-256 of the binaries:

```
87b6a32379eca65eb82509eef978eb39c4351f567d1f533135a16949d0b3d422  firmware/pulse_sched.elf
240c39651c026f867d50b397b8d745c8fa2f7395f65dc88728ae990f207af4cb  firmware/xcore.elf
4bc4de1f9fd55625ed69441b80c4e728f9d9b563804586e4faf4f52c1b18a72a  firmware/host_window.elf
```

Regenerate the calibration extract from a RISC-Q checkout with `python validation/riscq/extract_calibration.py <checkout>`. It needs PyYAML. The extract keeps the source's units: seconds, hertz, fraction of DAC full scale and radians.
