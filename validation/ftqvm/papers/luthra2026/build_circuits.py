"""Translate the submitted QIR programs (Zenodo 10.5281/zenodo.23165109, *-input.json)
into Stim circuits with the paper's detectors and logical observables.

Run:  python -I build_circuits.py <this directory>
Writes circuit-*.stim and layout.json into that directory.

Gate translation (QIR uses Q# conventions, angles in radians):
  rz(t)   = exp(-i t/2 Z)        t = pi/2 -> S,      pi -> Z,      3pi/2 -> S_DAG
  rx(t)   = exp(-i t/2 X)        t = pi/2 -> SQRT_X, pi -> X,      3pi/2 -> SQRT_X_DAG
  rzz(t)  = exp(-i t/2 Z(x)Z)    t = pi/2 -> SQRT_ZZ (= H2 native ZZMax = ZZPhase(0.5) in TKET half-turns)
  reset   -> R      m(q, r) -> M q   (measurement record index == QIR result id; checked)
All equalities hold up to a global phase; verify.py checks them numerically.

TICKs: the QIR is one flat basic block with no layer markers. Instructions are emitted one per
line in exact program order, and a TICK is inserted only when the next instruction touches a
qubit already used since the last TICK ("sequential packing"). Concatenating the lines of the
.stim file therefore reproduces the QIR instruction order exactly; the TICKs are a derived,
not a submitted, layering.

Qubit roles (identified from the gate pattern, identical in all 8 programs):
  0..4   ancilla of X stabiliser S_X,j      (j = qubit)
  5..14  data qubit q_i                       (i = qubit - 5)
  15..19 ancilla of Z stabiliser S_Z,j      (j = qubit - 15)
  20,21,22  gadget qubits kappa_2,3,4 (X1 gadget)  /  nu_0,1,2 (Z2 gadget in SEQ)
  23     gauge check gamma_0 (X1 gadget)    /  lambda (Z2 gadget in SEQ)
  24,25,26  gadget checks chi_2, chi_3, chi_7 (X1)  /  eta_2, eta_6, eta_7 (Z2 in SEQ)
"""
import json, math, os, re, sys

QB = re.compile(r'%Qubit\* (?:inttoptr \(i64 (\d+) to %Qubit\*\)|null)')
RS = re.compile(r'%Result\* (?:inttoptr \(i64 (\d+) to %Result\*\)|null)')
LBL = re.compile(r'@(\d+) = internal constant \[\d+ x i8\] c"([^"]*)\\00"')

GATE = {('rz', 1): 'S', ('rz', 2): 'Z', ('rz', 3): 'S_DAG',
        ('rx', 1): 'SQRT_X', ('rx', 2): 'X', ('rx', 3): 'SQRT_X_DAG',
        ('rzz', 1): 'SQRT_ZZ', ('rzz', 3): 'SQRT_ZZ_DAG'}

EXPERIMENTS = {
    # name: (input file stem, experiment type, prep basis, final basis)
    'XR1':            ('XR1-Prep-Plus-Plus',   'XR', 'X', 'X'),
    'XR1-MinusMinus': ('XR1-Prep-Minus-Minus', 'XR', 'X', 'X'),
    'XR1-ZeroZero':   ('XR1-Prep-Zero-Zero',   'XR', 'Z', 'X'),
    'XR1-OneOne':     ('XR1-Prep-One-One',     'XR', 'Z', 'X'),
    'XR3':            ('XR3-Prep-Plus-Plus',   'XR', 'X', 'X'),
    'SEQ':            ('SEQ-Prep-Zero-Zero',   'SEQ', 'Z', 'Z'),
    'SEQ-OneOne':     ('SEQ-Prep-One-One',     'SEQ', 'Z', 'Z'),
    'MEM':            ('MEM-Prep-Plus-Plus',   'MEM', 'X', 'X'),
}

SX = list(range(0, 5)); SZ = list(range(15, 20)); DATA = list(range(5, 15))
KAPPA = [20, 21, 22]; GAMMA = 23; CHI = [24, 25, 26]
# code structure: l=5, a=1+x^2, b=1+x;  H_X = [A|B], H_Z = [B^T|A^T]
X1 = [2, 3, 7]; X2 = [1, 7, 9]; Z1 = [2, 4, 5]; Z2 = [2, 6, 7]


def parse_qir(path):
    txt = open(path, encoding='utf-8').read()
    labels = {int(a): b for a, b in LBL.findall(txt)}
    ops, outputs = [], []
    for ln, line in enumerate(txt.splitlines(), 1):
        s = line.strip()
        m = re.match(r'call void @__quantum__qis__(\w+)__body\((.*)\)$', s)
        if m:
            name, args = m.groups()
            qs = [int(x) if x else 0 for x in QB.findall(args)]
            rs = [int(x) if x else 0 for x in RS.findall(args)]
            a = re.match(r'double ([-0-9.eE+]+)', args)
            ops.append(dict(name=name, angle=float(a.group(1)) if a else None, qubits=qs, results=rs, line=ln))
            continue
        m = re.match(r'call void @__quantum__rt__result_record_output\((.*)\)$', s)
        if m:
            rs = [int(x) if x else 0 for x in RS.findall(m.group(1))]
            lab = re.search(r'\]\* @(\d+),', m.group(1))
            outputs.append(dict(result=rs[0], label=labels[int(lab.group(1))]))
            continue
        if s.startswith('call') and '__quantum__rt__' not in s:
            raise ValueError('unhandled instruction line %d: %s' % (ln, s))
        if s.startswith(('br ', 'switch', '%')) and 'icmp' in s:
            raise ValueError('control flow not supported')
    attrs = re.search(r'"required_num_qubits"="(\d+)" "required_num_results"="(\d+)"', txt)
    return ops, outputs, int(attrs.group(1)), int(attrs.group(2))


def quarter_turns(angle):
    k = angle / (math.pi / 2)
    kr = round(k)
    assert abs(k - kr) < 1e-9, angle
    return kr % 4


def to_stim_ops(ops):
    """Return list of (stim_gate, targets, qir_line) in program order."""
    out = []
    for o in ops:
        n = o['name']
        if n == 'reset':
            out.append(('R', o['qubits'], o['line']))
        elif n == 'm':
            out.append(('M', o['qubits'], o['line']))
        elif n in ('rz', 'rx', 'rzz'):
            k = quarter_turns(o['angle'])
            if k == 0:
                continue  # identity (none occur in these programs)
            if (n, k) == ('rzz', 2):
                out.append(('Z', o['qubits'][:1], o['line'])); out.append(('Z', o['qubits'][1:], o['line']))
            else:
                out.append((GATE[(n, k)], o['qubits'], o['line']))
        else:
            raise ValueError('unknown gate ' + n)
    return out


def output_roles(ops, outputs, kind):
    """Label each output-array position (= original Stim measurement order) with its role."""
    res_qubit = {}
    order = []
    for o in ops:
        if o['name'] == 'm':
            res_qubit[o['results'][0]] = o['qubits'][0]
            order.append(o['results'][0])
    assert order == list(range(len(order))), 'QIR result ids are not in program order'
    for i, o in enumerate(outputs):
        assert o['label'] == '%d_a%dr' % (i + 1, i), o
    qorder = [res_qubit[o['result']] for o in outputs]
    pos = 0
    rounds, gad = [], {}

    def take(qs):
        nonlocal pos
        assert qorder[pos:pos + len(qs)] == qs, (kind, pos, qorder[pos:pos + len(qs)], qs)
        idx = list(range(pos, pos + len(qs))); pos += len(qs)
        return dict(zip(qs, idx))

    code = SX + SZ
    if kind == 'MEM':
        for _ in range(5):
            rounds.append(dict(code=take(code), tag='bare'))
    else:
        rounds.append(dict(code=take(code), tag='SE1'))
        gad['gamma_init'] = take([GAMMA])[GAMMA]
        gad['x_rounds'] = []
        while qorder[pos:pos + 10] == code and qorder[pos + 10:pos + 14] == CHI + [GAMMA]:
            r = dict(code=take(code), tag='X1-merged')
            g = take(CHI + [GAMMA])
            r['chi'] = [g[q] for q in CHI]; r['gamma'] = g[GAMMA]
            rounds.append(r); gad['x_rounds'].append(len(rounds) - 1)
        k = take(KAPPA); gad['kappa'] = [k[q] for q in KAPPA]
        if kind == 'SEQ':
            gad['lambda_init'] = take([GAMMA])[GAMMA]
            r = dict(code=take(code), tag='Z2-merged')
            g = take([GAMMA] + CHI)
            r['eta'] = [g[q] for q in CHI]; r['lambda'] = g[GAMMA]
            rounds.append(r); gad['z_rounds'] = [len(rounds) - 1]
            n = take(KAPPA); gad['nu'] = [n[q] for q in KAPPA]
        rounds.append(dict(code=take(code), tag='SE2'))
    d = take(DATA); data = [d[q] for q in DATA]
    assert pos == len(qorder)
    return qorder, rounds, gad, data


def detectors_and_observables(kind, prep, final, rounds, gad, data):
    """Paper Sec. III.C: boundary detectors, bulk detectors between consecutive syndrome cycles
    (kappa / nu outcomes folded into the trailing layer = fusion correction), chi / gamma
    repetition detectors, and the gadget / destructive logical observables.
    Everything is expressed in output-array positions."""
    dets = []  # (positions, label)
    S = {('X', j): SX[j] for j in range(5)}; S.update({('Z', j): SZ[j] for j in range(5)})
    # SE1 boundary: stabilisers of the preparation basis are deterministic
    for j in range(5):
        dets.append(([rounds[0]['code'][S[(prep, j)]]], 'boundary SE1 S_%s%d' % (prep, j)))
    # The 5 stabilisers of the other basis are individually random in SE1, but their product is
    # the identity for this code (rank H = 4), so their joint parity is deterministic. Adding it
    # makes the detector set span every deterministic measurement parity, and reproduces the
    # paper's count of 62 detectors for XR3 (inferred; the paper does not list its detectors).
    other = 'Z' if prep == 'X' else 'X'
    dets.append(([rounds[0]['code'][S[(other, j)]] for j in range(5)],
                 'boundary SE1 product of all S_%s (= identity)' % other))
    if kind != 'MEM':
        dets.append(([gad['gamma_init']], 'gamma_0 initial (kappa in |0>)'))
    x_r = gad.get('x_rounds', []); z_r = gad.get('z_rounds', [])
    # bulk layers L = 1..N-1 comparing cycle L and L+1
    for L in range(1, len(rounds)):
        a, b = rounds[L - 1], rounds[L]
        for basis in 'XZ':
            for j in range(5):
                pos = [a['code'][S[(basis, j)]], b['code'][S[(basis, j)]]]
                lab = 'L%d S_%s%d' % (L, basis, j)
                # X1 gadget detaches between a (last X1-merged) and b: fold in kappa_j (j=2,3,4)
                if basis == 'Z' and j in (2, 3, 4) and (L - 1) in x_r and L not in x_r:
                    pos.append(gad['kappa'][j - 2]); lab += ' + m(kappa_%d) fusion' % j
                # Z2 gadget detaches: fold in nu_j (j=0,1,2)
                if basis == 'X' and j in (0, 1, 2) and (L - 1) in z_r and L not in z_r:
                    pos.append(gad['nu'][j]); lab += ' + m(nu_%d) fusion' % j
                dets.append((pos, lab))
        # gadget check repetitions between merged rounds
        if (L - 1) in x_r and L in x_r:
            for i, c in zip(X1, range(3)):
                dets.append(([a['chi'][c], b['chi'][c]], 'L%d chi_%d repetition' % (L, i)))
    if kind != 'MEM':
        prev = gad['gamma_init']
        for r in x_r:
            dets.append(([prev, rounds[r]['gamma']], 'gamma_0 repetition (cycle %d)' % r))
            prev = rounds[r]['gamma']
        dets.append(([prev] + gad['kappa'], 'gamma_0 fusion: last gamma_0 * m(kappa_2)m(kappa_3)m(kappa_4)'))
    if kind == 'SEQ':
        dets.append(([gad['lambda_init']], 'lambda initial (nu in |+>)'))
        prev = gad['lambda_init']
        for r in z_r:
            dets.append(([prev, rounds[r]['lambda']], 'lambda repetition (cycle %d)' % r))
            prev = rounds[r]['lambda']
        dets.append(([prev] + gad['nu'], 'lambda fusion: last lambda * m(nu_0)m(nu_1)m(nu_2)'))
    # final boundary: SE2 stabilisers of the final basis against data measurements
    last = rounds[-1]
    H = code_checks()
    for j in range(5):
        dets.append(([last['code'][S[(final, j)]]] + [data[i] for i in H[final][j]],
                     'boundary final S_%s%d vs data' % (final, j)))
    obs = []
    if kind == 'XR':
        x1g = rounds[x_r[0]]['chi']  # first merged round (paper Fig. 13 marks R=1 as X1,G)
        x1d = [data[i] for i in X1]; x2d = [data[i] for i in X2]
        if prep == 'X':
            obs += [(x1g, 'X1,G = chi_2 chi_3 chi_7 (merged cycle 1)'), (x1d, 'X1,D = data X q2 q3 q7'),
                    (x2d, 'X2,D = data X q1 q7 q9')]
        else:
            obs += [(x1g + x1d, 'X1,G xor X1,D (agreement of gadget and transversal readout)')]
    elif kind == 'SEQ':
        z2g = rounds[z_r[0]]['eta'] + [gad['kappa'][0]]
        z2d = [data[i] for i in Z2] + [gad['kappa'][0]]
        obs += [(z2g, 'Z2,G = eta_2 eta_6 eta_7 * m(kappa_2)'), (z2d, 'Z2,D = data Z q2 q6 q7 * m(kappa_2)')]
    else:
        obs += [([data[i] for i in X1], 'X1,D = data X q2 q3 q7'), ([data[i] for i in X2], 'X2,D = data X q1 q7 q9')]
    return dets, obs


def code_checks():
    l = 5
    def circ(poly):
        return [[(r + e) % l for e in poly] for r in range(l)]
    A = circ([0, 2]); B = circ([0, 1])  # row r of A: columns r+e (x^e shifts)
    HX = [sorted(A[j] + [5 + c for c in B[j]]) for j in range(5)]
    # H_Z = [B^T | A^T]
    BT = [[c for c in range(l) if j in B[c]] for j in range(l)]
    AT = [[c for c in range(l) if j in A[c]] for j in range(l)]
    HZ = [sorted(BT[j] + [5 + c for c in AT[j]]) for j in range(5)]
    return {'X': HX, 'Z': HZ}


def build(name, data_dir):
    stem, kind, prep, final = EXPERIMENTS[name]
    path = os.path.join(data_dir, stem + '-input.json')
    ops, outputs, nq, nres = parse_qir(path)
    sops = to_stim_ops(ops)
    qorder, rounds, gad, data = output_roles(ops, outputs, kind)
    dets, obs = detectors_and_observables(kind, prep, final, rounds, gad, data)
    out_to_meas = [o['result'] for o in outputs]  # output position -> measurement record index
    # Stim numbers detectors in order of appearance; sort (stably) by the record index that
    # completes each detector so that layout.json index == Stim detector index.
    dets = sorted(dets, key=lambda d: max(out_to_meas[p] for p in d[0]))
    # annotations placed right after the measurement that completes them
    nmeas = len(outputs)
    after = {}  # meas index -> list of annotation strings
    def rec_targets(positions, cur):
        ms = sorted(out_to_meas[p] for p in positions)
        return ' '.join('rec[%d]' % (m - cur) for m in ms), ms[-1]
    ann = []
    for k, (positions, lab) in enumerate(dets):
        ms = sorted(out_to_meas[p] for p in positions)
        ann.append((ms[-1], 'D', k, ms, lab))
    for k, (positions, lab) in enumerate(obs):
        ms = sorted(out_to_meas[p] for p in positions)
        ann.append((ms[-1], 'O', k, ms, lab))
    for a in ann:
        after.setdefault(a[0], []).append(a)
    lines = ['# %s: Luthra & Owens, arXiv:2610.39067; program = Zenodo 10.5281/zenodo.23165109 %s-input.json' % (name, stem),
             '# Exact translation of the submitted QIR (rz/rx/rzz/reset/m) to Stim; see build_circuits.py for the gate map.',
             '# Qubit indices = QIR qubit indices. QUBIT_COORDS(index, 0): H2 has no fixed qubit geometry (ions are transported).',
             '# TICKs are derived by sequential packing of the program order (no layering exists in the QIR).',
             '# Measurement record index == QIR %Result id; output-array position -> record index is in layout.json.']
    for q in range(nq):
        lines.append('QUBIT_COORDS(%d, 0) %d' % (q, q))
    used = set(); meas_count = 0
    for g, ts, ln in sops:
        if used & set(ts):
            lines.append('TICK'); used = set()
        used |= set(ts)
        lines.append('%s %s' % (g, ' '.join(map(str, ts))))
        if g == 'M':
            cur = meas_count; meas_count += 1
            for (_, typ, k, ms, lab) in after.get(cur, []):
                tgt = ' '.join('rec[%d]' % (m - meas_count) for m in ms)
                if typ == 'D':
                    lines.append('DETECTOR %s  # D%d: %s' % (tgt, k, lab))
                else:
                    lines.append('OBSERVABLE_INCLUDE(%d) %s  # L%d: %s' % (k, tgt, k, lab))
    lines.append('TICK')
    assert meas_count == nmeas == nres
    text = '\n'.join(lines) + '\n'
    layout = dict(name=name, input=stem + '-input.json', output=stem + '-output.json', kind=kind,
                  prep_basis=prep, final_basis=final, num_qubits=nq, num_measurements=nres,
                  output_position_to_record=out_to_meas,
                  output_position_qubit=qorder,
                  rounds=[dict(tag=r['tag'], **{k: v for k, v in r.items() if k != 'tag' and k != 'code'},
                               code={('S_X%d' % q if q < 5 else 'S_Z%d' % (q - 15)): p for q, p in r['code'].items()})
                          for r in rounds],
                  gadget=gad, data_positions=data,
                  detectors=[dict(index=k, output_positions=p, label=l) for k, (p, l) in enumerate(dets)],
                  observables=[dict(index=k, output_positions=p, label=l) for k, (p, l) in enumerate(obs)],
                  qir_instruction_count=len(ops), stim_gate_count=len(sops))
    return text, layout


def main():
    root = sys.argv[1]
    data_dir = os.path.join(root, 'data')
    layouts = {}
    for name in EXPERIMENTS:
        text, layout = build(name, data_dir)
        with open(os.path.join(root, 'circuit-%s.stim' % name), 'w', newline='\n') as f:
            f.write(text)
        layouts[name] = layout
        print(name, 'detectors', len(layout['detectors']), 'observables', len(layout['observables']),
              'qir ops', layout['qir_instruction_count'])
    with open(os.path.join(root, 'layout.json'), 'w') as f:
        json.dump(layouts, f, indent=1)


if __name__ == '__main__':
    main()
