"""Generator for the Bluvstein et al. (arXiv:2506.20661) CZ-based XZZX rotated-surface-code
stabilizer-measurement template, extracted from the authors' own Stim file
(anc/Stim_circuit_repeated_QEC_Xbasis.txt) and their raw AWG command strings.

Why a generator: the paper publishes only ONE Stim circuit (d=5, 4 rounds, X basis).  The
lattice-surgery circuit (Fig. 3) is not published.  We therefore (1) encode the rules of the
published circuit, (2) prove in verify.py that for R=C=5 the generator reproduces the published
circuit instruction-for-instruction (noiseless AND noisy), and (3) apply the same rules to the
5x10 merged lattice of the lattice-surgery experiment.

Lattice conventions (all inferred from the published CZ layers, see verify.txt):
  data (r, c), r = row 0..R-1, c = column 0..C-1
  ancilla at plaquette centre (ra, ca), half-integers; CSS type X if (ra - ca) is even, else Z
  boundaries: left/right edges carry weight-2 X-type checks, top/bottom edges weight-2 Z-type
  (so X_L is a row, Z_L is a column; merging along a vertical edge measures Z_L1 Z_L2).
  CZ layers (hardware AOD shifts of the whole ancilla grid, Moving-AWG SHIFT[[dx],[dy]] in SLM units):
    a: partner (ra+.5, ca-.5)   SHIFT[[-1.5],[+1]]
    b: partner (ra-.5, ca-.5)   SHIFT[[-1.5],[-1]]
    c: partner (ra+.5, ca+.5)   SHIFT[[+0.78],[+1]]   (0.75 in round 1)
    d: partner (ra-.5, ca+.5)   SHIFT[[+0.78],[-1]]
  Round orders used in the paper ("N Z Z_r N_r", ED Fig. 6d): abcd, acbd, dbca, dcba.
  Data in layer positions 1 and 4 are in the Z frame, positions 2 and 3 in the X frame
  (SQRT_Y on all data after the 1st and 3rd CZ layer, global Y echo between 2nd and 3rd).
"""
import math
import stim

LAYER_OFFSETS = {'a': (+0.5, -0.5), 'b': (-0.5, -0.5), 'c': (+0.5, +0.5), 'd': (-0.5, +0.5)}
PAPER_ORDERS = ['abcd', 'acbd', 'dbca', 'dcba']

# Error model of anc/Error_model.docx (Pauli part only; Stim cannot express loss).
EM = dict(
    idle_data=(0.1e-6, 0.1e-6, 0.5e-6),      # per microsecond
    idle_anc=(0.5e-6, 0.5e-6, 1e-6),         # per microsecond
    ent_zone=(5e-5, 5e-5, 10e-4),
    cz=(5e-5, 5e-5, 5e-4, 5e-5, 0, 0, 0, 5e-5, 0, 0, 0, 5e-4, 0, 0, 10e-4),
    sq=(0.2e-3, 0.6e-3, 0.2e-3),
    reset=3e-3, meas=5e-3,
)
# Idle durations used in the published Stim file (microseconds); see verify.txt for the derivation:
IDLE_GAP_HALF = 235.0      # half of the 0.47 ms between CZ layers
IDLE_EXCHANGE_HALF = 1285.0  # half of the 2.57 ms ancilla-block exchange


def _idle_p(rates, t):
    return tuple(1 - (1 - r) ** t for r in rates)


def _even(x):
    return abs(round(x) % 2) == 0


class Patch:
    def __init__(self, R, C, index_map=None):
        self.R, self.C = R, C
        self.data = [(r, c) for r in range(R) for c in range(C)]
        anc = []
        for i in range(-1, R):
            for j in range(-1, C):
                ra, ca = i + 0.5, j + 0.5
                typ = 'X' if _even(ra - ca) else 'Z'
                top, bot = ra < 0, ra > R - 1
                left, right = ca < 0, ca > C - 1
                if (top or bot) and (left or right):
                    continue
                if (top or bot) and typ != 'Z':
                    continue
                if (left or right) and typ != 'X':
                    continue
                anc.append((ra, ca, typ))
        self.anc = anc
        dset = set(self.data)
        self.partners = {}
        for (ra, ca, typ) in anc:
            p = {}
            for L, (dr, dc) in LAYER_OFFSETS.items():
                q = (int(ra + dr), int(ca + dc))
                if q in dset:
                    p[L] = q
            self.partners[(ra, ca)] = p
        if index_map is None:
            # compact numbering: data row-major 0..R*C-1, then ancillas row-major
            self.idx = {}
            for (r, c) in self.data:
                self.idx[(r, c)] = r * C + c
            for k, (ra, ca, _) in enumerate(anc):
                self.idx[(ra, ca)] = R * C + k
        else:
            self.idx = dict(index_map)
        self.dq = sorted(self.idx[d] for d in self.data)
        self.aq = sorted(self.idx[(a[0], a[1])] for a in anc)
        self.type_of = {self.idx[(a[0], a[1])]: a[2] for a in anc}
        self.key_of = {v: k for k, v in self.idx.items()}

    def sublattice(self, which):
        """A = (r+c) even (gets SQRT_Y_DAG for X-basis prep/measure in the paper), B = odd."""
        return [self.idx[(r, c)] for (r, c) in self.data if ((r + c) % 2 == 0) == (which == 'A')]


def published_index_map():
    """Qubit numbering of the published 5x5 file (inferred from its CZ layers)."""
    m = {}
    for r in range(5):
        for c in range(5):
            m[(r, c)] = 10 * r + c + 2
    rows = {-0.5: [0.5, 2.5], 0.5: [0.5, 1.5, 2.5, 3.5, 4.5], 1.5: [-0.5, 0.5, 1.5, 2.5, 3.5],
            2.5: [0.5, 1.5, 2.5, 3.5, 4.5], 3.5: [-0.5, 0.5, 1.5, 2.5, 3.5], 4.5: [1.5, 3.5]}
    base = {-0.5: 0, 0.5: 7, 1.5: 17, 2.5: 27, 3.5: 37, 4.5: 47}
    for ra, cas in rows.items():
        for k, ca in enumerate(cas):
            m[(ra, ca)] = base[ra] + k
    return m


def build(patch, rounds, prep='X', meas='X', orders=None, noise=False, coords=False,
          observables=(), surgery_seam_obs=None, tick_layers=False, markers=True,
          skip_final_detectors=(), inject_anc_meas_error=0.0):
    """Return a stim.Circuit following the published template.

    observables: list of lists of data (r,c) whose final measurement parity is included.
    surgery_seam_obs: (obs_index, [ancilla keys]) -> include round-1 records of these ancillas.
    skip_final_detectors: ancilla keys (ra, ca) whose final data-qubit detector is omitted (the paper
                 omits the seam checks from the final data measurement in its lattice-surgery decoding).
    inject_anc_meas_error: extra X_ERROR(p) before every ancilla M (Fig. 3c "injected in post-processing").
    markers: emit the no-op 'I' idle markers exactly where the published file has them.
    tick_layers: if True, add a TICK after every CZ layer (finer moments for display); the
                 default False reproduces the published TICK structure exactly.
    """
    P = patch
    orders = orders or PAPER_ORDERS[:rounds]
    dq, aq = P.dq, P.aq
    allq = dq + aq
    sub_prep = P.sublattice('A' if prep == 'X' else 'B')
    sub_meas = P.sublattice('A' if meas == 'X' else 'B')
    c = stim.Circuit()
    if coords:
        for k, q in sorted(P.idx.items(), key=lambda kv: kv[1]):
            r, cc = k[0], k[1]
            c.append('QUBIT_COORDS', [q], [cc, r])

    def sq(name, qs):
        if not qs:
            return
        c.append(name, qs)
        if noise:
            c.append('PAULI_CHANNEL_1', qs, EM['sq'])

    def idle(t):
        if noise:
            c.append('PAULI_CHANNEL_1', dq, _idle_p(EM['idle_data'], t))
            c.append('PAULI_CHANNEL_1', aq, _idle_p(EM['idle_anc'], t))
        if markers:
            c.append('I', allq)

    def marker(qs):
        if markers:
            c.append('I', qs)

    # --- transversal data preparation
    c.append('R', dq)
    if noise:
        c.append('X_ERROR', dq, EM['reset'])
    marker(dq)
    sq('SQRT_Y_DAG', sub_prep)
    c.append('TICK')

    meas_index = {}   # (round, ancilla q) -> absolute measurement index
    nmeas = 0
    for k in range(rounds):
        order = orders[k]
        pos = {L: i for i, L in enumerate(order)}
        early, late = [], []
        for (ra, ca, typ) in P.anc:
            q = P.idx[(ra, ca)]
            ls = sorted(pos[L] for L in P.partners[(ra, ca)])
            if ls == [0, 1]:
                early.append(q)
            elif ls == [2, 3]:
                late.append(q)
        early.sort(); late.sort()
        idle(IDLE_EXCHANGE_HALF)
        c.append('R', aq)
        if noise:
            c.append('X_ERROR', aq, EM['reset'])
        marker(aq)
        sq('SQRT_Y', [q for q in aq if q not in late])
        for li, L in enumerate(order):
            idle(IDLE_GAP_HALF)
            pairs, busy = [], set()
            for (ra, ca, typ) in P.anc:
                if L in P.partners[(ra, ca)]:
                    a = P.idx[(ra, ca)]
                    d = P.idx[P.partners[(ra, ca)][L]]
                    pairs += [d, a] if typ == 'Z' else [a, d]
                    busy |= {a, d}
            c.append('CZ', pairs)
            if noise:
                c.append('PAULI_CHANNEL_2', pairs, EM['cz'])
                c.append('PAULI_CHANNEL_1', [q for q in allq if q not in busy], EM['ent_zone'])
            if markers:
                c.append('I', sorted(allq))
            if tick_layers:
                c.append('TICK')
            idle(IDLE_GAP_HALF)
            if li == 0:
                sq('SQRT_Y', dq)
                sq('Y', early)
            elif li == 1:
                sq('SQRT_Y', early)
                sq('Y', allq)
                sq('SQRT_Y', late)
            elif li == 2:
                sq('SQRT_Y', dq)
                sq('Y', late)
            else:
                sq('SQRT_Y', [q for q in aq if q not in early])
        idle(IDLE_EXCHANGE_HALF)
        sq('Y', allq)
        if noise:
            c.append('X_ERROR', aq, EM['meas'])
        if inject_anc_meas_error:
            c.append('X_ERROR', aq, inject_anc_meas_error)
        marker(aq)
        c.append('M', aq)
        for q in aq:
            meas_index[(k, q)] = nmeas
            nmeas += 1
        # detectors
        for q in aq:
            t = P.type_of[q]
            ra, ca = P.key_of[q]
            dc = [ca, ra, k] if coords else []
            if k == 0:
                if t == prep:
                    c.append('DETECTOR', [stim.target_rec(meas_index[(0, q)] - nmeas)], dc)
            else:
                c.append('DETECTOR', [stim.target_rec(meas_index[(k, q)] - nmeas),
                                      stim.target_rec(meas_index[(k - 1, q)] - nmeas)], dc)
        c.append('TICK')
        if k < rounds - 1:
            c.append('TICK')
    # --- final transversal data measurement
    sq('SQRT_Y_DAG', sub_meas)
    if noise:
        c.append('X_ERROR', dq, EM['meas'])
    marker(dq)
    c.append('M', dq)
    data_meas = {}
    for q in dq:
        data_meas[q] = nmeas
        nmeas += 1
    for q in aq:
        if P.type_of[q] != meas:
            continue
        ra, ca = P.key_of[q]
        if (ra, ca) in skip_final_detectors:
            continue
        recs = [meas_index[(rounds - 1, q)]] + [data_meas[P.idx[d]] for d in P.partners[(ra, ca)].values()]
        c.append('DETECTOR', [stim.target_rec(m - nmeas) for m in recs],
                 [ca, ra, rounds] if coords else [])
    for oi, dl in enumerate(observables):
        recs = [data_meas[P.idx[d]] for d in dl]
        if surgery_seam_obs is not None and surgery_seam_obs[0] == oi:
            recs += [meas_index[(0, P.idx[a])] for a in surgery_seam_obs[1]]
        c.append('OBSERVABLE_INCLUDE', [stim.target_rec(m - nmeas) for m in sorted(recs)], oi)
    return c


def strip_noise(circ_text):
    """Remove noise channels (lines) from a Stim program, keeping every other line verbatim."""
    noise_ops = ('PAULI_CHANNEL_1', 'PAULI_CHANNEL_2', 'X_ERROR', 'Y_ERROR', 'Z_ERROR',
                 'DEPOLARIZE1', 'DEPOLARIZE2', 'HERALDED_ERASE', 'E(', 'ELSE_CORRELATED_ERROR')
    out = [ln for ln in circ_text.splitlines() if not ln.strip().startswith(noise_ops)]
    return '\n'.join(out) + '\n'
