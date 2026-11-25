// Published experiments reproduced with FormalRV system calls on digital twins: what each page
// at /reproduce says about the paper, the program, the twin and what was found. The numbers on a
// page come from the run (validation/ftqvm/papers/<id>.json, written by riscq/ftqvm/papers.mjs);
// the text here only describes them.
import { MAGIC_REPRODUCTIONS } from "./magic-reproductions.mjs";
import { LOGICAL_REPRODUCTIONS } from "./logical-reproductions.mjs";

export const REPRODUCTIONS = [
  {
    id: "google-2025",
    status: "reproduced",
    platform: "Superconducting transmons",
    title: "Surface-code memory below threshold",
    paper: {
      authors: "Google Quantum AI and collaborators",
      title: "Quantum error correction below the surface code threshold",
      venue: "Nature 638, 920 (2025)", url: "https://arxiv.org/abs/2408.13687",
    },
    summary: "A distance-3, 5 and 7 rotated surface-code memory on the 105-qubit Willow processor, with a 1.1 µs error-correction cycle and real-time decoding.",
    program: "FormalRV's own surface-code declaration and an encoded program of R rounds of `extract`, then a `decode` (riscq/ftqvm/papers.mjs googleMemory). FormalRV's back end lowers it to physical gates, resets, routes, measurements and decodes.",
    twin: "The distance-7 patch of the paper's square grid: 49 data and 48 measure transmons, a tunable coupler between every diagonal pair, 25 ns XY rotations and 42 ns CZ from the paper, 500 ns readout and 160 ns reset from the group's 2023 paper. The control system is QuantumOS's RISC-Q model, the decoder Helios union-find compiled for its cores.",
    findings: [
      "Every operation of the listing ran inside its listed window on the twin at d = 3, 5 and 7.",
      "On the same gate durations, FormalRV's surface-code round takes 2.5 to 4.0 µs where the paper's cycle is 1.1 µs: FormalRV's round runs at most (d² − 1)/2 gates at once, while the device runs every check in parallel (four CZ layers, two H, measure and reset come to about 0.95 µs).",
      "The decoder compiled for RISC-Q's 500 MHz RISC-V core, timed by the core model that matches its RTL cycle for cycle, is slower than the paper's software decoder at d = 5 (191 µs for 10 rounds against 63 µs): a property of the decoder's placement, not of the system call.",
    ],
    limits: [
      "The data qubits are not read out at the end: FormalRV's encoded level has no transversal data readout in this form.",
      "Helios's decoding graph holds d rounds; a longer decode runs in consecutive windows without overlap.",
      "Qubit frequencies and pulse shapes are not published; the twin uses RISC-Q's pulse shapes with the paper's durations. 8 of the 105 qubits (leakage removal) are not placed.",
    ],
    command: "node riscq/ftqvm/papers.mjs google 10",
  },
  {
    id: "bluvstein-2024",
    status: "reproduced at d = 3",
    platform: "Neutral atoms",
    title: "Logical Bell pair by a transversal CNOT",
    paper: {
      authors: "D. Bluvstein, S. J. Evered, A. A. Geim, …, M. D. Lukin",
      title: "Logical quantum processor based on reconfigurable atom arrays",
      venue: "Nature 626, 58 (2024)", url: "https://arxiv.org/abs/2312.03982",
    },
    summary: "Two surface codes, one in |+⟩ and one in |0⟩, entangled by a transversal CNOT: one AOD move interlaces the two grids and one global Rydberg pulse acts on every pair.",
    program: "An encoded FormalRV program: |+⟩_L prepared in a logical ancilla block, `transversal CX` onto the data block, one stabilizer round on each block, then the Z⊗Z or X⊗X logical readout. FormalRV's staged back end compiles it with its `pipeline-loops` option, so the pairs of the transversal gate start within a few ns of each other.",
    twin: "The paper's zoned array: gate sites 10 µm apart (5 × 20 of them), one global Rydberg pulse of 270 ns for every gate site, global Raman layers of about 1 µs, a 200 µs AOD job per route on 2 AODs, readout as a 200 µs move to the readout zone and 500 µs imaging, up to 280 atoms, global optical pumping (100 µs, Norcia et al. 2023, as the paper gives no reset time).",
    findings: [
      "At d = 3 every operation ran inside its listed window, in both readout bases.",
      "Global pulses need synchronized layers: FormalRV times every gate on its own clock, and cannot ask that all gates of one kind in a zone happen together. The twin groups gates that its windows let start together; at d = 5 layers of different kinds still collide on the one Raman beam, and the derivation does not converge yet.",
      "A route is not an AOD job: routes that start together share one AOD move on the device, but FormalRV charges each route on its own. With the twin's real capacity of 2 AODs, FormalRV spreads the 9 pairs of the d = 3 transversal CNOT over about 0.8 ms, where one 200 µs move would carry them all.",
      "FormalRV's rate rule ⌈1000·N/D⌉ charges every concurrent request at least one item per µs. On a platform where a reset, a route or a readout takes 100 µs or more, capacities must be stated as concurrent requests, not physical rates; at d = 7, 120 concurrent 701 µs readouts are charged 120 bits/µs against a 100 bits/µs hub, although they need about 0.17.",
    ],
    limits: [
      "FormalRV's staged back end does not yet expand a transversal H on one block, so |+⟩_L is prepared directly (as the paper prepares it).",
      "Background maintenance of idle blocks is a reservation in the listing, not executed operations; the twin does not execute it.",
      "The camera readout (one exposure for every atom) is not modeled yet; this blocks d = 7.",
    ],
    command: "node riscq/ftqvm/papers.mjs bluvstein 3,5,7",
  },
  {
    id: "ryan-anderson-2024",
    status: "reproduced (transversal) on the 56-qubit H2",
    platform: "Trapped ions",
    title: "Logical teleportation of a Steane-code qubit",
    paper: {
      authors: "C. Ryan-Anderson et al. (Quantinuum)",
      title: "High-fidelity teleportation of a logical qubit using transversal gates and lattice surgery",
      venue: "arXiv:2404.16728 (2024)", url: "https://arxiv.org/abs/2404.16728",
    },
    summary: "Teleportation of a Steane-code [[7,1,3]] logical qubit on Quantinuum's H2, with up to 30 ions, by transversal gates and by lattice surgery.",
    program: "An encoded FormalRV program on FormalRV's own Steane [[7,1,3]] declaration (riscq/ftqvm/papers.mjs quantinuumTeleport): a Bell pair between two logical ancilla blocks (|+⟩_L, |0⟩_L and a `transversal CX`), one stabilizer round on each, a `transversal CX` from the source block, the source read in X and the first ancilla in Z, then Pauli-frame corrections on the target. FormalRV's staged back end compiles it with `pipeline-loops`.",
    twin: "Quantinuum H2 as QCCD Studio models it (arch/h2_racetrack.arch.json): a race track of 2 × 20 trap zones in one loop, no junctions, two ions per zone; MS 25 µs, one-qubit gate 5 µs and measurement 120 µs from the H2 paper (arXiv:2305.03828); split and merge 80 µs, 5 µs per shuttled zone and reset 50 µs from arXiv:2510.23519. Every two-qubit gate first carries its second ion around the loop to its partner's zone; `route` needs nothing. Run at H2's 32 qubits (2023) and at 56 qubits (2024, arXiv:2406.02501).",
    findings: [
      "On the 32-qubit H2, FormalRV refuses the program: a request of 26 ancillas exceeds its live-qubit budget of 19. Its background maintenance reserves measure qubits for every live block, so this three-block teleportation needs more qubits than the up to 30 ions the paper ran it on.",
      "On the 56-qubit H2 every operation ran inside its listed window: 39 ions placed, 611 operations, three iterations of the derivation.",
      "FormalRV's routes license groups larger than an H2 zone holds (a Steane check routes its ancilla with four data ions; zones hold two), so on this twin transport moves into the two-qubit gate and `route` costs nothing. The derived two-qubit gate is then 295 µs: the worst trip half way round the track plus the MS gate. A gate whose pair already shares a zone needs 35 µs, the median gate 215 µs.",
      "The Steane code's checks are decoded by the controller's lookup decoder in 154 to 428 ns, as Quantinuum decodes the Steane code with lookup tables.",
    ],
    limits: [
      "Only the transversal teleportation is reproduced; the lattice-surgery variant is not yet written.",
      "Transport is planned gate by gate. H2 moves its ions as one conveyor belt driven by three voltage signals; that synchronization is not modeled, nor is sympathetic cooling.",
      "The 56-qubit run keeps the 40-zone track of QCCD Studio's 32-qubit model; the zone layout of the 56-qubit device is not modeled.",
    ],
    command: "node riscq/ftqvm/papers.mjs quantinuum",
  },
  // Magic-state factories (riscq/ftqvm/magic.mjs): Google's cultivation and QuEra's distillation.
  ...MAGIC_REPRODUCTIONS,
  // Logical qubits with the decoder in the control program (riscq/ftqvm/logical.mjs): lattice and
  // qLDPC surgery, real-time decoding with feedback, colour codes, neutral atoms and ions.
  ...LOGICAL_REPRODUCTIONS,
];

export const byId = (id) => REPRODUCTIONS.find((r) => r.id === id);
