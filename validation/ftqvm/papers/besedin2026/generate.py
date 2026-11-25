"""Generate the Stim circuits for Besedin et al., Nat. Phys. 22, 189 (2026), arXiv:2501.04612.

Lattice split (X-type) of a distance-3 rotated surface code into two distance-3
bit-flip repetition codes on the 17-transmon ETH Zurich device.

Every gate below is read off the paper's gate-sequence figure (arXiv TeX source
figs/fig_3a.png, "Experimental sequence of the lattice-split operation", Methods),
whose Y-box shading encodes the rotation angle (legend: -pi/2, pi, +pi/2).
Stim names: Ry(+pi/2) = SQRT_Y, Ry(-pi/2) = SQRT_Y_DAG, Ry(pi) = Y
(convention Ry(t) = exp(-i t Y / 2); the paper does not state its sign convention).

Run:  python -I generate.py      (writes circuit*.stim next to this file)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- qubits
# Index order = row order of the paper's gate-sequence figure (Fig. 3a in TeX):
# Z1..Z4, D1..D9, X1..X4.
NAMES = ["Z1", "Z2", "Z3", "Z4",
         "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9",
         "X1", "X2", "X3", "X4"]
Q = {n: i for i, n in enumerate(NAMES)}

# Schematic coordinates of Fig. 1a / App. Fig. A (data on odd grid points,
# x to the right, y downward).
SCHEMATIC = {
    "D1": (1, 1), "D2": (3, 1), "D3": (5, 1),
    "D4": (1, 3), "D5": (3, 3), "D6": (5, 3),
    "D7": (1, 5), "D8": (3, 5), "D9": (5, 5),
    "X1": (4, 0), "X2": (2, 2), "Z3": (4, 2), "Z1": (0, 2),
    "Z2": (2, 4), "X3": (4, 4), "Z4": (6, 4), "X4": (2, 6),
}


def chip(n):
    """Chip-grid coordinate (column, row) of qubit n in the micrograph Fig. 1e.

    Read off the labelled false-colour photograph: the device grid is the
    schematic rotated by 45 degrees: col = (x - y)/2 + 2, row = (x + y)/2 - 1.
    One grid unit is about 1.8-1.85 mm (photo scale bar, see meta.json).
    """
    x, y = SCHEMATIC[n]
    return ((x - y) // 2 + 2, (x + y) // 2 - 1)


DATA = ["D%d" % i for i in range(1, 10)]
MID = ["D2", "D5", "D8"]                      # read out by the split
KEEP = [d for d in DATA if d not in MID]      # D1 D3 D4 D6 D7 D9
XANC = ["X1", "X2", "X3", "X4"]
ZANC = ["Z1", "Z2", "Z3", "Z4"]

STAB = {  # data support (Fig. A)
    "X1": ["D2", "D3"], "X2": ["D1", "D2", "D4", "D5"],
    "X3": ["D5", "D6", "D8", "D9"], "X4": ["D7", "D8"],
    "Z1": ["D1", "D4"], "Z2": ["D4", "D5", "D7", "D8"],
    "Z3": ["D2", "D3", "D5", "D6"], "Z4": ["D6", "D9"],
}

# CZ steps (time steps 2, 3, 5, 6 of the 8-step stabilizer sequence),
# read off fig_3a.png in left-to-right order.
X_CZ = [
    [("D1", "X2"), ("D5", "X3"), ("D7", "X4")],   # step 2
    [("D2", "X2"), ("D6", "X3"), ("D8", "X4")],   # step 3
    [("D3", "X1"), ("D5", "X2"), ("D9", "X3")],   # step 5
    [("D2", "X1"), ("D4", "X2"), ("D8", "X3")],   # step 6
]
Z_CZ = [
    [("Z2", "D4"), ("Z3", "D2"), ("Z4", "D6")],   # step 2
    [("Z1", "D1"), ("Z2", "D5"), ("Z3", "D3")],   # step 3
    [("Z1", "D4"), ("Z2", "D8"), ("Z3", "D6")],   # step 5
    [("Z2", "D7"), ("Z3", "D5"), ("Z4", "D9")],   # step 6
]
# sanity: CZ partners reproduce the stabilizer supports
for anc in XANC:
    assert sorted(d for s in X_CZ for d, a in s if a == anc) == sorted(STAB[anc])
for anc in ZANC:
    assert sorted(d for s in Z_CZ for a, d in s if a == anc) == sorted(STAB[anc])

M_PRE, N_POST = 3, 2   # m = 3 (X cycles = m + 1 = 4), n = 2 Z cycles after split

# Injected input states on D5 (App. arbstate / Fig. 4a): D1 D4 D6 D9 in |0>,
# D2 D3 D7 D8 in |+>, D5 in |psi>.  Preparation pulses are NOT given in the
# paper (only "single-qubit gates"); we use the minimal Ry/Rx pulse.
PREP = {  # stim gate(s) that map |0> to the state
    "0": [], "1": ["Y"], "+": ["SQRT_Y"], "-": ["SQRT_Y_DAG"],
    "+i": ["SQRT_X_DAG"], "-i": ["SQRT_X"],
}
INJ_NEIGHBORS = {"D1": "0", "D4": "0", "D6": "0", "D9": "0",
                 "D2": "+", "D3": "+", "D7": "+", "D8": "+"}

# Final readout basis per kept data qubit, chosen so that the logical
# two-qubit observable is measured (Z_L1 = Z_D4, X_L1 = X_D1 X_D4 X_D7,
# Y_L1 = X_D1 Y_D4 X_D7, and likewise D3 D6 D9 for L2).
def readout_bases(b1, b2):
    out = {}
    for (b, col) in ((b1, ["D1", "D4", "D7"]), (b2, ["D3", "D6", "D9"])):
        top, mid, bot = col
        if b == "Z":
            out.update({top: "Z", mid: "Z", bot: "Z"})
        elif b == "X":
            out.update({top: "X", mid: "X", bot: "X"})
        elif b == "Y":
            out.update({top: "X", mid: "Y", bot: "X"})
    return out


class Builder:
    def __init__(self):
        self.lines = []
        self.nmeas = 0
        self.rec = {}          # (label) -> absolute measurement index
        self.tick_no = 0

    def emit(self, s):
        self.lines.append(s)

    def tick(self, comment):
        self.emit("TICK")
        self.tick_no += 1
        self.emit("# --- layer %d: %s" % (self.tick_no, comment))

    def gate(self, name, qubits):
        if qubits:
            self.emit("%s %s" % (name, " ".join(str(Q[q]) for q in qubits)))

    def cz(self, pairs):
        self.emit("CZ " + " ".join("%d %d" % (Q[a], Q[b]) for a, b in pairs))

    def measure(self, basis, qubits, label):
        name = {"Z": "M", "X": "MX", "Y": "MY"}[basis]
        self.emit("%s %s" % (name, " ".join(str(Q[q]) for q in qubits)))
        for q in qubits:
            self.rec[(label, q)] = self.nmeas
            self.nmeas += 1

    def r(self, label, q):
        return "rec[%d]" % (self.rec[(label, q)] - self.nmeas)


def build(inject=None, bases=("Z", "Z")):
    """inject=None: logical |0>_L (all data in |0>), the Bell-state experiment.
    inject='0','1','+','-','+i','-i': state injection into D5 (Fig. 4a)."""
    b = Builder()
    e = b.emit
    e("# Besedin et al., 'Lattice surgery realized on two distance-three repetition codes")
    e("# with superconducting qubits', Nat. Phys. 22, 189-194 (2026), arXiv:2501.04612.")
    e("# Noiseless circuit generated by generate.py from the paper's gate-sequence figure.")
    e("# Input: %s.  Final readout of repetition codes L1 (D1 D4 D7) / L2 (D3 D6 D9): %s%s."
      % ("logical |0>_L (all data |0>)" if inject is None else "state injection, D5 = |%s>" % inject,
         bases[0], bases[1]))
    e("# Qubit map (index: paper name, schematic Fig.1a (x,y), chip grid Fig.1e (col,row)):")
    for n in NAMES:
        e("#   %2d: %-3s schematic %s chip %s" % (Q[n], n, SCHEMATIC[n], chip(n)))
    e("# QUBIT_COORDS use the chip grid of the micrograph Fig. 1e (1 unit ~ 1.8-1.85 mm).")
    e("# Single-qubit pulses: paper 'Y rotation' -pi/2 -> SQRT_Y_DAG, pi -> Y, +pi/2 -> SQRT_Y.")
    e("# No reset after readout (paper): ancillas are never reset; detectors compare a")
    e("# check's raw outcome with the one two same-type rounds earlier (m_k xor m_k-2).")
    for n in NAMES:
        c = chip(n)
        e("QUBIT_COORDS(%d, %d) %d" % (c[0], c[1], Q[n]))

    e("# --- layer 0: initialisation (ground state; hardware: passive, heralded by preselection)")
    b.gate("R", NAMES)
    b.tick("preselection readout of all 17 qubits (Fig. 3a 'Presel.'; runs with any 1 are discarded)")
    b.measure("Z", NAMES, "pre")
    b.tick("state-preparation slot (Fig. 3a empty boxes)%s" %
           ("; no pulses for |0>_L" if inject is None else ""))
    if inject is not None:
        groups = {}
        for d, s in list(INJ_NEIGHBORS.items()) + [("D5", inject)]:
            for k, g in enumerate(PREP[s]):
                groups.setdefault((k, g), []).append(d)
        for (k, g), qs in sorted(groups.items()):
            b.gate(g, sorted(qs, key=Q.get))

    def x_cycle(r, extra_meas=None):
        b.tick("X cycle %d step 1: Ry(-pi/2) data, Ry(+pi/2) X ancillas%s" %
               (r, "; pipelined readout of Z ancillas (Z cycle %d)" % (r - 1) if extra_meas else ""))
        b.gate("SQRT_Y_DAG", DATA)
        b.gate("SQRT_Y", XANC)
        if extra_meas:
            extra_meas()
        for k, pairs in zip((2, 3), X_CZ[:2]):
            b.tick("X cycle %d step %d: CZ" % (r, k))
            b.cz(pairs)
        b.tick("X cycle %d step 4: Ry(pi) echo on data" % r)
        b.gate("Y", DATA)
        for k, pairs in zip((5, 6), X_CZ[2:]):
            b.tick("X cycle %d step %d: CZ" % (r, k))
            b.cz(pairs)
        b.tick("X cycle %d step 7: Ry(-pi/2) data and X ancillas" % r)
        b.gate("SQRT_Y_DAG", DATA + XANC)

    def z_cycle(r, active, extra_meas=None):
        b.tick("Z cycle %d step 1: Ry(+pi/2) Z ancillas%s" %
               (r, "; pipelined readout of X ancillas (X cycle %d)" % r if extra_meas else ""))
        b.gate("SQRT_Y", ZANC)
        if extra_meas:
            extra_meas()
        for k, pairs in zip((2, 3, 5, 6), Z_CZ):
            if k == 5:
                b.tick("Z cycle %d step 4: Ry(pi) echo on active data" % r)
                b.gate("Y", active)
            p = [(a, d) for a, d in pairs if d in active]
            b.tick("Z cycle %d step %d: CZ" % (r, k))
            b.cz(p)
        b.tick("Z cycle %d step 7: Ry(-pi/2) Z ancillas" % r)
        b.gate("SQRT_Y_DAG", ZANC)

    def meas_anc(kind, r):
        anc = XANC if kind == "X" else ZANC
        return lambda: b.measure("Z", anc, "%s%d" % (kind, r))

    det_lines = []

    def detector(label, targets, coord):
        e("DETECTOR(%s) %s  # %s" % (", ".join(str(c) for c in coord), " ".join(targets), label))

    def anc_dets(kind, r, t, extra=None):
        anc = XANC if kind == "X" else ZANC
        for a in anc:
            if kind == "X" and r == 1:
                # first X round only deterministic for weight-2 X checks when injecting
                if inject is None or a not in ("X1", "X4"):
                    continue
            if kind == "Z" and r == 1 and inject is not None and a in ("Z2", "Z3"):
                continue
            tg = [b.r("%s%d" % (kind, r), a)]
            if r >= 3:
                tg.append(b.r("%s%d" % (kind, r - 2), a))
            # r = 1, 2: the partner is the preselection outcome, postselected to 0.
            if extra and a in extra:
                tg += [b.r("mid", d) for d in extra[a]]
            x, y = chip(a)
            detector("sigma %s round %d" % (a, r), tg, (x, y, t, 0 if kind == "Z" else 1))

    # ---- before the split: X1, (Z1, X2), (Z2, X3), (Z3, X4)
    x_cycle(1)
    for r in range(1, M_PRE + 1):
        z_cycle(r, DATA, extra_meas=meas_anc("X", r))
        anc_dets("X", r, 2 * r - 2)
        x_cycle(r + 1, extra_meas=meas_anc("Z", r))
        anc_dets("Z", r, 2 * r - 1)
    rX = M_PRE + 1
    b.tick("split: readout of X ancillas (X cycle %d) and middle-column data D2 D5 D8 in Z" % rX)
    b.measure("Z", XANC, "X%d" % rX)
    b.measure("Z", MID, "mid")
    anc_dets("X", rX, 2 * rX - 2)

    # ---- after the split: n = 2 Z cycles of the two repetition codes
    split_extra = {"Z2": ["D5", "D8"], "Z3": ["D2", "D5"]}  # App. A, modified syndromes
    rb = readout_bases(*bases)
    last = M_PRE + N_POST
    for r in range(M_PRE + 1, last + 1):
        z_cycle(r, KEEP)
        if r < last:
            b.tick("Z cycle %d step 8: readout of Z ancillas" % r)
            b.measure("Z", ZANC, "Z%d" % r)
        else:
            b.tick("Z cycle %d step 8: readout of Z ancillas, in parallel final data readout (%s%s)"
                   % (r, bases[0], bases[1]))
            b.measure("Z", ZANC, "Z%d" % r)
            for basis in ("Z", "X", "Y"):
                qs = [d for d in KEEP if rb[d] == basis]
                if qs:
                    b.measure(basis, qs, "fin")
        anc_dets("Z", r, 2 * r - 1, extra=split_extra if r == M_PRE + 1 else None)

    # ---- final syndromes from the data readout (only where data were read in Z)
    for a, sup in (("Z1", ["D1", "D4"]), ("Z2", ["D4", "D7"]),
                   ("Z3", ["D3", "D6"]), ("Z4", ["D6", "D9"])):
        if all(rb[d] == "Z" for d in sup):
            tg = [b.r("fin", d) for d in sup] + [b.r("Z%d" % last, a), b.r("Z%d" % (last - 1), a)]
            x, y = chip(a)
            detector("sigma %s final (data readout)" % a, tg, (x, y, 2 * last, 0))

    # ---- logical observables with the paper's Pauli-frame update (Eq. PauliFrameUpdate):
    # X_L1 -> X_L1 s^X2_4 s^X4_4, X_L2 -> X_L2 s^X1_4 s^X3_4, Z_L1 = Z_D4, Z_L2 = Z_D6 z_D5,
    # with s^Xi_4 = m^Xi_4 xor m^Xi_3 (no reset).
    def frame_x(anc):
        return sum(([b.r("X%d" % rX, a), b.r("X%d" % (rX - 1), a)] for a in anc), [])

    def logical(which, basis):
        col = ["D1", "D4", "D7"] if which == 1 else ["D3", "D6", "D9"]
        if basis == "Z":
            t = [b.r("fin", col[1])]
            if which == 2:
                t.append(b.r("mid", "D5"))
            return t
        t = [b.r("fin", d) for d in col]
        t += frame_x(["X2", "X4"] if which == 1 else ["X1", "X3"])
        if basis == "Y" and which == 2:
            t.append(b.r("mid", "D5"))
        return t

    obs = []
    if inject in ("+", "-") and bases == ("X", "X"):
        obs = [("X_L1", logical(1, "X")), ("X_L2", logical(2, "X"))]
    else:
        obs = [("%s_L1 %s_L2" % bases, logical(1, bases[0]) + logical(2, bases[1]))]
    for k, (lab, tg) in enumerate(obs):
        # cancel duplicate record targets (xor)
        cnt = {}
        for t in tg:
            cnt[t] = cnt.get(t, 0) ^ 1
        tg = [t for t in tg if cnt[t]]
        e("OBSERVABLE_INCLUDE(%d) %s  # %s (Pauli-frame updated)" % (k, " ".join(tg), lab))
    return "\n".join(b.lines) + "\n", obs


VARIANTS = {
    # main experiment: logical Bell state from |0>_L (Fig. 3 / published Fig. 2)
    "circuit.stim": dict(inject=None, bases=("Z", "Z")),
    "circuit-bell-XX.stim": dict(inject=None, bases=("X", "X")),
    "circuit-bell-YY.stim": dict(inject=None, bases=("Y", "Y")),
    # state-injection inputs (Fig. 4 / Fig. 5 process tomography), cardinal states only
    "circuit-inject-0-ZZ.stim": dict(inject="0", bases=("Z", "Z")),
    "circuit-inject-1-ZZ.stim": dict(inject="1", bases=("Z", "Z")),
    "circuit-inject-plus-XX.stim": dict(inject="+", bases=("X", "X")),
    "circuit-inject-minus-XX.stim": dict(inject="-", bases=("X", "X")),
    "circuit-inject-plusi-YZ.stim": dict(inject="+i", bases=("Y", "Z")),
    "circuit-inject-minusi-YZ.stim": dict(inject="-i", bases=("Y", "Z")),
}

if __name__ == "__main__":
    for fn, kw in VARIANTS.items():
        txt, _ = build(**kw)
        with open(os.path.join(HERE, fn), "w", newline="\n") as f:
            f.write(txt)
        print("wrote", fn)
