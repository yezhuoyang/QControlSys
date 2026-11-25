"""Generate the noiseless stability-8 Stim circuits of Caune et al. (arXiv:2410.05202;
Nat. Commun. 17, 7383 (2026)) on Rigetti Ankaa-2 qubits 36, 37, 38, 43, 45, 50, 51, 52.

The gate sequence is the one in the executed Quil programs the authors deposited on Zenodo
(doi:10.5281/zenodo.13961129), which also matches Fig. 2(e-j) of the paper:

  schedule 'lep'      -- stability-8 runs of Fig. 3 (LEP + decoder throughput), recorded 2024-06-14.
                         Two CZ layers per round, exactly Fig. 2(g),(h).
  schedule 'feedback' -- fast-feedback runs of Fig. 4 / Fig. S4, recorded 2024-07-17.
                         Same checks, but four CZ layers of two gates and RX(+pi/2) everywhere.

Stim qubit indices 0..7 are the authors' own (Zenodo) indices, so the files can be compared with
the published circuits. QUBIT_COORDS are Ankaa-2 lattice positions (col = q mod 7, row = q div 7);
the authors used 45-degree-rotated coordinates instead.

Usage:
  python -I tools/gen_circuits.py <out_dir>                 -> circuit-stability-r{5,9,25}.stim
  python -I tools/gen_circuits.py <out_dir> lep 3 7         -> circuit-stability-r3.stim, -r7.stim
  python -I tools/gen_circuits.py <out_dir> feedback 9      -> circuit-feedback-n9.stim (n = measurement rounds)
"""
import os, sys

# authors' stim index -> Ankaa-2 device qubit. Derived from the measured-qubit list stored with every
# Zenodo group ([36,38,52,50,51,43,45,37] <-> "M 0 4 3 5 2 7 1 6") and checked against the CZ
# adjacency and the authors' rotated coordinates (README.md, verify.py).
STIM_TO_DEV = {0: 36, 1: 45, 2: 51, 3: 52, 4: 38, 5: 50, 6: 37, 7: 43}
DEV_TO_STIM = {v: k for k, v in STIM_TO_DEV.items()}
ANC = [36, 38, 52, 50]          # readout order of the ancillas in every program
DATA = [51, 43, 45, 37]         # readout order of the data qubits (final round)
CHECKS = {36: (37, 43), 38: (37, 45), 50: (43, 51), 52: (45, 51)}   # ancilla -> Z_a Z_b it measures

# pulse durations in ns from the DEFCALs stored with the runs (identical on 2024-06-14 and 2024-07-17)
CZ_NS = {frozenset(p): t for p, t in [((52, 45), 68), ((50, 43), 104), ((38, 37), 112), ((52, 51), 176),
                                      ((36, 37), 104), ((50, 51), 84), ((36, 43), 104), ((38, 45), 108)]}
RX90_NS = 40
MEAS_NS = {36: 984, 38: 976, 52: 952, 50: 948, 37: 500, 43: 500, 45: 500, 51: 500}
RINGDOWN_NS = {36: 192, 38: 336, 52: 168, 50: 144}   # program DELAYs after each mid-circuit MEASURE

SCHEDULES = {
    'lep': {
        'date': '2024-06-14 (Zenodo stability_8_without_resets_raw_data.h5)',
        'prep': [('SQRT_X_DAG', [45, 51, 37, 43], 'Fig. 2(e): RX(-pi/2) on data'),
                 ('SQRT_X', [50, 52, 36, 38], 'Fig. 2(f): RX(+pi/2) on ancillas')],
        'pre': [('SQRT_X', [50, 52, 36, 38], 'Fig. 2(f): RX(+pi/2) on ancillas')],
        'cz': [([(36, 37), (38, 45), (52, 51), (50, 43)], 'Fig. 2(g)'),
               ([(37, 38), (45, 52), (51, 50), (43, 36)], 'Fig. 2(h)')],
        'post': ('SQRT_X_DAG', [36, 52, 38, 50], 'Fig. 2(i): RX(-pi/2) on ancillas'),
        'post_last': ('SQRT_X_DAG', [36, 45, 51, 52, 38, 50, 37, 43], 'final round: RX(-pi/2) on all 8'),
        'split_final_readout': True,
    },
    'feedback': {
        'date': '2024-07-17 (Zenodo fast_feedback_raw_data.h5)',
        'prep': [('SQRT_X', [36, 45, 51, 52, 38, 50, 37, 43], 'RX(+pi/2) on all 8')],
        'pre': [('SQRT_X', [50, 52, 36, 38], 'RX(+pi/2) on ancillas')],
        'cz': [([(52, 45), (50, 43)], 'CZ layer 1/4'), ([(38, 37), (52, 51)], 'CZ layer 2/4'),
               ([(36, 37), (50, 51)], 'CZ layer 3/4'), ([(36, 43), (38, 45)], 'CZ layer 4/4')],
        'post': ('SQRT_X', [36, 52, 38, 50], 'RX(+pi/2) on ancillas'),
        'post_last': ('SQRT_X', [36, 45, 51, 52, 38, 50, 37, 43], 'final round: RX(+pi/2) on all 8'),
        'split_final_readout': False,
    },
}


def s(qs):
    return ' '.join(str(DEV_TO_STIM[q]) for q in qs)


def coord(q):
    return (q % 7, q // 7)


def circuit(n, schedule='lep'):
    """n = syndrome-extraction (measurement) rounds; decoding rounds d = n - 1."""
    S = SCHEDULES[schedule]
    d = n - 1
    L = ['# Stability-8, Caune et al. (arXiv:2410.05202; Nat. Commun. 17, 7383 (2026)). Noiseless.',
         '# schedule=%s, executed on %s.' % (schedule, S['date']),
         '# syndrome-extraction (measurement) rounds n=%d; decoding rounds (detector layers) d=n-1=%d.' % (n, d),
         '# Stim index -> Ankaa-2 qubit: ' + ', '.join('%d->Q%d' % kv for kv in sorted(STIM_TO_DEV.items())),
         '# ancillas Q36,Q38,Q50,Q52 measure Z37Z43, Z37Z45, Z43Z51, Z45Z51; data Q37,Q43,Q45,Q51; '
         'Q44 (centre, X-check ancilla) unused.',
         '# QUBIT_COORDS(col,row): Ankaa-2 7-column square lattice, col = q mod 7, row = q div 7.',
         '# SQRT_X = RX(+pi/2), SQRT_X_DAG = RX(-pi/2) (up to global phase). No resets anywhere.']
    for k in range(8):
        q = STIM_TO_DEV[k]
        L.append('QUBIT_COORDS(%d, %d) %d  # Q%d %s' % (coord(q) + (k, q, 'ancilla' if q in CHECKS else 'data')))
    nrec, anc_rec = 0, []

    def gate(name, qs, why, first=False):
        if not first:
            L.append('TICK')
        L.append('# %s, %d ns' % (why, RX90_NS))
        L.append('%s %s' % (name, s(qs)))

    for r in range(1, n + 1):
        last = r == n
        L.append('# ======== syndrome-extraction round %d / %d ========' % (r, n))
        for i, (name, qs, why) in enumerate(S['prep'] if r == 1 else S['pre']):
            gate(name, qs, why, first=(r == 1 and i == 0))
        for pairs, why in S['cz']:
            L.append('TICK')
            L.append('# %s: CZ %s, %d ns (longest CZ in layer)' % (
                why, ' '.join('Q%d-Q%d' % p for p in pairs), max(CZ_NS[frozenset(p)] for p in pairs)))
            L.append('CZ ' + ' '.join('%d %d' % (DEV_TO_STIM[a], DEV_TO_STIM[b]) for a, b in pairs))
        gate(*(S['post_last'] if last else S['post']))
        L.append('TICK')
        L.append('# Fig. 2(j): MEASURE Q36,Q38,Q52,Q50 (pulses %s ns)%s' % (
            '/'.join(str(MEAS_NS[q]) for q in ANC),
            '' if last else ' then ring-down DELAY %s ns; no reset' % '/'.join(str(RINGDOWN_NS[q]) for q in ANC)))
        L.append('M ' + s(ANC))
        anc_rec.append({q: nrec + i for i, q in enumerate(ANC)})
        nrec += 4
        if last:
            if S['split_final_readout']:
                L.append('TICK')
            L.append('# final readout of the data qubits Q51,Q43,Q45,Q37 (500 ns pulses)%s; '
                     'not used by any detector or by the observable' % (
                         ', after a FENCE' if S['split_final_readout'] else ', simultaneous with the ancillas'))
            L.append('M ' + s(DATA))
            nrec += 4
        if r == 1:
            L.append('# logical observable: product of the four ZZ checks in round 1 = parity of the four '
                     'first-round ancilla outcomes (the four checks multiply to the identity)')
            L.append('OBSERVABLE_INCLUDE(0) ' + ' '.join('rec[%d]' % (anc_rec[0][q] - nrec) for q in ANC))
        else:
            # no reset: m_r = m_(r-1) xor s_r (xor const), so s_r xor s_(r-1) = m_r xor m_(r-2); round 2: m_2
            L.append('# decoding round %d: detector = m_r xor m_(r-2) for each ancilla (round 2: m_2 alone)' % (r - 1))
            for q in [52, 50, 38, 36]:   # the authors' detector order
                recs = [anc_rec[r - 1][q]] + ([anc_rec[r - 3][q]] if r >= 3 else [])
                L.append('DETECTOR(%d, %d, %d) %s  # Q%d, check Z%dZ%d' % (
                    coord(q) + (r - 2, ' '.join('rec[%d]' % (i - nrec) for i in recs), q) + CHECKS[q]))
    return '\n'.join(L) + '\n'


def main():
    out = sys.argv[1]
    args = sys.argv[2:]
    schedule = 'lep'
    if args and args[0] in SCHEDULES:
        schedule, args = args[0], args[1:]
    if schedule == 'lep':
        for d in [int(a) for a in args] or [5, 9, 25]:
            fn = 'circuit-stability-r%d.stim' % d
            open(os.path.join(out, fn), 'w', encoding='utf-8', newline='\n').write(circuit(d + 1, 'lep'))
            print('wrote', fn)
    else:
        for n in [int(a) for a in args] or [9]:
            fn = 'circuit-feedback-n%d.stim' % n
            open(os.path.join(out, fn), 'w', encoding='utf-8', newline='\n').write(circuit(n, 'feedback'))
            print('wrote', fn)


if __name__ == '__main__':
    main()
