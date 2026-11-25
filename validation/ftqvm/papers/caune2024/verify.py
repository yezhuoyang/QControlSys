"""Verification of the stability-8 circuits for Caune et al. (arXiv:2410.05202; Nat. Commun. 17, 7383 (2026)).

Run from anywhere:  python -I verify.py > verify.txt
Needs stim, pymatching, numpy. Reads (if present) the authors' Stim circuits extracted from Zenodo
(zenodo/extracted/*.stim, doi:10.5281/zenodo.13961129) and their LEP tables (zenodo/*.txt).

 1. Noiseless: 1000 shots, every detector and the observable are 0; counts (4 detectors per decoding
    round, decoding rounds = measurement rounds - 1).
 2. Equivalence with every published Zenodo circuit (12 LEP runs with 4..26 measurement rounds,
    8 fast-feedback runs with 2..9): same gate DAG (commuting reorderings and TICK placement ignored,
    the published files' two no-op gates after the final measurement dropped), same detector and
    observable measurement sets, identical detector error model under gate-local noise.
 3. detector_error_model(decompose_errors=True) under the paper's SI noise model at p = 0.03, no
    hyperedges, and the decoding-graph shape of SI Fig. S2.
 4. Logical error probability vs decoding rounds with PyMatching under (a) the SI model, p = 0.03,
    and (b) a device-informed model from the Methods numbers; compared (sanity only) with the
    measured 28.1 % (d = 5) -> 20.5 % (d = 25).
"""
import glob, math, os, re, sys
import numpy as np
import stim
import pymatching

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, 'tools'))
import gen_circuits as G  # noqa: E402

ALLQ = list(range(8))
ANC_STIM = {G.DEV_TO_STIM[q] for q in G.ANC}
SEED = 20241007
ONE_Q = ('SQRT_X', 'SQRT_X_DAG', 'S', 'S_DAG', 'H', 'X', 'Y', 'Z')


def load(d):
    return stim.Circuit.from_file(os.path.join(HERE, 'circuit-stability-r%d.stim' % d))


# ---------------------------------------------------------------------------------------------- noise
def layers(circ):
    out, cur = [], []
    for ins in circ.flattened():
        if ins.name == 'TICK':
            out.append(cur)
            cur = []
        else:
            cur.append(ins)
    out.append(cur)
    return out


def qubits(ins):
    return [t.value for t in ins.targets_copy() if t.is_qubit_target]


def add_noise_si(circ, p):
    """Noise model of the paper's SI Sec. B (quoted from Barber et al.), applied per TICK layer:
    DEPOLARIZE2(p) after each CZ; DEPOLARIZE1(p/10) after every single-qubit gate and measurement and
    on every qubit idle in a layer; "measurement flip with probability p" as a classical flip of the
    reported bit, M(p) -- not X_ERROR, which without resets would also flip the ancilla state."""
    out = stim.Circuit()
    for lay in layers(circ):
        touched = set()
        for ins in lay:
            tg = qubits(ins)
            if ins.name == 'M':
                out.append('M', tg, p)
                out.append('DEPOLARIZE1', tg, p / 10)
            else:
                out.append(ins)
                if ins.name == 'CZ':
                    out.append('DEPOLARIZE2', tg, p)
                elif ins.name in ONE_Q:
                    out.append('DEPOLARIZE1', tg, p / 10)
            touched.update(tg)
        if any(i.name in ('M', 'CZ') + ONE_Q for i in lay):
            idle = [q for q in ALLQ if q not in touched]
            if idle:
                out.append('DEPOLARIZE1', idle, p / 10)
        out.append('TICK')
    return out


def add_noise_gate_local(circ, p):
    """TICK-independent noise used to compare DEMs of circuits whose TICK placement differs."""
    out = stim.Circuit()
    for ins in circ.flattened():
        tg = qubits(ins) if ins.name not in ('DETECTOR', 'OBSERVABLE_INCLUDE', 'QUBIT_COORDS', 'TICK') else []
        if ins.name == 'M':
            out.append('M', tg, p)
            continue
        out.append(ins)
        if ins.name == 'CZ':
            out.append('DEPOLARIZE2', tg, p)
        elif ins.name in ONE_Q:
            out.append('DEPOLARIZE1', tg, p / 10)
    return out


# medians over the sublattice quoted in the arXiv v1 Methods
T1_US, T2_US = 13.2, 10.6
F1Q, FCZ, FRO = 0.9986, 0.973, 0.933


def idle_channel(t_ns):
    t = t_ns * 1e-3
    px = (1 - math.exp(-t / T1_US)) / 4
    pz = max(0.0, (1 - math.exp(-t / T2_US)) / 2 - px)
    return px, px, pz


def add_noise_device(circ):
    """Pauli-twirled, device-informed model: depolarising CZ / RX(pi/2) with the RB infidelities
    (p2 = 5/4 (1-F), p1 = 3/2 (1-F)), classical readout flip M(1-F_RO), and T1/T2 idling (twirled amplitude and
    phase damping) of every qubit not driven in a layer, for that layer's calibrated duration;
    measurement layers last 1312 ns (Q38: 976 ns pulse + 336 ns ring-down) for the idle data qubits,
    and each ancilla idles for its own ring-down after its readout."""
    p2, p1, pm = 1.25 * (1 - FCZ), 1.5 * (1 - F1Q), 1 - FRO
    out = stim.Circuit()
    for lay in layers(circ):
        touched, dur, has_m = set(), 0, False
        for ins in lay:
            tg = qubits(ins)
            if ins.name == 'M':
                has_m = True
                out.append('M', tg, pm)
            else:
                out.append(ins)
                if ins.name == 'CZ':
                    out.append('DEPOLARIZE2', tg, p2)
                    dur = max([dur] + [G.CZ_NS[frozenset((G.STIM_TO_DEV[tg[i]], G.STIM_TO_DEV[tg[i + 1]]))]
                                       for i in range(0, len(tg), 2)])
                elif ins.name in ONE_Q:
                    out.append('DEPOLARIZE1', tg, p1)
                    dur = max(dur, G.RX90_NS)
            touched.update(tg)
        if has_m:
            for q in ALLQ:
                if q in touched and q in ANC_STIM:
                    out.append('PAULI_CHANNEL_1', [q], idle_channel(G.RINGDOWN_NS[G.STIM_TO_DEV[q]]))
                elif q not in touched:
                    out.append('PAULI_CHANNEL_1', [q], idle_channel(1312))
        elif dur:
            idle = [q for q in ALLQ if q not in touched]
            if idle:
                out.append('PAULI_CHANNEL_1', idle, idle_channel(dur))
        out.append('TICK')
    return out


# ---------------------------------------------------------------------------------------------- helpers
def canonical(circ):
    """Gate DAG canonical form: every elementary operation gets its ASAP depth (1 + latest depth on
    any of its qubits); measurements keep their absolute record index. Detectors / observables become
    sets of absolute record indices. Non-measurement gates after the final measurement are dropped
    (the published files end with 'SQRT_X ...; S ...', which acts on no recorded bit)."""
    ops, dets, obs, nm = [], [], [], 0
    for ins in circ.flattened():
        n = ins.name
        if n in ('QUBIT_COORDS', 'TICK', 'SHIFT_COORDS'):
            continue
        if n == 'DETECTOR':
            dets.append(frozenset(nm + t.value for t in ins.targets_copy()))
            continue
        if n == 'OBSERVABLE_INCLUDE':
            obs.append(frozenset(nm + t.value for t in ins.targets_copy()))
            continue
        tg = qubits(ins)
        if n == 'CZ':
            for i in range(0, len(tg), 2):
                ops.append(('CZ', tuple(sorted(tg[i:i + 2])), None))
        elif n == 'M':
            for q in tg:
                ops.append(('M', (q,), nm))
                nm += 1
        else:
            for q in tg:
                ops.append((n, (q,), None))
    last_m = max(i for i, o in enumerate(ops) if o[0] == 'M')
    ops = ops[:last_m + 1]
    depth, canon = {}, []
    for name, qs, rec in ops:
        dep = 1 + max(depth.get(q, 0) for q in qs)
        for q in qs:
            depth[q] = dep
        canon.append((dep, name, qs, rec if rec is not None else -1))
    return sorted(canon), dets, obs


def lep(circ, shots, seed):
    dem = circ.detector_error_model(decompose_errors=True)
    m = pymatching.Matching.from_detector_error_model(dem)
    det, ob = circ.compile_detector_sampler(seed=seed).sample(shots, separate_observables=True)
    pred = m.decode_batch(det)
    p = float(np.mean(pred[:, 0] != ob[:, 0]))
    return p, math.sqrt(p * (1 - p) / shots), float(det.mean())


def read_table(fn):
    rows = {}
    if os.path.exists(fn):
        for line in open(fn):
            parts = line.split()
            if len(parts) == 3 and parts[0].isdigit():
                rows[int(parts[0])] = (float(parts[1]), float(parts[2]))
    return rows


# ---------------------------------------------------------------------------------------------- main
def main():
    ok = True
    print('stim', stim.__version__, '| pymatching', pymatching.__version__, '| numpy', np.__version__)
    print()
    print('== 1. Noiseless determinism (1000 shots) and counts ==')
    for d in (5, 9, 25):
        c = load(d)
        same_as_generator = str(c) == str(stim.Circuit(G.circuit(d + 1, 'lep')))
        det, ob = c.compile_detector_sampler(seed=SEED).sample(1000, separate_observables=True)
        c.detector_error_model()   # stim raises if a detector or the observable is not deterministic
        n = d + 1
        good = (not det.any()) and (not ob.any()) and c.num_detectors == 4 * d and \
            c.num_measurements == 4 * n + 4 and c.num_observables == 1 and same_as_generator
        ok &= good
        print('circuit-stability-r%-2d: measurement rounds n=%2d, qubits %d, measurements %3d (=4n+4), detectors %3d '
              '(=4d), observables %d; 1000 shots: %d detector bits set, %d observable bits set -> %s' % (
                  d, n, c.num_qubits, c.num_measurements, c.num_detectors, c.num_observables,
                  int(det.sum()), int(ob.sum()), 'PASS' if good else 'FAIL'))
    c = stim.Circuit.from_file(os.path.join(HERE, 'circuit-feedback-n9.stim'))
    det, ob = c.compile_detector_sampler(seed=SEED).sample(1000, separate_observables=True)
    good = not det.any() and not ob.any() and c.num_detectors == 32
    ok &= good
    print('circuit-feedback-n9    : measurement rounds n= 9, detectors %d (=4*8); 1000 shots all zero -> %s' % (
        c.num_detectors, 'PASS' if good else 'FAIL'))
    print('SI Fig. S2 caption "8 rounds of syndrome measurements (equivalent to 7 rounds of detectors)": '
          'n=8 gives %d detector layers' % (stim.Circuit(G.circuit(8)).num_detectors // 4))
    for fn in ('circuit-stability-r5.stim', 'circuit-feedback-n9.stim'):
        m = stim.Circuit.from_file(os.path.join(HERE, fn)).compile_sampler(seed=SEED).sample(1000)
        par = set((m[:, -4:].sum(1) % 2).tolist())
        print('%s: final data readout (Y basis) -- single bits random (means %s), 4-bit parity values %s '
              '(deterministic Y37Y43Y45Y51; unused by the paper\'s detectors/observable)' % (
                  fn, np.round(m[:, -4:].mean(0), 2).tolist(), sorted(par)))
    print()

    print('== 2. Equivalence with the authors\' Stim circuits on Zenodo ==')
    pub = sorted(glob.glob(os.path.join(HERE, 'zenodo', 'extracted', '*_meas*.stim')))
    if not pub:
        print('(zenodo/extracted/*.stim not found; run tools/extract_zenodo.py first) -- skipped')
    for fn in pub:
        base = os.path.basename(fn)
        n = int(re.search(r'meas(\d+)\.stim$', base).group(1))
        sched = 'feedback' if base.startswith('ff_') else 'lep'
        mine = stim.Circuit(G.circuit(n, sched))
        theirs = stim.Circuit.from_file(fn)
        a, b = canonical(mine), canonical(theirs)
        g, dt, ob_ = a[0] == b[0], a[1] == b[1], a[2] == b[2]
        da = add_noise_gate_local(mine, 0.01).detector_error_model(decompose_errors=True)
        db = add_noise_gate_local(theirs, 0.01).detector_error_model(decompose_errors=True)
        strip = lambda dm: sorted(l for l in str(dm.flattened()).split('\n') if not l.startswith('detector('))
        dm = strip(da) == strip(db)
        noiseless = not stim.Circuit(G.circuit(n, sched)).compile_detector_sampler(seed=1).sample(200).any()
        res = g and dt and ob_ and dm and noiseless
        ok &= res
        print('%-18s n=%2d d=%2d schedule=%-8s gate DAG %-5s detectors %-5s observable %-5s DEM %-5s -> %s' % (
            base, n, n - 1, sched, g, dt, ob_, dm, 'PASS' if res else 'FAIL'))
    print()

    print('== 3. Detector error models, SI noise model p = 0.03 ==')
    for d in (5, 9, 25):
        nc = add_noise_si(load(d), 0.03)
        dem = nc.detector_error_model(decompose_errors=True)
        raw = nc.detector_error_model(decompose_errors=False)
        maxdet = max(sum(1 for t in e.targets_copy() if t.is_relative_detector_id())
                     for e in raw.flattened() if e.type == 'error')
        ok &= maxdet <= 2
        print('r%-2d detector_error_model(decompose_errors=True): %d error mechanisms over %d detectors; '
              'largest undecomposed error touches %d detectors (paper: no hyperedges)' % (
                  d, dem.num_errors, dem.num_detectors, maxdet))
    nc = add_noise_si(stim.Circuit(G.circuit(8)), 0.03)       # SI Fig. S2: 8 measurement rounds
    dem = nc.detector_error_model(decompose_errors=True)
    layer = {k: int(v[2]) for k, v in dem.get_detector_coordinates().items()}
    bnd, spans = set(), set()
    for e in dem.flattened():
        if e.type != 'error':
            continue
        comp, comps = [], []
        for t in e.targets_copy():
            if t.is_separator():
                comps.append(comp)
                comp = []
            elif t.is_relative_detector_id():
                comp.append(t.val)
        comps.append(comp)
        for c_ in comps:
            if len(c_) == 1:
                bnd.add(layer[c_[0]])
            elif len(c_) == 2:
                spans.add(abs(layer[c_[0]] - layer[c_[1]]))
    good = dem.num_detectors == 28 and sorted(bnd) == [0, 1, 5, 6] and sorted(spans) == [0, 1, 2]
    ok &= good
    print('SI Fig. S2 graph (n=8): %d nodes (figure: 28 = 4 x 7); boundary edges attach to detector layers %s '
          '(figure: two bottom and two top layers are "boundary-adjacent"); edge time-spans %s '
          '(0 = space-like, 1 = time-like/diagonal hook, 2 = the no-reset edges "connecting layers two rounds apart") -> %s' % (
              dem.num_detectors, sorted(bnd), sorted(spans), 'PASS' if good else 'FAIL'))
    print()

    print('== 4. Logical error probability vs decoding rounds (PyMatching), sanity check only ==')
    fpga = read_table(os.path.join(HERE, 'zenodo', 'lep_fpga.txt'))
    mwpm = read_table(os.path.join(HERE, 'zenodo', 'lep_mwpm.txt'))
    # (c) SI model with p chosen so the simulated mean detector rate at d=25 equals the measured mean
    #     defect rate of the d=25 run (Zenodo defect_rates_per_round.txt: 25 rounds x 4 ancillas)
    measured = []
    fn = os.path.join(HERE, 'zenodo', 'defect_rates_per_round.txt')
    if os.path.exists(fn):
        for line in open(fn):
            parts = line.split()
            if len(parts) == 5 and parts[0].isdigit():
                measured += [float(x) for x in parts[1:]]
    target = float(np.mean(measured)) if measured else 0.32
    c25 = stim.Circuit(G.circuit(26))
    grid = [round(0.03 + 0.005 * i, 3) for i in range(15)]
    rates = {p: float(add_noise_si(c25, p).compile_detector_sampler(seed=SEED).sample(4000).mean()) for p in grid}
    p_fit = min(grid, key=lambda p: abs(rates[p] - target))
    print('measured mean defect rate, d=25 run (Zenodo, %d values): %.3f (range %.3f-%.3f, rising with round)' % (
        len(measured), target, min(measured or [0]), max(measured or [0])))
    print('SI-model p grid -> simulated mean detector rate at d=25: ' +
          ', '.join('%.3f:%.3f' % (p, rates[p]) for p in grid))
    print('p_fit = %.3f (closest detector rate %.3f)' % (p_fit, rates[p_fit]))
    shots = 20000
    print('%d shots per point (the paper used 1e5 repetitions per point). Cells: LEP +- s.e. (mean detector rate).' % shots)
    print(' d | (a) SI p=0.03             | (b) device-informed       | (c) SI p=p_fit=%.3f       | paper FPGA (Zenodo) | paper MWPM (Zenodo)' % p_fit)
    sim = {'si': {}, 'dev': {}, 'fit': {}}
    for d in range(5, 26, 2):
        c = stim.Circuit(G.circuit(d + 1))
        sim['si'][d] = lep(add_noise_si(c, 0.03), shots, SEED + d)
        sim['dev'][d] = lep(add_noise_device(c), shots, SEED + 1000 + d)
        sim['fit'][d] = lep(add_noise_si(c, p_fit), shots, SEED + 2000 + d)
        f, w = fpga.get(d), mwpm.get(d)
        print('%2d | %.4f +- %.4f (%.3f) | %.4f +- %.4f (%.3f) | %.4f +- %.4f (%.3f) | %s | %s' % (
            d, *sim['si'][d], *sim['dev'][d], *sim['fit'][d],
            '%.4f +- %.4f' % f if f else '        -        ', '%.4f +- %.4f' % w if w else '-'))
    print('paper text: (28.1 +- 0.1)% at 5 decoding rounds -> (20.5 +- 0.1)% at 25 (real-time FPGA decoder)')
    for k, lab in (('si', '(a) SI p=0.03'), ('dev', '(b) device-informed'), ('fit', '(c) SI p=%.3f' % p_fit)):
        print('simulation %-20s %5.1f%% -> %5.1f%%   (LEP falls with d: %s)' % (
            lab + ':', 100 * sim[k][5][0], 100 * sim[k][25][0], sim[k][25][0] < sim[k][5][0]))
    ok &= all(sim[k][25][0] < sim[k][5][0] for k in sim)
    print()
    print('OVERALL:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
