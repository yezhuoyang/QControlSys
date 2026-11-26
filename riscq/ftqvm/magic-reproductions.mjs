// The two magic-state reproductions on /reproduce (riscq/ftqvm/magic.mjs runs them): what each
// page says about the paper, the program, the twin and what was found. The numbers on a page come
// from its run (validation/ftqvm/papers/<id>.json); the text here only describes them.

export const MAGIC_REPRODUCTIONS = [
  {
    id: "google-cultivation-2025",
    status: "reproduced",
    platform: "Superconducting transmons",
    title: "Magic state cultivation on Willow",
    paper: {
      authors: "E. Rosenfeld, G. Roberts, N. Lacroix, A. Bourassa et al. (Google Quantum AI)",
      title: "Magic state cultivation on a superconducting quantum processor",
      venue: "arXiv:2512.13908 (2025)", url: "https://arxiv.org/abs/2512.13908",
    },
    summary: "A |T⟩ state injected into a distance-3 color code, checked twice by measuring the logical Hadamard (T·X·T†) with postselection, and grafted into a distance-5 code on 54 transmons: about 40 times less error than injection alone.",
    program: "Two levels. The factory is the paper's own circuit, qubit for qubit: the supplement links every circuit it ran as a Crumble URL (copied verbatim into this repository), whose tagged identities name the T gates, echoes and injection angle the hardware played. The call is a logical program that consumes one magic state (`prepare |T>`: the `request_magic` system call, a Z⊗Z merge, an X readout, a frame update) on a distance-5 surface-code block, compiled against a machine whose factory is that circuit on the twin.",
    twin: "The transmons each circuit uses, at the circuit's own grid coordinates, a coupler between every pair one lattice step apart, 35 ns single-qubit and CZ gates (the paper's supplement), readout and reset from the group's 2023 paper. One RISC-Q core per transmon at 500 MHz; a T gate is a 45° pulse (half the 90° amplitude, same 35 ns), an echo an X pulse, a Hadamard a 90° pulse with a virtual Z.",
    findings: [
      "The circuits are the paper's: the kickback circuit has the 216 two-qubit gates and 54 measurements the text states, the grafting circuit the 54 qubits, and every CZ of all three lies on a coupler between grid neighbours. Run noiselessly with its real T gates (45° pulses), the kickback circuit keeps |T⟩ with no detector firing and rejects the orthogonal state every time.",
      "On the twin every operation of all three circuits ran inside its window: cultivation with standard tomography takes 3.62 µs, kickback tomography 14.05 µs (1308 pulses), injection, cultivation and graft on 54 transmons 7.24 µs. The controller's 2 ns grid turns the paper's 35 ns layers into 36 ns.",
      "Control needs one RISC-Q core per transmon. A core issues a timed write in 35 to 63 of its cycles (measured on the core model that matches RISC-Q's RTL), 70 to 126 ns at 500 MHz, so back-to-back 36 ns layers are kept only because the core gets ahead into its 32-entry queue. A core cannot drive two transmons in any case: RISC-Q builds exactly one demodulation channel into every core. A measured bit reaches its core's memory 64 ns after the readout window; the paper postselects offline, so no gate waits for it. One ZCU216 holds at most 14 RISC-Q cores, so the 54-qubit graft (56 cores) needs at least 4 boards; the Lean run keeps them on one board, so bits that would cross boards are not delayed (about 0.6 µs a crossing on RISC-Q's board-to-board network).",
      "Under the paper's own noise model (SI1000, p = 2.3×10⁻³) the kickback circuit keeps 11.9% of shots, against the 8% of the experiment, with 2.1×10⁻⁵ error among kept shots (75 flips in 3.6 million), below the experiment's 1–2×10⁻⁴. Between p = 1.5×10⁻³ and 4×10⁻³ the error grows as p^3.4, close to the p³ of fault distance three (Supplementary Fig. S19).",
      "As a system call: the compiler lowered a T gate on a distance-5 surface-code block against a machine whose factory is the 54-qubit graft circuit (25 output and 29 workspace qubits, 7.244 µs), and its VM admitted the listing (RESOURCE_VALIDATED). The factory's 54 qubits plus the program's block fit Willow's 105.",
      "The interface's factory contract has a fixed latency and no acceptance probability. Cultivation keeps 62.8% of its attempts here (the Fig. 2 circuit), so a kept state takes 11.5 µs on average, 1.6 times what the compiler reserves; a call to `request_magic` is a repeat-until-success service.",
    ],
    limits: [
      "The noise numbers come from the Clifford proxy the paper's own Stim circuits define (T gates as tagged identities, |+⟩ injected): the paper compares experiment with state-vector simulation, which is not repeated here. The state-vector run with the real T gates is noiseless (it checks the circuit, not the noise).",
      "Readout (500 ns) and reset (160 ns) are the group's 2023 values; the cultivation paper gives neither, so the circuits' times on the twin rest on them.",
      "An `I[conjugate]` pulse is taken as an X pulse: the paper says it restores the Pauli frame before a T layer but its Stim circuit does not say which Pauli.",
      "The grafted code of Fig. 4 is decoded in the paper with Tesseract; its noise is not simulated here, and the factory's acceptance is that of the Fig. 2 circuit (injection and cultivation).",
      "Only the transmons a circuit uses are placed: the full coordinate map of the 105-qubit chip is not published. Pulse shapes and frequencies are RISC-Q's x6y3 calibration at the paper's durations; leakage, crosstalk and flux transients are not modeled.",
    ],
    command: "npm run magic -- google 30000000 20000000",
  },
  {
    id: "quera-distillation-2025",
    status: "reproduced",
    platform: "Neutral atoms",
    title: "Logical magic state distillation, 5-to-1",
    paper: {
      authors: "P. Sales Rodriguez, J. M. Robinson, P. N. Jepsen, Z. He et al. (QuEra, Harvard, MIT)",
      title: "Experimental demonstration of logical magic state distillation",
      venue: "Nature 645, 620 (2025)", url: "https://arxiv.org/abs/2412.15165",
    },
    summary: "Five magic states injected into color codes (d = 3 on 35 atoms, d = 5 on 85), then distilled by the 5-to-1 protocol with transversal gates: one logical magic state out, from 95.1% to 99.4% fidelity at d = 3 and 92.5% to 98.6% at d = 5.",
    program: "Two levels. The factory is the paper's circuit rebuilt from its Methods and figures: both injection encoders from the row-operation lists (R_ops) and the 5-to-1 circuit of Fig. 3a on whole rows of atoms (transversal gates), on the physical rows of Extended Data Fig. 1. The call is a logical program that consumes one magic state (`prepare |T>`: the `request_magic` system call) on a Steane block, which is the compiler's distance-3 color code, compiled against a machine whose factory is the d = 3 circuit on the twin.",
    twin: "The 17 × 5 grid of tweezer sites, one row per logical qubit. Global Raman rotations at 650 kHz and local ones at 250 kHz (the paper's Rabi frequencies), one global Rydberg pulse per CZ layer with the moving atoms 2 µm from their partners, a global echo with every move, imaging of every atom. RISC-Q at 500 MHz (on ZCU216 boards: one at d = 3, two at d = 5) drives one core per optical system and camera cores that threshold four atoms' counts each.",
    findings: [
      "The circuits check out against the paper: the d = 3 encoder of the Methods' row operations makes the [[7,1,3]] color code with exactly the |+⟩ qubits and injection qubit the Methods name, and the 24 operations of the d = 5 encoder make a distance-5 code for one assignment of initial states only, which the twin uses. Fig. 3a accepts the syndrome 1011 with probability exactly 1/6 for perfect inputs and returns the pure magic state; for slightly depolarized inputs the output error is quadratic in the input error.",
      "On the twin every operation of both factories ran inside its window: the d = 3 factory takes 1.628 ms (35 atoms, six CZ layers of 139–233 µs each, dominated by AOD moves, then 500 µs of imaging) and the d = 5 factory 2.284 ms (85 atoms, eight CZ layers). Rotations, echoes and Rydberg pulses take about 13 µs of the 1.6 ms.",
      "With the paper's stated error rates (gates, SPAM, T2) learned with Stim and applied to the exact five-qubit channel, the injected states come out at 96.5% (d = 3) and 96.1% (d = 5) after correction, against the paper's 95.1% and 92.5%; the distilled state at 99.8% for both, against 99.4% and 98.6%. The twin is better than the device, and more so at d = 5, which moves atoms more: the move-induced errors the paper does not quantify are the likely difference.",
      "The factory accepts 5.2% of attempts at d = 3 and 0.70% at d = 5 with perfect stabilizers required on the four syndrome qubits (the ideal is 1/6).",
      "As a system call: the compiler lowered a T gate on a Steane block (its d = 3 color code) against a machine whose factory is the d = 3 circuit (7 output and 28 workspace atoms, the paper's 35, and 1.628 ms), and its VM admitted the listing (RESOURCE_VALIDATED). The compiler refuses a factory whose output is not a whole block of the code: the base machine's 9-qubit factory was rejected for the 7-qubit block.",
      "The interface's factory contract has a fixed latency and no acceptance probability. At the d = 3 factory's acceptance of 5.2%, a kept state takes 31 ms on average, 19 times what the compiler reserves: a factory with postselection needs a random-latency service in the system-call interface.",
    ],
    limits: [
      "The paper gives no durations of moves, Rydberg pulses, imaging or initialization. The twin uses the group's 2024 values (270 ns CZ, 500 µs imaging), Norcia et al. for optical pumping (100 µs), and a cited motion law (15 µs transfer, √(d/a) with a = 2750 m/s²) for moves; the pitch of 10 µm is the smallest the paper's 2 µm and 8 µm separations allow.",
      "Move-induced dephasing is part of the paper's error model but its size is not given; it is left out, so the twin's fidelities are upper bounds of the model.",
      "The CZ error is depolarizing; the paper's is biased towards Z and ZZ in proportions it does not give. Composite (amplitude-robust) pulse sequences are not published: a rotation takes its Rabi time.",
      "The paper plays the first √Y layer as one global pulse. With the d = 5 encoder of its row operations, four atoms do not turn in that layer, so the twin drives it locally at d = 5.",
      "Which atom of a pair moves, and whether moves avoid each other, is the twin's choice: the paper's search for move orders is not reproduced. Atom loss and the paper's sliding-scale postselection are not modeled.",
      "The decoder is a sampled lookup table for both distances (the paper's MLD at d = 3; at d = 5 the paper uses a most-likely-error decoder).",
      "The compiler has the d = 3 color code (Steane) built in but not the [[17,1,5]] code, so the system call is compiled for d = 3 only.",
    ],
    command: "npm run magic -- quera 200000",
  },
];

export const byId = (id) => MAGIC_REPRODUCTIONS.find((r) => r.id === id);
