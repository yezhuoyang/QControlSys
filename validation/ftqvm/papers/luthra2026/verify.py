"""Verify the Stim translations of the Luthra & Owens (arXiv:2610.39067) H2-2 programs.

Run:  python -I verify.py <this directory>      (writes verify.txt there)
Needs: stim, pymatching, numpy. Tesseract (the paper's decoder) is not installed here, so
decoded numbers use PyMatching and a sampled lookup-table decoder as a sanity check only.
"""
import json, math, os, re, sys, time
import numpy as np
import stim, pymatching

ROOT = sys.argv[1]
OUT = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s); OUT.append(s)


def jeffreys(k, n):
    # 95% equal-tailed Jeffreys interval via a Beta quantile by bisection on the regularised
    # incomplete beta function (numerical integration; adequate for reporting).
    a, b = k + 0.5, n - k + 0.5
    xs = np.linspace(0, 1, 200001)[1:-1]
    logpdf = (a - 1) * np.log(xs) + (b - 1) * np.log1p(-xs)
    pdf = np.exp(logpdf - logpdf.max()); cdf = np.cumsum(pdf); cdf /= cdf[-1]
    return xs[np.searchsorted(cdf, 0.025)], xs[np.searchsorted(cdf, 0.975)]


def pct(k, n):
    lo, hi = jeffreys(k, n)
    return '%d/%d = %.2f%% [%.2f, %.2f]' % (k, n, 100 * k / n, 100 * lo, 100 * hi)


layouts = json.load(open(os.path.join(ROOT, 'layout.json')))

# ---------------------------------------------------------------- 1. gate map
log('== 1. QIR gate -> Stim gate map (equal up to global phase)')
I2 = np.eye(2); X = np.array([[0, 1], [1, 0]]); Z = np.diag([1, -1])
def rz(t): return np.diag([np.exp(-1j * t / 2), np.exp(1j * t / 2)])
def rx(t): return math.cos(t / 2) * I2 - 1j * math.sin(t / 2) * X
def rzz(t): return np.diag(np.exp(-1j * t / 2 * np.array([1, -1, -1, 1])))
def same_up_to_phase(U, V):
    k = np.argmax(abs(V.flatten())); ph = U.flatten()[k] / V.flatten()[k]
    return abs(abs(ph) - 1) < 1e-6 and np.allclose(U, ph * V, atol=1e-6)  # stim returns complex64
GATE = {('rz', 1): 'S', ('rz', 2): 'Z', ('rz', 3): 'S_DAG', ('rx', 1): 'SQRT_X', ('rx', 2): 'X',
        ('rx', 3): 'SQRT_X_DAG', ('rzz', 1): 'SQRT_ZZ', ('rzz', 3): 'SQRT_ZZ_DAG'}
for (g, k), sg in GATE.items():
    U = {'rz': rz, 'rx': rx, 'rzz': rzz}[g](k * math.pi / 2)
    V = stim.Tableau.from_named_gate(sg).to_unitary_matrix(endian='big')
    ok = same_up_to_phase(U, V)
    log('  %s(%d*pi/2) == %s : %s' % (g, k, sg, ok))
    assert ok

# ---------------------------------------------------------------- 2. program fidelity
log('\n== 2. Stim files reproduce the submitted QIR instruction sequence exactly')
QB = re.compile(r'inttoptr \(i64 (\d+) to %Qubit\*\)')
def qir_sequence(path):
    seq = []
    for line in open(path, encoding='utf-8'):
        m = re.search(r'@__quantum__qis__(\w+)__body\((.*)\)', line)
        if not m or line.lstrip().startswith('declare'):
            continue
        n, args = m.groups(); qs = tuple(int(x) for x in QB.findall(args))
        if n in ('rz', 'rx', 'rzz'):
            t = float(re.match(r'double ([-0-9.eE+]+)', args).group(1))
            seq.append((GATE[(n, round(t / (math.pi / 2)) % 4)], qs))
        else:
            seq.append(({'reset': 'R', 'm': 'M'}[n], qs))
    return seq
def stim_sequence(path):
    seq = []
    for line in open(path):
        line = line.split('#')[0].strip()
        if not line or line == 'TICK' or line.startswith(('DETECTOR', 'OBSERVABLE', 'QUBIT_COORDS')):
            continue
        g, *ts = line.split()
        seq.append((g, tuple(int(t) for t in ts)))
    return seq
for name, lay in layouts.items():
    a = qir_sequence(os.path.join(ROOT, 'data', lay['input'])); b = stim_sequence(os.path.join(ROOT, 'circuit-%s.stim' % name))
    c = stim.Circuit.from_file(os.path.join(ROOT, 'circuit-%s.stim' % name))
    log('  %-15s QIR instr %4d  stim instr %4d  identical=%s  qubits=%d meas=%d ticks=%d dets=%d obs=%d'
        % (name, len(a), len(b), a == b, c.num_qubits, c.num_measurements, c.num_ticks, c.num_detectors, c.num_observables))
    assert a == b

# ---------------------------------------------------------------- 3. code / gadget structure
log('\n== 3. Code and gadget structure read off the program (qubit q_i = program qubit 5+i)')
def neighbours(path):
    nb = {}
    for g, qs in qir_sequence(path):
        if g == 'SQRT_ZZ':
            nb.setdefault(qs[0], set()).add(qs[1]); nb.setdefault(qs[1], set()).add(qs[0])
    return nb
nb = neighbours(os.path.join(ROOT, 'data', layouts['XR1']['input']))
dq = lambda s: sorted(q - 5 for q in s if 5 <= q < 15)
l = 5
A = [[(r + e) % l for e in (0, 2)] for r in range(l)]; B = [[(r + e) % l for e in (0, 1)] for r in range(l)]
HX = [sorted(A[j] + [5 + c for c in B[j]]) for j in range(l)]
HZ = [sorted([c for c in range(l) if j in B[c]] + [5 + c for c in range(l) if j in A[c]]) for j in range(l)]
for j in range(5):
    log('  S_X%d ancilla %2d -> data %s  (GB l=5 a=1+x^2 b=1+x: %s)  S_Z%d ancilla %2d -> data %s  (%s)'
        % (j, j, dq(nb[j]), HX[j], j, 15 + j, dq(nb[15 + j]), HZ[j]))
    assert dq(nb[j]) == HX[j] and dq(nb[15 + j]) == HZ[j]
def vec(s):
    v = np.zeros(10, int); v[s] = 1; return v
HXm = np.array([vec(r) for r in HX]); HZm = np.array([vec(r) for r in HZ])
assert not (HXm @ HZm.T % 2).any()
L = {'X1': [2, 3, 7], 'X2': [1, 7, 9], 'Z1': [2, 4, 5], 'Z2': [2, 6, 7]}
log('  rank H_X = rank H_Z = 4 -> k = 10 - 8 = 2;  logicals (paper Eq. 2-5):')
for a_ in ('X1', 'X2'):
    assert not (HZm @ vec(L[a_]) % 2).any()
    log('    %s=%s commutes with all Z checks; overlaps with Z1,Z2: %s' % (a_, L[a_], [int(vec(L[a_]) @ vec(L[z]) % 2) for z in ('Z1', 'Z2')]))
for z in ('Z1', 'Z2'):
    assert not (HXm @ vec(L[z]) % 2).any()
gad = {q: sorted(nb[q]) for q in range(20, 27)}
log('  X1 gadget couplings in XR1: kappa(20,21,22) %s ; gamma(23) %s ; chi(24,25,26) %s'
    % ([gad[q] for q in (20, 21, 22)], gad[23], [gad[q] for q in (24, 25, 26)]))
assert gad[24] == [7, 20, 21] and gad[25] == [8, 21, 22] and gad[26] == [12, 20, 22]  # chi_2 = q2 k2 k3 ; chi_3 = q3 k3 k4 ; chi_7 = q7 k2 k4
assert sorted(nb[17] - set(range(5, 15))) == [20] and sorted(nb[18] - set(range(5, 15))) == [21] and sorted(nb[19] - set(range(5, 15))) == [22]
nbs = neighbours(os.path.join(ROOT, 'data', layouts['SEQ']['input']))
log('  Z2 gadget couplings in SEQ (second use of 20..26): nu(20,21,22)->X-check ancillas %s ; eta(24,25,26)->data %s (union over the chi and eta uses)'
    % ([sorted(nbs[q] & set(range(5))) for q in (20, 21, 22)], [dq(nbs[q]) for q in (24, 25, 26)]))

# ---------------------------------------------------------------- 4. noiseless
log('\n== 4. Noiseless: 1000 shots, every detector and observable must be 0 (relative to the reference sample)')
ref_obs = {}
for name in layouts:
    c = stim.Circuit.from_file(os.path.join(ROOT, 'circuit-%s.stim' % name))
    d, o = c.compile_detector_sampler(seed=1).sample(1000, separate_observables=True)
    ref = c.reference_sample()
    lay = layouts[name]
    vals = [int(sum(ref[lay['output_position_to_record'][p]] for p in ob['output_positions']) % 2) for ob in lay['observables']]
    ref_obs[name] = vals
    c.detector_error_model()  # raises if any detector/observable is non-deterministic
    log('  %-15s detector 1s: %d  observable 1s: %d  ideal observable values %s  (%s)'
        % (name, d.sum(), o.sum(), vals, '; '.join(ob['label'].split(' =')[0] for ob in lay['observables'])))
    assert d.sum() == 0 and o.sum() == 0

# ---------------------------------------------------------------- 5. noise model, DEM, decoding
P = dict(reset=9.4e-4 / 2, meas=9.4e-4 / 2, p1=3.4e-5, p2=1.0e-3, idle=1.2e-4 / 7)
log('\n== 5. Detector error model with the rates of the paper\'s error-model table (tab:error-model, App. C) %s' % P)
log('   model: X_ERROR after R and before M; DEPOLARIZE1 after rx-type gates (rz is virtual on H2);')
log('   DEPOLARIZE2 after SQRT_ZZ; Z_ERROR(idle * ceil(n2q/4)) on every qubit per TICK containing n2q>0 2Q gates')
log('   (stands in for the paper\'s "per 2Q depth" idle with greedy packing into 4 gate zones).')
def noisy(c):
    out = stim.Circuit(); nq = c.num_qubits; layer = []
    def flush():
        n2 = sum(1 for g in layer if g == 'SQRT_ZZ')
        if n2:
            out.append('Z_ERROR', range(nq), P['idle'] * math.ceil(n2 / 4))
    for ins in c:
        if ins.name == 'TICK':
            flush(); layer.clear(); out.append(ins); continue
        if ins.name == 'M':
            out.append('X_ERROR', ins.targets_copy(), P['meas'])
        out.append(ins)
        layer.append(ins.name)
        if ins.name == 'R':
            out.append('X_ERROR', ins.targets_copy(), P['reset'])
        elif ins.name in ('SQRT_X', 'SQRT_X_DAG', 'X'):
            out.append('DEPOLARIZE1', ins.targets_copy(), P['p1'])
        elif ins.name == 'SQRT_ZZ':
            out.append('DEPOLARIZE2', ins.targets_copy(), P['p2'])
    return out
models = {}
for name in layouts:
    nc = noisy(stim.Circuit.from_file(os.path.join(ROOT, 'circuit-%s.stim' % name)))
    try:
        dem = nc.detector_error_model(decompose_errors=True); how = 'decompose_errors=True OK'
    except Exception as e:
        dem = nc.detector_error_model(decompose_errors=False); how = 'decompose_errors=True FAILED (%s); used False' % str(e)[:80]
    models[name] = (nc, dem)
    log('  %-15s DEM errors %4d detectors %d observables %d : %s' % (name, dem.num_errors, dem.num_detectors, dem.num_observables, how))

def obs_short(lay):
    return [ob['label'].split(' =')[0].split(' (')[0] for ob in lay['observables']]

def lookup_decoder(nc, n_train, seed):
    s = nc.compile_detector_sampler(seed=seed)
    d, o = s.sample(n_train, separate_observables=True, bit_packed=True)
    keys = d.view(np.dtype((np.void, d.shape[1]))).ravel()
    uk, inv = np.unique(keys, return_inverse=True)
    ob = np.unpackbits(o, axis=1, bitorder='little')[:, :nc.num_observables]
    cnt = np.bincount(inv, minlength=len(uk))
    table = np.stack([np.bincount(inv, weights=ob[:, k], minlength=len(uk)) for k in range(ob.shape[1])], 1)
    pred = (2 * table > cnt[:, None]).astype(np.uint8)
    return {bytes(k): p for k, p in zip(uk.tolist(), pred)}

def decode(table, matcher, dets):
    packed = np.packbits(dets.astype(np.uint8), axis=1, bitorder='little')
    preds, miss = [], 0
    mw = matcher.decode_batch(dets.astype(np.uint8))
    for i, row in enumerate(packed):
        p = table.get(bytes(row))
        if p is None:
            miss += 1; p = mw[i]
        preds.append(p)
    return np.array(preds, np.uint8), miss, mw

log('\n== 6. Simulated logical error rates (sanity check only; paper used Tesseract and its own idle model)')
N_SIM = 200000
tables = {}
for name in ['XR1', 'XR1-MinusMinus', 'XR3', 'SEQ', 'SEQ-OneOne', 'MEM']:
    nc, dem = models[name]; lay = layouts[name]
    t0 = time.time()
    m = pymatching.Matching.from_detector_error_model(dem)
    tables[name] = lookup_decoder(nc, 2_000_000, seed=11)
    d, o = nc.compile_detector_sampler(seed=99).sample(N_SIM, separate_observables=True)
    se1 = [k for k, det in enumerate(lay['detectors']) if det['label'].startswith('boundary SE1 S_')]
    ver = d[:, se1].sum(1) == 0
    pl, miss, pm = decode(tables[name], m, d)
    parts = []
    for k, lab in enumerate(obs_short(lay)):
        parts.append('%s raw %.3f%% | PyMatching %.3f%% | lookup %.3f%%' % (
            lab, 100 * o[ver, k].mean(), 100 * (pm[ver, k] != o[ver, k]).mean(), 100 * (pl[ver, k] != o[ver, k]).mean()))
    log('  %-15s %d shots, %d verified (lookup misses %d, %.0fs):\n      %s' % (name, N_SIM, ver.sum(), miss, time.time() - t0, '\n      '.join(parts)))
log('  paper simulation: SEQ Z2,G 1.000 [0.986, 1.014]% (1e6 shots per state); paper weight-1 budget (tab:r1_budget) 6.00e-3 for XR1 X1,G.')

# ---------------------------------------------------------------- 7. hardware data
log('\n== 7. Hardware records (Zenodo *-output.json)')
log('   Format: Results[0].Shots = list of shots in time order; each shot is the 0/1 list in the order of the')
log('   QIR result_record_output calls (labels "k_a(k-1)r"), which is the original Stim measurement order.')
log('   output position p -> Stim measurement record layout.json[...]["output_position_to_record"][p].')
PAPER_VER = {'XR1': 487, 'XR1-MinusMinus': 484, 'XR1-ZeroZero': 240, 'XR1-OneOne': 245, 'XR3': 957,
             'SEQ': 492, 'SEQ-OneOne': 486, 'MEM': 483}
hw = {}
for name, lay in layouts.items():
    c = stim.Circuit.from_file(os.path.join(ROOT, 'circuit-%s.stim' % name)); ref = c.reference_sample()
    res = json.load(open(os.path.join(ROOT, 'data', lay['output'])))['Results'][0]
    A = np.array(res['Shots'], np.uint8)
    assert A.shape[1] == c.num_measurements
    hist = {tuple(h['Outcome']): h['Count'] for h in res['Histogram']}
    assert sum(hist.values()) == len(A)
    rec = np.zeros_like(A); rec[:, lay['output_position_to_record']] = A  # Stim measurement-record order
    # detectors / observables from the circuit itself (m2d converter), so they are exactly the .stim annotations
    conv = c.compile_m2d_converter()
    D, O = conv.convert(measurements=rec.astype(bool), separate_observables=True)
    # cross-check: the same detectors computed directly from output positions listed in layout.json
    def manual(d):
        recs = [lay['output_position_to_record'][p] for p in d['output_positions']]
        return (A[:, d['output_positions']].sum(1) % 2) ^ (int(ref[recs].sum()) % 2)
    assert (np.array([manual(d) for d in lay['detectors']]).T == D).all()
    assert (np.array([manual(d) for d in lay['observables']]).T == O).all()
    se1 = [k for k, det in enumerate(lay['detectors']) if det['label'].startswith('boundary SE1 S_')]
    ver = D[:, se1].sum(1) == 0
    hw[name] = (D, O, ver, lay)
    log('  %-15s shots %4d  verified(trivial SE1 prep-basis boundary detectors) %4d  paper %4d  %s'
        % (name, len(A), ver.sum(), PAPER_VER[name], 'MATCH' if ver.sum() == PAPER_VER[name] else 'DIFF'))
    if name in ('XR1', 'SEQ'):
        for s in range(3):
            obs_abs = [(int(O[s, k]) ^ ref_obs[name][k]) for k in range(O.shape[1])]
            log('     shot %d: raw logical outcomes %s = %s (ideal %s), SE1 verified %s' % (
                s, obs_short(lay), obs_abs, ref_obs[name], bool(ver[s])))
D, O, ver, lay = hw['XR3']
rej = np.nonzero(~ver)[0]
log('  XR3 rejected shot indices (0-based): %s' % rej.tolist())
log('     paper: "19 of which are the consecutive shots 351--369"; here rejected within 351..369 (0-based): %d, (1-based) %d'
    % (sum(351 <= r <= 369 for r in rej), sum(351 <= r + 1 <= 369 for r in rej)))

log('\n== 8. Hardware logical errors: raw and decoded (PyMatching + lookup table, not Tesseract) vs paper')
def errs(name, k, use_ver, dec):
    D, O, ver, lay = hw[name]
    nc, dem = models[name]
    m = pymatching.Matching.from_detector_error_model(dem)
    tab = tables.get(name) or lookup_decoder(nc, 2_000_000, seed=11)
    tables[name] = tab
    pl, miss, pm = decode(tab, m, D)
    flip = {'raw': np.zeros_like(O), 'pm': pm, 'lut': pl}[dec]
    sel = ver if use_ver else np.ones(len(O), bool)
    return int(((O ^ flip)[sel, k]).sum()), int(sel.sum())
rows = [
    ('XR1 X1,G vs prep (|++>,|-->), verified', [('XR1', 0), ('XR1-MinusMinus', 0)], True, '7/971 = 0.72% [0.32, 1.41]'),
    ('XR1 X1,D vs prep, verified', [('XR1', 1), ('XR1-MinusMinus', 1)], True, '0/971'),
    ('XR1 X2,D vs prep, verified', [('XR1', 2), ('XR1-MinusMinus', 2)], True, '0/971'),
    ('XR1 X1,G vs X1,D (|00>,|11>), verified', [('XR1-ZeroZero', 0), ('XR1-OneOne', 0)], True, '8/485 (5/240 + 3/245)'),
    ('XR3 X1,G vs prep, verified', [('XR3', 0)], True, '0/957 (< 0.26%)'),
    ('XR3 X1,G vs prep, all shots', [('XR3', 0)], False, '10/1000'),
    ('XR3 X2,D vs prep, verified', [('XR3', 2)], True, '2/957 = 0.21% [0.04, 0.67]'),
    ('SEQ Z2,G vs prep, verified', [('SEQ', 0), ('SEQ-OneOne', 0)], True, '11/978 = 1.12% [0.60, 1.94]'),
    ('SEQ Z2,D vs prep, verified', [('SEQ', 1), ('SEQ-OneOne', 1)], True, '0/978'),
    ('MEM X1,D + X2,D, verified', [('MEM', 0), ('MEM', 1)], True, '0/966 (0/483 each)'),
]
for title, parts, use_ver, paper in rows:
    out = []
    for dec in ('raw', 'pm', 'lut'):
        k = n = 0
        for name, o in parts:
            a, b = errs(name, o, use_ver, dec); k += a; n += b
        out.append('%s %s' % (dec, pct(k, n)))
    log('  %-42s %s | paper (Tesseract) %s' % (title, ' | '.join(out), paper))

# XR3 decoded without the 6 chi-repetition detectors (paper: 7/957 = 0.73 [0.33, 1.43]%)
D, O, ver, lay = hw['XR3']; nc, _ = models['XR3']
keep = [k for k, d in enumerate(lay['detectors']) if 'chi_' not in d['label']]
ds, os_ = nc.compile_detector_sampler(seed=5).sample(2_000_000, separate_observables=True)
keys = np.ascontiguousarray(np.packbits(ds[:, keep], axis=1, bitorder='little')); del ds
kv = keys.view(np.dtype((np.void, keys.shape[1]))).ravel()
uk, inv = np.unique(kv, return_inverse=True)
cnt = np.bincount(inv, minlength=len(uk)); w = np.bincount(inv, weights=os_[:, 0], minlength=len(uk))
tab = {bytes(k): int(2 * a > c) for k, a, c in zip(uk.tolist(), w, cnt)}
hk = np.packbits(D[:, keep], axis=1, bitorder='little')
pred = np.array([tab.get(bytes(r), 0) for r in hk], np.uint8)
miss = sum(bytes(r) not in tab for r in hk)
log('  %-42s lut %s (unseen syndromes %d) | paper (Tesseract) 7/957 = 0.73%% [0.33, 1.43]'
    % ('XR3 X1,G without the 6 chi detectors, verified', pct(int((O[ver, 0] ^ pred[ver]).sum()), int(ver.sum())), miss))

log('\n== 9. Hardware detector rates vs paper tables tab:fusion and tab:max_rates')
def rate_table(names, use_ver):
    Ds = [hw[n][0][hw[n][2] if use_ver else slice(None)] for n in names]
    return np.vstack(Ds), hw[names[0]][3]
for circ, names in [('XR1', ['XR1', 'XR1-MinusMinus', 'XR1-ZeroZero', 'XR1-OneOne']), ('XR3', ['XR3']),
                    ('SEQ', ['SEQ', 'SEQ-OneOne']), ('MEM', ['MEM'])]:
    for use_ver in (False, True):
        Dm, lay = rate_table(names, use_ver)
        bulk = [k for k, d in enumerate(lay['detectors']) if re.match(r'L\d+ S_', d['label'])]
        r = Dm[:, bulk].mean(0); kmax = bulk[int(np.argmax(r))]
        log('  %s %-8s bulk detectors %d, max rate %s at %s' % (circ, 'verified' if use_ver else 'all', len(bulk),
            pct(int(Dm[:, kmax].sum()), len(Dm)), lay['detectors'][kmax]['label'].split(' +')[0]))
log('  paper tab:max_rates: XR1 all (L1,S_Z4) 2.27 / verified (L2,S_Z4) 2.06; XR3 all (L4,S_Z2) 3.80 / verified (L3,S_Z2) 2.82;')
log('                  SEQ (L3,S_X0) 2.70 / 2.66; MEM (L2,S_X3) 2.80 / 2.90; #bulk = 20, 40, 30, 40')
# fusion check (paper tab:fusion)
for circ, names, lname in [('XR1', ['XR1', 'XR1-MinusMinus', 'XR1-ZeroZero', 'XR1-OneOne'], 'kappa'), ('XR3', ['XR3'], 'kappa'),
                           ('SEQ', ['SEQ', 'SEQ-OneOne'], 'kappa'), ('SEQ', ['SEQ', 'SEQ-OneOne'], 'nu')]:
    Dm, lay = rate_table(names, True)
    # rebuild the same detectors without the fusion term from raw records
    fus = [k for k, d in enumerate(lay['detectors']) if 'm(%s_' % lname in d['label']]
    with_f = [Dm[:, k].mean() for k in fus]
    # without fusion = detector XOR (kappa/nu outcome relative to its reference value): recompute from records
    without = []
    for nm in names:
        D, O, ver, l2 = hw[nm]
        c = stim.Circuit.from_file(os.path.join(ROOT, 'circuit-%s.stim' % nm)); ref = c.reference_sample()
        A = np.array(json.load(open(os.path.join(ROOT, 'data', l2['output'])))['Results'][0]['Shots'], np.uint8)[ver]
        cols = []
        for k in fus:
            pos = l2['detectors'][k]['output_positions'][:2]
            recs = [l2['output_position_to_record'][p] for p in pos]
            cols.append((A[:, pos].sum(1) % 2) ^ (int(ref[recs].sum()) % 2))
        without.append(np.array(cols).T)
    W = np.vstack(without)
    log('  %s %-5s trailing-layer deformed stabilisers (verified, n=%d): no fusion min %.1f%%, with fusion max %.2f%%'
        % (circ, lname, len(Dm), 100 * W.mean(0).min(), 100 * max(with_f)))
log('  paper tab:fusion: XR1 x1g 49.6 -> 2.06; XR3 x1g 47.1 -> 2.51; SEQ x1g 50.1 -> 1.94; SEQ z2g 48.1 -> 2.66')

with open(os.path.join(ROOT, 'verify.txt'), 'w') as f:
    f.write('\n'.join(OUT) + '\n')
