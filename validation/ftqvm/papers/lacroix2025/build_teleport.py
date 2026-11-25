"""Reconstruct the lattice-surgery teleportation circuit of Lacroix et al. (2025).

Source of every gate: arXiv:2412.14256v1, Appendix I.1, Fig. 15 ("Detailed quantum
circuit used to teleport |1_L> from logical qubit L1 to logical qubit L2"), panels 0-29,
read frame by frame; tile/stabilizer shapes from Fig. 5c-e.  Nothing here comes from
the paper's Zenodo dataset (it holds memory experiments only).

Figure coordinates (fr, fc): fr = row 0..8 top to bottom, fc = column 0..5 left to
right, exactly as drawn in Fig. 5c / Fig. 15.  L1 occupies rows 0-3, the interface row
is 4, L2 occupies rows 5-8.  Chip coordinates are (row, col) on the 72-qubit Willow
grid in the same convention as the paper's Zenodo QUBIT_COORDS (and Fig. 8 axes).
The paper does not say where on the chip this experiment ran; PLACEMENT below is our
choice (see README).

Detectors are derived, not hand-written: for each stabilizer measured in a QEC cycle,
stim's flow solver finds the measurement set that reveals it in that cycle and the
set that fixed its value in earlier cycles (chunk-by-chunk, so solutions are local).
Observables are derived the same way from the paper's frame update Z_L^m1 X_L^m2.

Run:  python -I build_teleport.py   (writes the .stim files next to this script)
"""
import json
import os
import sys

import stim

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- layout (Fig. 5c-e, Fig. 15)
L1_DATA = [(0, 2), (1, 1), (2, 2), (2, 3), (3, 0), (3, 1), (3, 4)]
L2_DATA = [(5, 0), (5, 1), (5, 4), (6, 2), (6, 3), (7, 1), (8, 2)]
IF_DATA = [(4, 2), (4, 3)]           # interface data qubits, Bell pair during merge
INACTIVE_ROW4 = [(4, c) for c in range(6)]

# Each tile: two auxiliaries.  'a' = the one reset with R_X in Fig. 15 panel 0/10,
# control of the Bell-pair CNOT (panel 1/11) and of the final CNOT (panel 8/18),
# measured M_X (panel 9/19).  'b' = reset R, CNOT target, measured M (Z basis).
# color: 0 red, 1 green, 2 blue (chromobius convention).
TILES = {
    # name     a       b       color support (data qubits)
    "blue1":  ((1, 2), (1, 3), 2, [(0, 2), (1, 1), (2, 2), (2, 3)]),
    "red1":   ((2, 1), (2, 0), 0, [(1, 1), (2, 2), (3, 0), (3, 1)]),
    "green1": ((3, 2), (3, 3), 1, [(2, 2), (2, 3), (3, 1), (3, 4)]),
    "red2":   ((5, 2), (5, 3), 0, [(5, 1), (5, 4), (6, 2), (6, 3)]),
    "green2": ((6, 1), (6, 0), 1, [(5, 0), (5, 1), (6, 2), (7, 1)]),
    "blue2":  ((7, 2), (7, 3), 2, [(6, 2), (6, 3), (7, 1), (8, 2)]),
    # merge-only tiles (Fig. 5d): weight-6 expansions and hatched X-only tiles
    "green1x": ((3, 2), (3, 3), 1, [(2, 2), (2, 3), (3, 1), (3, 4), (4, 2), (4, 3)]),
    "red2x":   ((5, 2), (5, 3), 0, [(5, 1), (5, 4), (6, 2), (6, 3), (4, 2), (4, 3)]),
    "hatL":    ((4, 1), (4, 0), 2, [(3, 0), (3, 1), (4, 2), (5, 0), (5, 1)]),
    "hatR":    ((4, 5), (4, 4), 2, [(3, 4), (4, 3), (5, 4)]),
}
X_ONLY = {"hatL", "hatR"}
SEPARATE = ["blue1", "red1", "green1", "red2", "green2", "blue2"]
MERGED = ["blue1", "red1", "green1x", "hatL", "hatR", "red2x", "green2", "blue2"]

# CNOT layers read from Fig. 15. Z-part: (data -> aux). X-part uses the same pairs
# reversed (aux -> data), in the same layer order (panels 5-7 mirror 2-4, 15-17 mirror 12-14).
Z_LAYERS_SEPARATE = [
    # panel 2
    [((2, 2), (1, 2)), ((2, 3), (1, 3)), ((3, 0), (2, 0)), ((3, 1), (2, 1)),
     ((6, 2), (5, 2)), ((6, 3), (5, 3)), ((7, 1), (6, 1)), ((8, 2), (7, 2))],
    # panel 3
    [((1, 1), (1, 2)), ((2, 2), (2, 1)), ((3, 1), (3, 2)), ((3, 4), (3, 3)),
     ((5, 1), (5, 2)), ((5, 4), (5, 3)), ((6, 2), (6, 1)), ((7, 1), (7, 2))],
    # panel 4
    [((0, 2), (1, 2)), ((1, 1), (2, 1)), ((2, 2), (3, 2)), ((2, 3), (3, 3)),
     ((5, 0), (6, 0)), ((5, 1), (6, 1)), ((6, 2), (7, 2)), ((6, 3), (7, 3))],
]
# merge adds (panels 12-14): interface data into the expanded green (L1) / red (L2) tiles
Z_LAYERS_MERGE_EXTRA = [
    [((4, 2), (3, 2)), ((4, 3), (3, 3))],
    [],
    [((4, 2), (5, 2)), ((4, 3), (5, 3))],
]
# hatched X-only tiles, X-part only (panels 15-17), as (aux, data)
X_LAYERS_HATCHED = [
    [((4, 0), (5, 0)), ((4, 1), (5, 1)), ((4, 4), (5, 4))],
    [((4, 1), (4, 2)), ((4, 4), (4, 3))],
    [((4, 0), (3, 0)), ((4, 1), (3, 1)), ((4, 4), (3, 4))],
]

X_L1 = [(3, 0), (3, 1), (3, 4)]   # = Z_L1 support (Fig. 5c black line)
X_L2 = [(5, 0), (5, 1), (5, 4)]   # = Z_L2 support (Fig. 5e black line)

# ---------------------------------------------------------------- chip placement
CHIP_ROWS = {0: (5, 5), 1: (4, 6), 2: (3, 7), 3: (2, 8), 4: (1, 9), 5: (0, 10),
             6: (0, 10), 7: (1, 9), 8: (2, 8), 9: (3, 7), 10: (4, 6), 11: (5, 5)}
CHIP = {(r, c) for r, (lo, hi) in CHIP_ROWS.items() for c in range(lo, hi + 1)}
assert len(CHIP) == 72
# d=5 patch qubits from the Zenodo metadata (dataset_0/d5/*/metadata.json), used only
# to tie-break the placement toward the region the paper calibrated for its d=5 code.
D5_QUBITS = {(0, 5), (1, 4), (1, 5), (1, 6), (2, 3), (2, 4), (2, 5), (2, 6), (3, 3), (3, 4),
             (3, 5), (3, 6), (3, 7), (4, 2), (4, 3), (4, 4), (4, 5), (4, 6), (4, 7), (4, 8),
             (5, 1), (5, 2), (5, 3), (5, 4), (5, 5), (5, 6), (5, 7), (5, 8), (5, 9), (6, 1),
             (6, 2), (6, 3), (6, 4), (6, 5), (6, 6), (6, 7), (6, 8), (6, 9)}


def all_fig_qubits():
    s = set(L1_DATA) | set(L2_DATA) | set(INACTIVE_ROW4)
    for name, (a, b, _, _) in TILES.items():
        s |= {a, b}
    return s


def choose_placement():
    """Same orientation as the figure (no rotation); translation that fits on the chip,
    maximizes overlap with the d=5 patch, then is closest to the chip centre."""
    fig = all_fig_qubits()
    best = None
    for dr in range(-2, 12):
        for dc in range(-2, 12):
            m = {q: (q[0] + dr, q[1] + dc) for q in fig}
            if not all(v in CHIP for v in m.values()):
                continue
            overlap = len(set(m.values()) & D5_QUBITS)
            cr = sum(v[0] for v in m.values()) / len(m)
            cc = sum(v[1] for v in m.values()) / len(m)
            dist = (cr - 5.5) ** 2 + (cc - 5.0) ** 2
            key = (-overlap, dist, dr, dc)
            if best is None or key < best[0]:
                best = (key, dr, dc)
    return best[1], best[2]


DR, DC = choose_placement()


def chip(q):
    return (q[0] + DR, q[1] + DC)


# ---------------------------------------------------------------- circuit construction
def active_qubits():
    qs = set(L1_DATA) | set(L2_DATA) | set(IF_DATA)
    for name in set(SEPARATE) | set(MERGED):
        a, b, _, _ = TILES[name]
        qs |= {a, b}
    return sorted(qs, key=lambda q: (chip(q)[0], chip(q)[1]))


QUBITS = active_qubits()
QI = {q: i for i, q in enumerate(QUBITS)}


class Chunk:
    """A list of layers; each layer is a list of (gate, [targets]) applied in one time step."""

    def __init__(self, name):
        self.name = name
        self.layers = []
        self.meas = []  # (key, fig qubit) in order

    def layer(self, ops):
        ops = [(g, t) for g, t in ops if t]
        self.layers.append(ops)
        for g, t in ops:
            if g in ("M", "MX", "MY"):
                for q in t:
                    self.meas.append(((self.name, q), q))

    def circuit(self):
        c = stim.Circuit()
        for i, ops in enumerate(self.layers):
            if i:
                c.append("TICK")
            for g, t in ops:
                if g in ("CX",):
                    c.append(g, [QI[x] for pair in t for x in pair])
                else:
                    c.append(g, [QI[q] for q in t])
        return c


def cycle(name, tiles, merge_first=False, merge_last=False):
    ch = Chunk(name)
    a_s = [TILES[t][0] for t in tiles]
    b_s = [TILES[t][1] for t in tiles]
    merged = "hatL" in tiles
    # reset layer (panel 0 / 10 / 20)
    rx = list(a_s) + ([(4, 2)] if merge_first else [])
    rz = list(b_s) + ([(4, 3)] if merge_first else [])
    ch.layer([("RX", rx), ("R", rz)])
    # Bell-pair preparation (panel 1 / 11 / 21)
    bell = [(TILES[t][0], TILES[t][1]) for t in tiles]
    if merge_first:
        bell.append(((4, 2), (4, 3)))
    ch.layer([("CX", bell)])
    # Z-part (panels 2-4 / 12-14 / 22-24)
    for k in range(3):
        pairs = list(Z_LAYERS_SEPARATE[k])
        if merged:
            pairs += Z_LAYERS_MERGE_EXTRA[k]
        ch.layer([("CX", pairs)])
    # X-part (panels 5-7 / 15-17 / 25-27): same pairs reversed
    for k in range(3):
        pairs = [(aux, d) for d, aux in Z_LAYERS_SEPARATE[k]]
        if merged:
            pairs += [(aux, d) for d, aux in Z_LAYERS_MERGE_EXTRA[k]]
            pairs += X_LAYERS_HATCHED[k]
        ch.layer([("CX", pairs)])
    # final CNOT of the Bell measurement (panel 8 / 18 / 28)
    fin = [(TILES[t][0], TILES[t][1]) for t in tiles]
    if merge_last:
        fin.append(((4, 2), (4, 3)))
    ch.layer([("CX", fin)])
    # measurement (panel 9 / 19 / 29)
    mx = list(a_s) + ([(4, 2)] if merge_last else [])
    mz = list(b_s) + ([(4, 3)] if merge_last else [])
    # Data qubits idle during auxiliary readout carry an XY4 dynamical-decoupling
    # sequence (App. D.1); like the paper's Zenodo circuits we mark it with an explicit
    # identity gate "I" (a no-op in the ideal circuit, a 1q-gate slot for noise models).
    idle_data = [] if name == "split" else list(L1_DATA) + list(L2_DATA) + (
        list(IF_DATA) if merged and not merge_last else [])
    ch.layer([("MX", mx), ("M", mz), ("I", idle_data)])
    return ch


def build(state, l2_basis):
    """state in '0','1','+','-' prepared on L1; L2 starts in |0_L>; L2 read out in l2_basis."""
    prep = Chunk("prep")
    prep.layer([("R", L1_DATA + L2_DATA)])
    if state == "1":
        prep.layer([("X", L1_DATA)])
    elif state == "+":
        prep.layer([("H", L1_DATA)])
    elif state == "-":
        prep.layer([("X", L1_DATA)])
        prep.layer([("H", L1_DATA)])
    chunks = [
        cycle("init", SEPARATE),
        cycle("merge1", MERGED, merge_first=True),
        cycle("merge2", MERGED),
        cycle("merge3", MERGED, merge_last=True),
        cycle("split", SEPARATE),
    ]
    final = Chunk("final")
    final.layer([("M", L1_DATA), ({"Z": "M", "X": "MX", "Y": "MY"}[l2_basis], L2_DATA)])
    return prep, chunks, final


def pauli(basis, qs):
    p = stim.PauliString(len(QUBITS))
    for q in qs:
        p[QI[q]] = basis
    return p


def solve(chunk_circuit, inp, out):
    if inp.weight == 0 and out.weight == 0:
        return []
    return chunk_circuit.solve_flow_measurements([stim.Flow(input=inp, output=out)])[0]


def assemble(state, l2_basis):
    prep, chunks, final = build(state, l2_basis)
    seq = [prep] + chunks + [final]
    assert prep.circuit().num_measurements == 0
    circs = [c.circuit() for c in seq]
    offsets, n = [], 0
    for c in circs:
        offsets.append(n)
        n += c.num_measurements
    keys = []
    for ch in seq:
        keys += [k for k, _ in ch.meas]

    def glob(i, idx):
        return [offsets[i] + m for m in idx]

    def back(i, P):
        """Measurements (global) fixing the value of P at the end of chunk i."""
        if i < 0:
            return None
        s = solve(circs[i], pauli("I", []), P) if P.weight else []
        if s is not None:
            return glob(i, s)
        s = solve(circs[i], P, P)
        if s is None:
            return None
        rest = back(i - 1, P)
        return None if rest is None else sorted(set(glob(i, s)) ^ set(rest))

    detectors = []  # (chunk index, meas list, coords, label)
    reset_in = {i: set() for i in range(len(seq))}
    for i, ch in enumerate(seq):
        for g, t in ch.layers[0]:
            if g in ("R", "RX"):
                reset_in[i] |= set(t)

    def add_det(i, P, label, meas_q, col4):
        A = solve(circs[i], P, pauli("I", []))
        if A is None:
            return "random"
        B = back(i - 1, P)
        if B is None:
            return "random"
        m = sorted(set(glob(i, A)) ^ set(B))
        r, c = chip(meas_q)
        detectors.append((i, m, (r, c, i - 1, col4), label))
        return "det"

    status = {}
    for i in range(1, len(seq) - 1):          # QEC cycles
        ch = seq[i]
        tiles = MERGED if ch.name.startswith("merge") else SEPARATE
        for t in tiles:
            a, b, color, sup = TILES[t]
            alive = [q for q in sup if q not in reset_in[i]]
            status[(ch.name, t, "X")] = add_det(i, pauli("X", alive), f"{ch.name}:{t}:X", a, color)
            if t in X_ONLY:
                # Bell-pair Z-parity of an X-only tile: no data coupled, so it is a
                # deterministic check of the auxiliary pair itself (acts as a flag).
                idx = [k for k, (key, q) in enumerate(ch.meas) if q == b][0]
                assert circs[i].has_flow(stim.Flow(input=pauli("I", []), output=pauli("I", []),
                                                   measurements=[idx]), unsigned=True)
                r, c = chip(b)
                detectors.append((i, [offsets[i] + idx], (r, c, i - 1, -1), f"{ch.name}:{t}:Zpair"))
                status[(ch.name, t, "Zpair")] = "det"
            else:
                status[(ch.name, t, "Z")] = add_det(i, pauli("Z", alive), f"{ch.name}:{t}:Z", b, 3 + color)
        if ch.name == "merge3":
            # interface Bell pair measured in the Bell basis (panel 19)
            status[("merge3", "bellXX", "X")] = add_det(i, pauli("X", IF_DATA), "merge3:bell:XX", (4, 2), -1)
    # final data measurement
    i = len(seq) - 1
    for t in SEPARATE:
        a, b, color, sup = TILES[t]
        basis = "Z" if t.endswith("1") else l2_basis
        if basis == "Y":
            continue
        col4 = (3 if basis == "Z" else 0) + color
        status[("final", t, basis)] = add_det(i, pauli(basis, sup), f"final:{t}:{basis}", b, col4)

    # ---- observables (paper Fig. 5a / App. I.1: frame update Z_L^m1 X_L^m2 on L2)
    obs, m1, m2 = None, None, None
    idx_merge3 = [k for k, ch in enumerate(seq) if ch.name == "merge3"][0]
    if l2_basis == "Z" and state in "01":
        P = pauli("Z", X_L1 + X_L2)     # Z_L1 Z_L2 is preserved by the M_XX merge
        A = glob(i, solve(circs[i], P, pauli("I", [])))
        obs = sorted(set(A) ^ set(back(i - 1, P)))
        m2 = sorted(glob(i, solve(circs[i], pauli("Z", X_L1), pauli("I", []))))
    if l2_basis == "X" and state in "+-":
        PL2 = pauli("X", X_L2)
        A = glob(i, solve(circs[i], PL2, pauli("I", [])))
        S4 = back_prop = None
        # split cycle: X_L2 -> X_L2
        acc = set(A)
        for j in range(i - 1, idx_merge3, -1):
            acc ^= set(glob(j, solve(circs[j], PL2, PL2)))
        # merge cycle 3: X_L1 (in) -> X_L2 (out) using the M_XX outcome m1
        m1 = sorted(glob(idx_merge3, solve(circs[idx_merge3], pauli("X", X_L1), PL2)))
        acc ^= set(m1)
        acc ^= set(back(idx_merge3 - 1, pauli("X", X_L1)))
        obs = sorted(acc)
    # m1 is reported for every variant (it is the same measurement set)
    if m1 is None:
        m1 = sorted(glob(idx_merge3, solve(circs[idx_merge3], pauli("X", X_L1), pauli("X", X_L2))))
    if m2 is None:
        m2 = sorted(glob(i, solve(circs[i], pauli("Z", X_L1), pauli("I", []))))

    # ---- emit
    out = stim.Circuit()
    for q in QUBITS:
        r, c = chip(q)
        out.append("QUBIT_COORDS", [QI[q]], [r, c])
    total = 0
    for k, (ch, c) in enumerate(zip(seq, circs)):
        if k == 0:
            continue  # the data-preparation chunk is emitted merged into the init cycle
        if k > 1:
            out.append("TICK")
        if k == 1:
            # Fig. 15 panel 0: data reset in the same layer as the auxiliary resets,
            # then the single-qubit preparation of L1, then the Bell-pair CNOTs.
            # (Operations on disjoint qubits, so this equals prep followed by init.)
            merged = Chunk("emit")
            merged.layers = [prep.layers[0] + ch.layers[0]] + prep.layers[1:] + ch.layers[1:]
            c = merged.circuit()
        out += c
        total += c.num_measurements
        for (ci, m, coords, label) in detectors:
            if ci == k:
                out.append("DETECTOR", [stim.target_rec(x - total) for x in m], list(coords))
        if k == len(seq) - 1 and obs is not None:
            out.append("OBSERVABLE_INCLUDE", [stim.target_rec(x - total) for x in obs], [0])
    info = {
        "detectors": [{"label": lab, "measurements": m, "coords": list(co)} for (_, m, co, lab) in detectors],
        "observable_measurements": obs,
        "m1_MXX_measurements": m1,
        "m2_ZL1_measurements": m2,
        "measurement_keys": [[k[0], list(chip(k[1]))] for k in keys],
        "status": {"|".join(k): v for k, v in status.items()},
    }
    return out, info


def header(state, basis):
    pr, pc = DR, DC
    return (
        f"# Lacroix et al., Nature 645, 614 (2025), arXiv:2412.14256 -- App. I.1 Fig. 15 / Fig. 5\n"
        f"# Lattice-surgery teleportation L1 -> L2 (two d=3 superdense color codes), M_XX via\n"
        f"# 3 merge cycles + 1 split cycle.  Input |{state}_L> on L1, L2 read out in {basis}.\n"
        f"# RECONSTRUCTED from the paper's figures (no circuit file was published for this\n"
        f"# experiment).  Gates are the CNOTs drawn in Fig. 15 (before compilation to H+CZ).\n"
        f"# QUBIT_COORDS = (row, col) on the 72-qubit grid; placement offset (+{pr},+{pc}) from\n"
        f"# figure coordinates is OUR choice: the paper does not give chip coordinates.\n"
        f"# DETECTOR coords = (row, col, cycle, chromobius basis/color; -1 = flag/ignore).\n"
        f"# OBSERVABLE 0 = teleported logical after the frame update Z_L^m1 X_L^m2 on L2.\n"
    )


def main():
    os.makedirs(HERE, exist_ok=True)
    variants = [("1", "Z", "circuit-teleport.stim"),
                ("0", "Z", "circuit-teleport-0.stim"),
                ("1", "Z", "circuit-teleport-1.stim"),
                ("+", "X", "circuit-teleport-plus.stim"),
                ("-", "X", "circuit-teleport-minus.stim")]
    allinfo = {}
    for state, basis, fname in variants:
        c, info = assemble(state, basis)
        with open(os.path.join(HERE, fname), "w", newline="\n") as f:
            f.write(header(state, basis))
            f.write(str(c) + "\n")
        allinfo[fname] = {"input_state": state, "l2_readout_basis": basis, **info}
        print(fname, "qubits", c.num_qubits, "meas", c.num_measurements,
              "dets", c.num_detectors, "obs", c.num_observables)
    allinfo["_layout"] = {
        "placement_offset_row_col": [DR, DC],
        "figure_to_chip": {f"{q[0]},{q[1]}": list(chip(q)) for q in sorted(all_fig_qubits())},
        "qubit_index_to_chip": [list(chip(q)) for q in QUBITS],
        "roles": {
            "L1_data": [list(chip(q)) for q in L1_DATA],
            "L2_data": [list(chip(q)) for q in L2_DATA],
            "interface_data": [list(chip(q)) for q in IF_DATA],
            "aux": {t: [list(chip(TILES[t][0])), list(chip(TILES[t][1]))] for t in
                    ["blue1", "red1", "green1", "hatL", "hatR", "red2", "green2", "blue2"]},
            "idle_in_init_and_split_cycles": [list(chip(q)) for q in INACTIVE_ROW4],
        },
    }
    with open(os.path.join(HERE, "teleport-records.json"), "w", newline="\n") as f:
        json.dump(allinfo, f, indent=1)


if __name__ == "__main__":
    main()
