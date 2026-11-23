# Qiskit Metal pocket-transmon layout

`metal_layout.py` instantiates the upstream `TransmonPocket` in a headless `DesignPlanar` using the `quantum-metal==0.10.1` release. The native QGeometry tables provide the conductor pads, microwave traces, ground removals, lumped junction, chip layer and port cross sections. We added two connection-pad options, `drive` at the upper left and `emit` at the lower right. All other component dimensions come from the versioned library. [Upstream component at release commit](https://github.com/qiskit-community/qiskit-metal/blob/6d67d409b0994259cb3e9ac1b492440e03178a6b/src/qiskit_metal/qlibrary/qubits/transmon_pocket.py) · [DesignPlanar chip defaults](https://github.com/qiskit-community/qiskit-metal/blob/6d67d409b0994259cb3e9ac1b492440e03178a6b/src/qiskit_metal/designs/design_planar.py) · [Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0)

Build the release in an isolated Python environment, then run the export.

```sh
python -m pip install quantum-metal==0.10.1 shapely==2.2.0 gdstk==1.0.2
python validation/superconducting/metal_layout.py
```

`metal-layout.json` stores planar coordinates in millimetres. The default substrate spans 9 × 6 mm and extends 0.75 mm below the metal surface. QGeometry paths use their native widths. The exporter resolves the ground mask by subtracting the union of negative polygons and widened paths from the chip rectangle. It unions the positive geometries to obtain connected electrode and port shapes. The renderer can draw the resulting `metalPolygons` directly, preserving each polygon's interior rings. The separate `junctions` records carry the endpoints and width of the lumped inductive element. Fabrication dimensions of an oxide barrier require a junction process mask.

The generator also writes a temporary native GDSII using the upstream renderer with optional flux-hole arrays disabled. It reads the file back with gdstk and compares the entire layer-1 metal mask by geometric symmetric difference. At 1 nm GDS precision, the 22 native polygons cover 53.666974160 mm². The difference from the five browser polygons is 6.48 × 10⁻⁹ mm², below the 10⁻⁷ mm² check. The two generated port widths are 10 µm with 6 µm gaps. Native GDS omits the lumped junction when a separate junction-cell mask is absent.

The layout is a reproducible example device. The experimental benchmark uses the measured cross-power of Labranca's separate transmon. No wafer mask, measured capacitance matrix or junction participation for that experimental device accompanies the benchmark. Its fitted drive coefficient and readout gain describe the measured sweep.

Predicting a new design's frequency and anharmonicity requires further electromagnetic or independently calibrated circuit inputs. In the energy-participation method, linearized eigenmode fields give the fraction of inductive energy in each junction. Those participations and the junction energies enter the quantum Hamiltonian. A drawn junction length and width alone do not supply these quantities. [Minev et al., *Energy-participation quantization of Josephson circuits*](https://doi.org/10.1038/s41534-021-00461-8)
