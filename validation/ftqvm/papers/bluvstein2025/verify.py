"""Verification of the Bluvstein et al. (arXiv:2506.20661) reproduction package.

Run:  python -I verify.py  > verify.txt      (needs stim, pymatching, numpy; ~1-3 min)

Sections
  1  published QEC circuit: file integrity, counts vs paper statements
  2  noiseless determinism (1000 shots) and gauge-free detector analysis
  3  generator template == published circuit (noiseless and noisy)
  4  noise model -> implied timing vs hardware schedule (4.45 ms per round)
  5  hardware schedule <-> Stim consistency (CZ orders vs AOD shifts, Raman-AOD rows vs Stim targets)
  6  detector error model (decompose_errors=True) and PyMatching logical error per round
  7  lattice-surgery reconstruction: determinism, observables, DEM, PyMatching
"""
import json
import math
import os
import sys
import time

import numpy as np
import pymatching
import stim

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_surface as G  # noqa: E402

SEED = 20251124
SHOTS_NOISELESS = 1000
SHOTS_LER = int(os.environ.get('SHOTS_LER', '400000'))
rng_seed = iter(range(SEED, SEED + 1000))
FAIL = []


def check(cond, msg):
    print(('  [PASS] ' if cond else '  [FAIL] ') + msg)
    if not cond:
        FAIL.append(msg)


def load(name):
    return stim.Circuit(open(os.path.join(HERE, name)).read())


def noiseless_ok(c, label):
    s = c.compile_detector_sampler(seed=next(rng_seed)).sample(SHOTS_NOISELESS, append_observables=True)
    nd = c.num_detectors
    check(not s[:, :nd].any(), f'{label}: {SHOTS_NOISELESS} noiseless shots, all {nd} detectors = 0')
    check(not s[:, nd:].any(), f'{label}: {SHOTS_NOISELESS} noiseless shots, all {c.num_observables} observable(s) = 0 (deterministic)')
    try:
        c.detector_error_model(allow_gauge_detectors=False)
        check(True, f'{label}: Stim error analysis finds no non-deterministic (gauge) detectors/observables')
    except Exception as e:  # noqa: BLE001
        check(False, f'{label}: gauge detectors present: {e}')


def lepr(p, r):
    return 0.5 * (1 - (1 - 2 * p) ** (1 / r))


def ler(c, shots, label, postselect=None):
    dem = c.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True)
    m = pymatching.Matching.from_detector_error_model(dem)
    det, obs = c.compile_detector_sampler(seed=next(rng_seed)).sample(shots, separate_observables=True)
    pred = m.decode_batch(det)
    err = np.any(pred != obs, axis=1)
    keep = np.ones(shots, bool) if postselect is None else ~np.any(det[:, postselect], axis=1)
    pl = err[keep].mean()
    se = math.sqrt(pl * (1 - pl) / keep.sum())
    return dict(label=label, shots=shots, kept=int(keep.sum()), p_L=pl, p_L_se=se,
                mean_detector_rate=float(det.mean()), dem_errors=dem.num_errors, dem_detectors=dem.num_detectors)


print('Verification run', time.strftime('%Y-%m-%d %H:%M'), '| stim', stim.__version__, '| pymatching', pymatching.__version__,
      '| numpy', np.__version__, '| seed', SEED)

# ============================================================================ 1
print('\n1. Published QEC circuit (anc/Stim_circuit_repeated_QEC_Xbasis.txt)')
orig_txt = open(os.path.join(HERE, 'original-noisy.stim')).read()
anc_txt = open(os.path.join(HERE, 'anc', 'Stim_circuit_repeated_QEC_Xbasis.txt')).read()
check(orig_txt == anc_txt, 'original-noisy.stim is a byte-identical copy of the arXiv ancillary file')
clean_txt = open(os.path.join(HERE, 'circuit-qec.stim')).read()
noise_prefix = ('PAULI_CHANNEL_1', 'PAULI_CHANNEL_2', 'X_ERROR')
kept = [ln for ln in orig_txt.splitlines() if not ln.startswith(noise_prefix)]
check(clean_txt.splitlines() == kept, 'circuit-qec.stim = original with exactly the noise lines removed (every other line verbatim, same order)')
removed = [ln.split('(')[0] for ln in orig_txt.splitlines() if ln.startswith(noise_prefix)]
print('  removed noise lines:', {k: removed.count(k) for k in sorted(set(removed))})
orig = stim.Circuit(orig_txt)
clean = stim.Circuit(clean_txt)
for k in ('QUBIT_COORDS', 'SHIFT_COORDS'):
    print(f'  {k} lines in the published file: {orig_txt.count(k)} (nothing to preserve; coordinates inferred in schedule-qec.json)')
check(orig.num_ticks == clean.num_ticks == 8, f'TICK count preserved: {clean.num_ticks} (published file has 8 TICKs: after data prep, double TICK between rounds, one before final readout)')
check(orig.num_detectors == clean.num_detectors == 96, f'DETECTORs preserved: {clean.num_detectors}')
check(str(orig).count('OBSERVABLE_INCLUDE') == str(clean).count('OBSERVABLE_INCLUDE') == 1, 'OBSERVABLE_INCLUDE preserved: 1 (rec[-15..-11] = data qubits 22-26, middle row: X_L)')
check(clean.num_qubits == 49, f'qubits: {clean.num_qubits} (25 data + 24 ancilla); paper: "Stim circuit for four rounds of stabilizer measurement on a d=5 surface code" (SIGuide)')
check(clean.num_measurements == 121, f'measurements: {clean.num_measurements} = 4 rounds x 24 ancillas + 25 data = number of physical atoms used (four fresh 24-atom ancilla blocks)')
per_round = []
cur = 0
for ins in clean:
    if ins.name == 'DETECTOR':
        cur += 1
    if ins.name == 'M':
        per_round.append(cur)
        cur = 0
per_round.append(cur)
check(per_round[1:] == [12, 24, 24, 24, 12], f'detectors per round {per_round[1:]}; paper ED Fig. 6e: "the 24 individual detectors (12 for the first and last rounds)"; Methods: "96 detectors per shot across 5 rounds"; Fig. 2 Methods: "mean error of all deterministic detectors (96 per basis)"')
nCZ = sum(1 for i in clean if i.name == 'CZ')
check(nCZ == 16, f'CZ layers: {nCZ} = 4 rounds x 4 ("Each CZ layer corresponds to one time-step", Fig. 1 caption; 20 time-steps in 5 rounds)')

# ============================================================================ 2
print('\n2. Noiseless determinism')
noiseless_ok(clean, 'circuit-qec.stim')
ref = clean.reference_sample()
# absolute detector parities of the noiseless reference sample (sign conventions)
conv = clean.compile_m2d_converter()
d_ref = conv.convert(measurements=np.asarray(ref, dtype=bool)[None, :], append_observables=True)
print(f'  absolute (non-normalised) parities of the noiseless reference: {int(d_ref[0, :96].sum())} of 96 detectors are 1, observable = {int(d_ref[0, 96])}'
      ' (Stim reports detection events relative to this reference; the global Y echoes only flip signs)')
noiseless_ok(orig.without_noise(), 'original-noisy.stim with noise removed by Stim')

# ============================================================================ 3
print('\n3. Template generator (gen_surface.py) vs the published circuit')


def norm(ins):
    n = ins.name
    v = [t.value for t in ins.targets_copy()]
    if n in ('CZ', 'PAULI_CHANNEL_2'):
        key = frozenset(frozenset(v[i:i + 2]) for i in range(0, len(v), 2))
    elif n == 'M':
        key = tuple(v)
    else:
        key = frozenset(v)
    return (n, tuple(float('%.5g' % a) for a in ins.gate_args_copy()), key)


P5 = G.Patch(5, 5, G.published_index_map())
obs_row = [[(2, c) for c in range(5)]]
for noise, ref_c, lab in ((False, clean, 'noiseless'), (True, orig, 'noisy')):
    gen = G.build(P5, 4, 'X', 'X', noise=noise, observables=obs_row)
    a = [norm(i) for i in ref_c.flattened()]
    b = [norm(i) for i in gen.flattened()]
    check(a == b, f'{lab}: generated circuit equals the published one instruction-by-instruction ({len(a)} instructions incl. TICKs; '
                  'targets compared as sets within an instruction, CZ/PAULI_CHANNEL_2 as unordered pairs, M order exact, noise parameters to 5 significant digits)')
print('  rules encoded: CZ layers a/b/c/d with partners (ra+.5,ca-.5)/(ra-.5,ca-.5)/(ra+.5,ca+.5)/(ra-.5,ca+.5); round orders abcd, acbd, dbca, dcba;'
      ' SQRT_Y on data after CZ layers 1 and 3, global Y echo between layers 2 and 3 and at the end of each round; weight-2 boundary ancillas whose'
      ' two gates are both in the first (second) half of a round get their basis change late (early) with an extra local Y echo.')
print('  CSS type of an ancilla at plaquette centre (ra,ca): X if (ra-ca) even (deterministic in round 1 of the X-basis experiment), else Z.')

# ============================================================================ 4
print('\n4. Timing implied by the published noise model vs the hardware command strings')
idles = []
for ins in orig.flattened():
    if ins.name == 'PAULI_CHANNEL_1':
        args = ins.gate_args_copy()
        tg = [t.value for t in ins.targets_copy()]
        if tg and tg[0] == 2 and len(tg) == 25 and abs(args[0] - args[1]) < 1e-15 and args[2] > args[0] * 4.9 and args[2] < args[0] * 5.1:
            t = math.log(1 - args[2]) / math.log(1 - 0.5e-6)
            idles.append(round(t, 1))
print('  data-qubit idle channels (us), from p_Z = 1-(1-0.5e-6)^t:', idles)
per_round_idle = sum(idles) / 4
check(abs(per_round_idle - 4450) < 1.0, f'total modelled idle per round = {per_round_idle:.1f} us (paper: "each QEC round was 4.45 ms")')
check(sorted(set(idles)) == [235.0, 1285.0], 'idle quanta: 235 us = 0.47 ms/2 (between CZ layers) and 1285 us = 2.57 ms/2 (ancilla-block exchange)')
sched = json.load(open(os.path.join(HERE, 'schedule-qec.json'), encoding='utf-8'))
tot = sched['totals']['per_round']
check(all(abs(r['moving_awg_total_us'] - 4450) < 1e-6 for r in tot[1:]), 'Moving-AWG command durations: rounds 2-4 each 4450.0 us (schedule-qec.json)')
rp = sched['stream_alignment']['round_period_us_from_cz_periods']
print('  round period from CZ-to-CZ anchors, per AWG:', rp)
check(all(abs(v - 4450) < 1.0 for vs in rp.values() for v in vs), 'all four AWG streams give a 4450 +- 1 us round period')
print('  CZ anchor residuals after one constant offset per AWG (us):', {k: max(map(abs, v)) for k, v in sched['stream_alignment']['cz_anchor_residuals_us'].items()})

# ============================================================================ 5
print('\n5. Hardware schedule <-> Stim')
shift_to_layer = {(-1.5, 1.0): 'a', (-1.5, -1.0): 'b', (0.78, 1.0): 'c', (0.75, 1.0): 'c', (0.78, -1.0): 'd'}
mv_shifts = [s['aod']['shift_slm'] for s in sched['steps'] if s['awg'] == 'moving' and s['kind'] == 'move'
             and s.get('aod', {}).get('x_comb') == 'xanc_ent' and s['aod']['shift_slm'] != [0.0, 0.0] and s.get('segment') == 4]
hw_orders = [''.join(shift_to_layer[tuple(x)] for x in mv_shifts[4 * k:4 * k + 4]) for k in range(4)]
stim_cz = [frozenset(frozenset([i.targets_copy()[j].value, i.targets_copy()[j + 1].value]) for j in range(0, len(i.targets_copy()), 2))
           for i in clean if i.name == 'CZ']
uniq = []
for x in stim_cz:
    if x not in uniq:
        uniq.append(x)
stim_orders = [''.join('abcd'[uniq.index(x)] for x in stim_cz[4 * k:4 * k + 4]) for k in range(4)]
check(hw_orders == stim_orders == ['abcd', 'acbd', 'dbca', 'dcba'], f'AOD shift order per round {hw_orders} == Stim CZ-layer order {stim_orders} ("N Z Z_r N_r", Methods)')
nry = sum(1 for s in sched['steps'] if s['kind'] == 'rydberg')
check(nry == 16, f'{nry} Rydberg pulses in the Rydberg AWG string == 16 Stim CZ instructions')
# Raman-AOD row labels -> predicted Stim target sets
pm = G.published_index_map()
data_rows = {r: [pm[(r, c)] for c in range(5)] for r in range(5)}


def row_set(label):
    import re as _re
    m = _re.match(r'r(\d)_(.*)', label)
    n, suf = int(m.group(1)), m.group(2)
    if suf in ('d', 'Ad'):
        qs = [pm[(n, c)] for c in range(5) if n < 5 and (suf == 'd' or (n + c) % 2 == 0)]
        return set(qs)
    ra = n - 0.5
    an = [(a_ra, a_ca) for (a_ra, a_ca, _) in P5.anc if a_ra == ra]
    if suf == 'a':
        sel = an
    elif suf == 'nl_a':
        sel = [x for x in an if x[1] != -0.5]
    elif suf == 'nr_a':
        sel = [x for x in an if x[1] != 4.5]
    elif suf == 'l_a':
        sel = [x for x in an if x[1] == -0.5]
    elif suf == 'r_a':
        sel = [x for x in an if x[1] == 4.5]
    else:
        raise ValueError(label)
    return {pm[x] for x in sel}


line_targets = {}
for i, ln in enumerate(clean_txt.splitlines(), start=1):
    parts = ln.split()
    if parts and parts[0] in ('SQRT_Y', 'SQRT_Y_DAG', 'Y'):
        line_targets[i] = set(int(x) for x in parts[1:])
pred = {}
for s in sched['steps']:
    if s['awg'] == 'raman' and s['kind'] == 'raman_local' and s.get('stim_lines'):
        for ln in s['stim_lines']:
            pred.setdefault(ln, set())
            for lab in s['raman_aod_rows_per_slot']:
                if lab:
                    pred[ln] |= row_set(lab)
ok = all(pred[ln] == line_targets[ln] for ln in pred)
check(ok and len(pred) == 34, f'for all {len(pred)} locally addressed Stim rotation lines, the union of lit Raman-AOD rows (decoded as row N = ra+0.5, edge suffixes l/r/nl/nr) equals the Stim target set exactly')
bad = [ln for ln in pred if pred[ln] != line_targets[ln]]
if bad:
    print('   mismatches', bad)
glob = [s for s in sched['steps'] if s['awg'] == 'raman' and s['details'].startswith('SC1_ECHO') and s.get('stim_lines')]
check(all(line_targets[s['stim_lines'][0]] == set(range(49)) for s in glob), f'{len(glob)} global SC1_ECHO pulses map onto the 8 Stim "Y all-49" echo lines')
cov = set()
for s in sched['steps']:
    cov |= set(s.get('stim_lines') or [])
ops = [L for L in sched['stim_line_labels'] if not L['label'].startswith('detector') and not L['label'].startswith('observable')]
check(all(L['line'] in cov for L in ops), f'every one of the {len(ops)} Stim operation lines (gates, R, M, idle markers) is realized by >= 1 hardware step')

# ============================================================================ 6
print(f'\n6. Detector error models and PyMatching ({SHOTS_LER} shots per circuit)')
dem = orig.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True)
check(dem.num_detectors == 96, f'original-noisy.stim: detector_error_model(decompose_errors=True) OK: {dem.num_errors} error mechanisms, {dem.num_detectors} detectors '
                               '(approximate_disjoint_errors=True is required by Stim for PAULI_CHANNEL_1/2)')
results = []
r = ler(orig, SHOTS_LER, 'd=5 X basis, published noisy circuit')
results.append(r)
variants = []
for d in (5, 3):
    for basis in ('X', 'Z'):
        if d == 5 and basis == 'X':
            continue
        P = G.Patch(d, d)
        obs = [[(d // 2, c) for c in range(d)]] if basis == 'X' else [[(r_, d // 2) for r_ in range(d)]]
        c = G.build(P, 4, basis, basis, noise=True, observables=obs)
        noiseless_ok(c.without_noise(), f'generated d={d} {basis}-basis 4-round memory')
        results.append(ler(c, SHOTS_LER, f'd={d} {basis} basis, generated with the published template + error model'))
print('  %-70s %8s %18s %18s %9s' % ('circuit', 'shots', 'p_L (4 rounds)', 'LEPR (%)', 'det.rate'))
lep = {}
for r in results:
    L = lepr(r['p_L'], 4)
    dL = r['p_L_se'] / ((1 - 2 * r['p_L']) ** (3 / 4)) / 4 if r['p_L'] < 0.5 else float('nan')
    lep[r['label']] = (L, dL)
    print('  %-70s %8d %9.5f+-%.5f %9.4f+-%.4f %9.4f' % (r['label'], r['shots'], r['p_L'], r['p_L_se'], 100 * L, 100 * dL, r['mean_detector_rate']))
L5 = np.mean([lep[k][0] for k in lep if k.startswith('d=5')])
L3 = np.mean([lep[k][0] for k in lep if k.startswith('d=3')])
print(f'  basis-averaged LEPR: d=5 {100 * L5:.3f}%   d=3 {100 * L3:.3f}%   ratio d3/d5 = {L3 / L5:.2f}')
print('  paper (Fig. 2d, Methods "Hybrid"): "a final value for the reported LEPR of 0.62(3)% for d=5 and 1.33(4)% for d=3" (ML+MLE hybrid decoder with loss information,'
      ' experimental data incl. atom loss, averaged over X and Z bases); ratio 2.14(13); "reduces toward 0.1% per round on shots with no qubit loss".')
print('  interpretation: Stim cannot model atom loss (about half of the experimental error budget; "roughly half of our errors being loss"),'
      ' so a Pauli-only simulation decoded with PyMatching is expected to sit below 0.62% and near the paper\'s no-loss value; it is NOT a reproduction'
      ' of the experimental number. The d=3 circuit here is a standalone 3x3 patch, not a quadrant of the d=5 layout as in the experiment.')
check(L5 < 0.0062, 'Pauli-only PyMatching LEPR(d=5) is below the experimental 0.62% (expected: no loss in the model)')

# ============================================================================ 7
print('\n7. Lattice-surgery reconstruction (circuit-surgery.stim, circuit-surgery-xx.stim)')
zz = load('circuit-surgery.stim')
xx = load('circuit-surgery-xx.stim')
zzn = load('circuit-surgery-noisy.stim')
xxn = load('circuit-surgery-xx-noisy.stim')
for c, lab in ((zz, 'circuit-surgery.stim (ZZ)'), (xx, 'circuit-surgery-xx.stim (XX)')):
    print(f'  {lab}: qubits {c.num_qubits}, detectors {c.num_detectors}, observables {c.num_observables}, measurements {c.num_measurements}')
    noiseless_ok(c, lab)
check(zz.without_noise() == zzn.without_noise() and xx.without_noise() == xxn.without_noise(), 'noisy files differ from the noiseless ones only by noise channels')
PS = G.Patch(5, 10)
seamZ = [(ra, ca) for (ra, ca, t) in PS.anc if ca == 4.5 and t == 'Z']
seamX = [(ra, ca) for (ra, ca, t) in PS.anc if ca == 4.5 and t == 'X']
nX = sum(1 for a in PS.anc if a[2] == 'X')
nZ = sum(1 for a in PS.anc if a[2] == 'Z')
print(f'  merged 5x10 lattice: 50 data, {len(PS.anc)} checks per round ({nX} X-type, {nZ} Z-type); seam (x=4.5): {len(seamZ)} Z-type {seamZ} + {len(seamX)} X-type {seamX}')
check(len(seamZ) == 3, 'three seam Z checks: matches Methods "error detection on the middle three ancillas each having the same value in both rounds"')
check(zz.num_detectors == nX + len(PS.anc) + nZ - 3, f'ZZ detectors = {nX} (round-1 X checks, deterministic from |+>|+>) + {len(PS.anc)} (round 2 vs 1) + {nZ - 3} (final Z data vs round 2; the 3 seam Z checks omitted as in the paper) = {zz.num_detectors}')
check(xx.num_detectors == nX + len(PS.anc) + nX, f'XX detectors = {nX} + {len(PS.anc)} + {nX} (final X data vs round 2) = {xx.num_detectors}')
# raw lattice-surgery outcome: product of round-1 seam Z checks; raw data ZZ
samp = zz.compile_sampler(seed=next(rng_seed)).sample(SHOTS_NOISELESS)
nm = zz.num_measurements
aq = PS.aq
idx = {q: i for i, q in enumerate(aq)}
seam_cols = [idx[PS.idx[a]] for a in seamZ]
seam_raw = np.bitwise_xor.reduce(samp[:, seam_cols], axis=1)
data0 = nm - 50
zz_cols = [data0 + PS.dq.index(PS.idx[(r_, c_)]) for r_ in range(5) for c_ in (4, 5)]
zz_raw = np.bitwise_xor.reduce(samp[:, zz_cols], axis=1)
print(f'  noiseless: raw seam product (lattice-surgery outcome m) = 1 in {seam_raw.mean() * 100:.1f}% of shots (random, as expected);'
      f' raw data parity of columns 4,5 XOR m = {int((zz_raw ^ seam_raw)[0])} in {int(np.sum((zz_raw ^ seam_raw) == (zz_raw ^ seam_raw)[0]))} / {SHOTS_NOISELESS} shots')
check(0.4 < seam_raw.mean() < 0.6 and np.all((zz_raw ^ seam_raw) == (zz_raw ^ seam_raw)[0]), 'Z_L1 Z_L2 measured by the seam is random and always agrees with Z_L1 Z_L2 read from the data (Bell pair with ZZ = (-1)^m, XX = +1)')
# Pauli-algebra check: product of seam Z checks equals Z on data columns 4 and 5 (CSS frame)
prodcells = []
for (ra, ca) in seamZ:
    prodcells += [d for d in PS.partners[(ra, ca)].values()]
check(sorted(prodcells) == sorted((r_, c_) for r_ in range(5) for c_ in (4, 5)), 'product of the three seam Z checks = Z on all of data columns 4 and 5 = Z_L1 Z_L2 (column representatives)')
for c, lab in ((zzn, 'ZZ noisy'), (xxn, 'XX noisy')):
    d = c.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True)
    check(d.num_detectors == c.num_detectors, f'{lab}: detector_error_model(decompose_errors=True) OK ({d.num_errors} mechanisms)')
# why the paper omits the final seam checks: with them, the ZZ observable is a product of detectors
P10 = G.Patch(5, 10)
zz_all = G.build(P10, 2, 'X', 'Z', orders=G.PAPER_ORDERS[:2], noise=True,
                 observables=[[(r_, c_) for r_ in range(5) for c_ in (4, 5)]], surgery_seam_obs=(0, seamZ))
noiseless_ok(zz_all.without_noise(), 'ZZ variant WITH the 3 final seam detectors')
try:
    zz_all.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True).shortest_graphlike_error()
    check(False, 'ZZ variant with final seam detectors should have no undetectable logical error')
except ValueError:
    check(True, 'with the 3 final seam detectors, no undetectable error flips ZZ (the observable equals a product of detectors, so a decoder can never fail): '
                'this is why the paper decodes without them')
for c, lab in ((orig, 'published d=5 QEC (X_L)'), (zzn, 'surgery ZZ (paper detector set)'), (xxn, 'surgery XX')):
    w = len(c.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True).shortest_graphlike_error())
    print(f'  shortest undetectable graphlike logical error, {lab}: {w} fault(s)')
    if lab.startswith('surgery ZZ'):
        check(w == 2, 'surgery ZZ: time-like distance 2 = number of merged rounds (two measurement errors on one seam check flip Z_L1Z_L2 undetected) -- '
                      'the reason the paper uses error detection on the seam ancillas ("to compensate for having <d rounds")')
rz = ler(zzn, SHOTS_LER, 'ZZ: (data Z_L1Z_L2) XOR (seam outcome)')
rx = ler(xxn, SHOTS_LER, 'XX: X_L1 X_L2')
# error detection on the three seam Z checks in round 2 (Methods, Fig. 3d)
det_coords = zzn.get_detector_coordinates()
post = [k for k, v in det_coords.items() if len(v) >= 3 and v[0] == 4.5 and v[2] == 1 and (v[1] in (-0.5, 1.5, 3.5))]
rz_post = ler(zzn, SHOTS_LER, 'ZZ with seam-Z error detection', postselect=post)
for r in (rz, rx, rz_post):
    print('  %-48s p_L = %.5f +- %.5f  (kept %d / %d)' % (r['label'], r['p_L'], r['p_L_se'], r['kept'], r['shots']))
print(f'  Bell-pair error (mean of XX and ZZ, Methods Fig. 3 definition) = {(rz["p_L"] + rx["p_L"]) / 2:.5f}; with seam error detection on ZZ: {(rz_post["p_L"] + rx["p_L"]) / 2:.5f}')
print('  paper: lattice-surgery error is shown only graphically (Fig. 3c,d); no number is quoted in the text, so no numeric comparison is made.')
print('  injected ancilla measurement error (Fig. 3c protocol: extra flip probability p on every ancilla measurement), PyMatching, 100000 shots each:')
print('    %8s %12s %12s %12s' % ('p_inj', 'ZZ error', 'XX error', 'Bell error'))
sweep = []
for pinj in (0.0, 0.01, 0.02, 0.04):
    vals = []
    for meas_b, obs_, so, skip in (('Z', [[(r_, c_) for r_ in range(5) for c_ in (4, 5)]], (0, seamZ), seamZ),
                                   ('X', [[(2, c_) for c_ in range(10)]], None, ())):
        c = G.build(P10, 2, 'X', meas_b, orders=G.PAPER_ORDERS[:2], noise=True, observables=obs_, surgery_seam_obs=so,
                    skip_final_detectors=skip, inject_anc_meas_error=pinj)
        vals.append(ler(c, 100000, 'sweep')['p_L'])
    sweep.append((pinj, vals))
    print('    %8.3f %12.5f %12.5f %12.5f' % (pinj, vals[0], vals[1], (vals[0] + vals[1]) / 2))
check(sweep[-1][1][0] / max(sweep[0][1][0], 1e-6) > sweep[-1][1][1] / max(sweep[0][1][1], 1e-6),
      'ZZ (lattice-surgery) error grows faster with injected ancilla measurement error than the XX memory-like part (qualitative Fig. 3c statement)')

print('\nSUMMARY:', 'ALL CHECKS PASSED' if not FAIL else f'{len(FAIL)} FAILED: ' + '; '.join(FAIL))
