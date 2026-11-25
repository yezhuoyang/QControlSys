"""Build schedule-qec.json: the hardware timeline of the d=5, 4-round surface-code QEC experiment
(Bluvstein et al., arXiv:2506.20661, Fig. 2) from the authors' raw AWG command strings
(anc/RawExperimentalCommands_SurfaceCodeQEC.pdf), mapped onto circuit-qec.stim.

Run:  python -I build_schedule.py      (needs pymupdf; reads anc/ and circuit-qec.stim)
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import awg_parse as A  # noqa: E402

PDF = os.path.join(HERE, 'anc', 'RawExperimentalCommands_SurfaceCodeQEC.pdf')
STIM = os.path.join(HERE, 'circuit-qec.stim')
UM_PER_SLM = {'x': 4.6, 'y': 4.9}
QUOTE_SLM = ("Coordinates are given in 'SLM units' where 1 SLM unit here is approximately 4.6um in the x "
             "direction and 4.9um in the y direction (corresponding to 7 and 7.5 units in the corresponding "
             "Supplementary Video, respectively)")

# ----------------------------------------------------------------------------- streams
sections = A.read_sections(PDF)
streams = {k: A.timed(k, v['commands']) for k, v in sections.items()}
for k, cmds in streams.items():
    t = 0.0
    for c in cmds:
        c['t_own_us'] = round(t, 4)
        t += c['duration_us']

# ----------------------------------------------------------------------------- moving AWG geometry
defs = {}
for c in streams['moving']:
    n = c['norm']
    m = re.match(r'(COMB|REPEAT_VAL|VAR)\[(\w+),\s*\[(.*)\]\]$', n)
    if not m:
        continue
    kind, name, body = m.groups()
    nums = [float(x) for x in re.findall(r'-?[\d.]+', body)]
    if kind == 'COMB':
        start, step, cnt = nums
        defs[name] = [round(start + step * i, 4) for i in range(int(cnt))]
    elif kind == 'REPEAT_VAL':
        defs[name] = [nums[0]] * int(nums[1])
    else:
        defs[name] = nums

seg = None
group = None
GROUP_FROM_NOTE = [
    ('Move data qubits to the entangling zone', 'data'),
    ('Move first ancilla set', 'ancilla_block_1'),
    ('Pick up next group', 'ancilla_block_2'),
    ('Third ancilla block', 'ancilla_block_3'),
    ('Fourth ancilla block', 'ancilla_block_4'),
    ('Move data back to storage', 'data'),
    ('SSR on half, 1.2 ms', 'ssr_half_1'),
    ('SSR on half, 1.23 ms', 'ssr_half_2'),
]
prev_pos = None
for c in streams['moving']:
    n = c['norm']
    if n.startswith('SEGMENT['):
        seg = int(re.findall(r'\d+', n)[0])
        group = {1: 'clear_entangling_zone', 4: 'ancilla_block_1', 6: None}.get(seg, group)
    if n.upper().startswith('NOTE['):
        for key, g in GROUP_FROM_NOTE:
            if key in n:
                group = g
    c['segment'] = seg
    c['aod_group'] = group
    if c.get('name', '').upper() != 'MOVEAOD':
        continue
    m = re.match(r'MoveAOD\[(Initial\[)?\[?\s*(\w+)\s*,\s*(\w+)\s*\]', n)
    xn, yn = m.group(2), m.group(3)
    sh = re.search(r'SHIFT\[\[(-?[\d.]+)\],\[(-?[\d.]+)\]\]', n)
    sx, sy = (float(sh.group(1)), float(sh.group(2))) if sh else (0.0, 0.0)
    xs = [round(v + sx, 4) for v in defs[xn]]
    ys = [round(v + sy, 4) for v in defs[yn]]
    fp = re.search(r'FinalPows\[(\w+),\s*(\w+)\]', n)
    ip = re.search(r'InitialPows\[(\w+),\s*(\w+)\]', n)
    c['aod'] = {'x_comb': xn, 'y_comb': yn, 'shift_slm': [sx, sy], 'x_slm': xs, 'y_slm': ys,
                'initial_pows': [ip.group(1), ip.group(2)] if ip else None,
                'final_pows': [fp.group(1), fp.group(2)] if fp else None}
    initial = m.group(1) is not None
    if initial or prev_pos is None:
        kind = 'ramp'
        disp = None
    else:
        if len(xs) == len(prev_pos[0]) and len(ys) == len(prev_pos[1]):
            dx = max(abs(a - b) for a, b in zip(xs, prev_pos[0]))
            dy = max(abs(a - b) for a, b in zip(ys, prev_pos[1]))
            disp = (dx, dy)
        else:
            disp = None
        moved = disp is None or disp[0] > 1e-9 or disp[1] > 1e-9
        kind = 'move' if moved else ('ramp' if fp else 'wait')
    c['kind'] = kind
    if disp is not None and kind == 'move':
        dist = math.hypot(disp[0] * UM_PER_SLM['x'], disp[1] * UM_PER_SLM['y'])
        c['displacement_um'] = {'dx': round(disp[0] * UM_PER_SLM['x'], 3), 'dy': round(disp[1] * UM_PER_SLM['y'], 3),
                                'max_tone_distance': round(dist, 3),
                                'mean_speed_um_per_us': round(dist / c['duration_us'], 4)}
    prev_pos = (xs, ys)

# Moving clock: t = 0 at SEGMENT[4] ('### Start of circuit').  Segments 1-2 are placed back-to-back
# before it (SEGMENT[1] actually loops until the trigger); SEGMENT[6] is placed after the Raman
# bright-state transfer has finished (see below).
mv = streams['moving']
t4 = next(c['t_own_us'] for c in mv if c['norm'].startswith('SEGMENT[4]'))
t6_own = next(c['t_own_us'] for c in mv if c['norm'].startswith('SEGMENT[6]'))
for c in mv:
    c['t_us'] = round(c['t_own_us'] - t4, 4)

# ----------------------------------------------------------------------------- CZ anchors and offsets
seg4 = [c for c in mv if c['segment'] == 4]
mv_cz = [c for c in seg4 if c['name'].upper() == 'WAIT' and abs(c['duration_us'] - 10) < 1e-9]
assert len(mv_cz) == 16, len(mv_cz)
mv_cz_c = [c['t_us'] + 5.0 for c in mv_cz]

ry = streams['rydberg']
ry_p = [c for c in ry if c['name'].upper() == 'PULSE']
assert len(ry_p) == 16
ry_c = [c['t_own_us'] + c['duration_us'] / 2 for c in ry_p]

ra = streams['raman']
ra_circ0 = next(i for i, c in enumerate(ra) if c['norm'].startswith('### Start of circuit'))
ra_E = [c for c in ra[ra_circ0:] if c['name'] == 'E' and abs(c['duration_us'] - 397.968) < 1e-6]
assert len(ra_E) == 18, len(ra_E)
ra_E_cz = ra_E[1:-1]
ra_c = [c['t_own_us'] + c['duration_us'] / 2 for c in ra_E_cz]

ao = streams['raman_aod']
ao_circ0 = next(i for i, c in enumerate(ao) if c['norm'].startswith('### Start of circuit'))
ao_W = [c for c in ao[ao_circ0:] if c['name'].upper() == 'WAIT' and 397 < c['duration_us'] < 399]
assert len(ao_W) == 17, len(ao_W)
ao_W_cz = ao_W[1:]
ao_c = [c['t_own_us'] + c['duration_us'] / 2 for c in ao_W_cz]


def fit(own):
    off = sum(m - o for m, o in zip(mv_cz_c, own)) / len(own)
    res = [round(m - (o + off), 3) for m, o in zip(mv_cz_c, own)]
    return off, res


offsets, residuals = {}, {}
for key, own in (('rydberg', ry_c), ('raman', ra_c), ('raman_aod', ao_c)):
    offsets[key], residuals[key] = fit(own)
    for c in streams[key]:
        c['t_us'] = round(c['t_own_us'] + offsets[key], 4)

# SEGMENT[6] placement (assumption): starts when the Raman string (bright-state transfer) ends.
raman_end = ra[-1]['t_us'] + ra[-1]['duration_us']
for c in mv:
    if c['segment'] == 6:
        c['t_us'] = round(c['t_own_us'] - t6_own + raman_end, 4)
    if c['segment'] in (1,):
        c['t_us'] = None  # loops until trigger

# ----------------------------------------------------------------------------- Raman-AOD slots
slots = []
state = None
for c in ao:
    U = c.get('name', '').upper()
    if re.fullmatch(r'R\d_.*', U):
        state = c['name']
    elif U == 'TURNOFF':
        state = None
    elif U == 'TIME':
        slots.append({'t_us': c['t_us'], 'rows': state})

LOCAL_SLOT = A.RAMAN_LOCAL_SLOT_US
for c in ra:
    U = c.get('name', '').upper()
    if not U.startswith('SC1') or U == 'SC1_ECHO':
        continue
    n = int(A._args(c['norm'])[5])
    lit = []
    for i in range(n):
        t = c['t_us'] + (i + 0.5) * LOCAL_SLOT
        best = min(slots, key=lambda s: abs(s['t_us'] + A.RAMAN_AOD_SLOT_US / 2 - t))
        dt = best['t_us'] + A.RAMAN_AOD_SLOT_US / 2 - t
        lit.append(best['rows'] if abs(dt) < 2.0 else None)
    c['aod_rows_per_slot'] = lit
    c['dummy'] = all(r is None for r in lit)

# ----------------------------------------------------------------------------- Stim labelling
stim_lines = open(STIM).read().splitlines()
DATA = {10 * r + c + 2 for r in range(5) for c in range(5)}
ALLQ = set(range(49))
labels = []  # (line_no, tick_layer, gap, label, op)
tick = 0
gap = 0
for i, ln in enumerate(stim_lines, start=1):
    op = ln.split(' ')[0]
    tg = [int(x) for x in ln.split()[1:] if x.isdigit()]
    if op == 'TICK':
        tick += 1
        continue
    if op == 'CZ':
        gap += 1
        lab = 'cz'
    elif op in ('SQRT_Y', 'SQRT_Y_DAG'):
        lab = 'rot_data' if set(tg) <= DATA else 'rot_anc'
    elif op == 'Y':
        lab = 'pi_global' if set(tg) == ALLQ else 'pi_anc'
    elif op == 'I':
        lab = 'idle'
    else:
        lab = op.lower()
    labels.append({'line': i, 'tick_layer': tick, 'gap': gap, 'label': lab, 'op': ln if len(ln) < 60 else ln[:57] + '...',
                   'ntargets': len(tg)})

# refine the no-op 'I' markers: reset/measure markers, CZ markers, and the four idle kinds
for j, L in enumerate(labels):
    if L['label'] != 'idle':
        continue
    prev = labels[j - 1]['label'] if j else None
    nxt = labels[j + 1]['label'] if j + 1 < len(labels) else None
    if prev == 'r':
        L['label'] = 'marker_reset'
    elif nxt == 'm':
        L['label'] = 'marker_measure'
    elif prev == 'cz':
        L['label'] = 'marker_cz'
    elif nxt == 'r':
        L['label'] = 'idle_exchange_in'
    elif nxt == 'cz':
        L['label'] = 'idle_before_cz'
    elif prev == 'marker_cz':
        L['label'] = 'idle_after_cz'
    elif nxt == 'pi_global':
        L['label'] = 'idle_exchange_out'

by_gap = {}
for L in labels:
    by_gap.setdefault(L['gap'], []).append(L)


def stim_for(gap_idx, label):
    return [L for L in by_gap.get(gap_idx, []) if L['label'] == label]


def gap_of(t):
    return sum(1 for x in mv_cz_c if x <= t)


def layer_of_gap(g, t=None):
    """TICK layer (0..8) for hardware time in CZ-gap g (gap 4k..4k+4 belongs to round k+1)."""
    if g == 0:
        return 1 if t is None or t >= 0 else 0
    return 2 * ((g - 1) // 4) + 1


# Raman pulses -> Stim lines, matched in order within each CZ gap and category
cat_used = {}
for c in ra:
    U = c.get('name', '').upper()
    if c['t_us'] is None:
        continue
    g = gap_of(c['t_us'])
    c['gap'] = g
    cat = None
    if U.startswith('SC1') and U != 'SC1_ECHO':
        if c['dummy']:
            cat = None
        else:
            rows = [r for r in c['aod_rows_per_slot'] if r]
            is_data = all(r.endswith('_d') or r.endswith('_Ad') for r in rows)
            is_pi = U.startswith('SC1PI')
            cat = 'pi_anc' if is_pi else ('rot_data' if is_data else 'rot_anc')
    elif U == 'SC1_ECHO':
        cat = 'pi_global'
    c['stim'] = []
    if cat is None:
        continue
    cands = stim_for(g, cat)
    k = cat_used.get((g, cat), 0)
    if cat == 'rot_data':
        c['stim'] = [x['line'] for x in cands]  # both 3-row halves realize the same Stim line
    elif k < len(cands):
        c['stim'] = [cands[k]['line']]
        cat_used[(g, cat)] = k + 1

# Check: every Stim rotation / global-pi line is realized by at least one Raman pulse
realized = {ln for c in ra for ln in c.get('stim', [])}
unrealized = [L for L in labels if L['label'] in ('rot_data', 'rot_anc', 'pi_anc', 'pi_global') and L['line'] not in realized]

# ----------------------------------------------------------------------------- merged steps
steps = []


def add(awg, c, kind, extra=None):
    s = {'awg': awg, 'kind': kind, 't_start_us': c['t_us'], 'duration_us': round(c['duration_us'], 4),
         'details': c['text'], 'duration_rule': c['duration_rule']}
    if extra:
        s.update(extra)
    steps.append(s)
    return s


cz_lines = [L['line'] for L in labels if L['label'] == 'cz']
label_of = {L['line']: L['label'] for L in labels}
cz_with_marker = [[ln] + ([ln + 1] if label_of.get(ln + 1) == 'marker_cz' else []) for ln in cz_lines]
for c in mv:
    U = c.get('name', '').upper()
    if c['comment'] or U in ('COMB', 'REPEAT_VAL', 'VAR', 'SAVE_PREVIOUS', 'END_COMMAND'):
        continue
    if U in ('NOTE', 'SEGMENT'):
        add('moving', c, 'other', {'segment': c['segment'], 'note': 'annotation, 0 us'})
        continue
    extra = {'segment': c['segment'], 'aod_group': c['aod_group']}
    if U == 'MOVEAOD':
        extra['aod'] = c['aod']
        if 'displacement_um' in c:
            extra['displacement_um'] = c['displacement_um']
        kind = c['kind']
    else:
        kind = 'wait'
    s = add('moving', c, kind, extra)
    if c in mv_cz:
        n = mv_cz.index(c)
        s['cz_index'] = n
        s['note'] = 'AOD held at gate positions while the Rydberg CZ pulse fires (see the rydberg step with the same cz_index)'
        s['stim_lines'] = cz_with_marker[n]
for n, c in enumerate(ry_p):
    add('rydberg', c, 'rydberg', {'cz_index': n, 'round': n // 4 + 1, 'layer_in_round': n % 4 + 1,
                                   'stim_lines': cz_with_marker[n],
                                   'note': 'Global 420/1013-nm CZ pulse (270 ns gate, Methods) + local SLM detuning; segment length 2.2 us inferred'})
for c in ra:
    U = c.get('name', '').upper()
    if c['comment'] or U in ('E', 'Z', 'SEGMENTBREAK', 'END_COMMAND'):
        continue
    if U == 'SC1_ECHO' or U.startswith('BB1') or U.startswith('CPROBUST'):
        kind = 'raman_global'
    elif U.startswith('SC1'):
        kind = 'raman_local'
    else:
        kind = 'other'
    extra = {}
    if 'aod_rows_per_slot' in c:
        extra['raman_aod_rows_per_slot'] = c['aod_rows_per_slot']
        if c['dummy']:
            extra['note'] = 'Raman-AOD tones are off for the whole pulse: no atom is addressed ("fake" pulse kept for timing/echo symmetry)'
    if c.get('stim'):
        extra['stim_lines'] = c['stim']
    elif U == 'SC1_ECHO':
        extra['note'] = 'global Y(pi) echo on all atoms; not represented in the Stim file (only flips signs of stabilizers)'
    if U.startswith('SMOOTHPUMPING'):
        extra['note'] = 'Raman-assisted optical pumping of all atoms into |0> before the circuit (realizes the Stim R instructions)'
        extra['stim_lines'] = [L['line'] for L in labels if L['label'] in ('r', 'marker_reset')]
    if U.startswith('BB1') or U.startswith('CPROBUST'):
        if c['t_us'] > 0:
            extra['note'] = 'bright-state transfer for spin-to-position readout (Methods: coherent Raman transfer used for all surface-code experiments)'
            extra['stim_lines'] = [L['line'] for L in labels if L['label'] in ('m', 'marker_measure')]
        else:
            extra['note'] = 'state preparation before the circuit'
    add('raman', c, kind, extra)

# readout image (not part of the AWG strings)
ssr_end = max(c['t_us'] + c['duration_us'] for c in mv if c['segment'] == 6)
steps.append({'awg': 'camera', 'kind': 'image', 't_start_us': round(ssr_end, 4), 'duration_us': None,
              'details': 'camera image of atom positions after spin-to-position conversion (not in the command strings; '
                         'exposure for this experiment not stated)',
              'stim_lines': [L['line'] for L in labels if L['label'] in ('m', 'marker_measure')], 'duration_rule': 'unknown'})

# moving steps -> Stim lines and TICK layers
round_first_cz = [mv_cz_c[4 * k] for k in range(4)]
round_last_cz = [mv_cz_c[4 * k + 3] for k in range(4)]
pick_times = [0.0] + [c['t_us'] for c in mv if c['segment'] == 4 and c['norm'].startswith('MoveAOD[Initial[x_st,y_st]')]
data_back_t = next(c['t_us'] for c in mv if 'Move data back to storage' in c['norm'])
m_lines = [L['line'] for L in labels if L['label'] in ('m', 'marker_measure')]
m_data_line = [L['line'] for L in labels if L['label'] == 'm'][-1]


def lines_of(label, layer):
    return [L['line'] for L in labels if L['label'] == label and L['tick_layer'] == layer]


def round_of(t):
    k = 0
    for i, pt in enumerate(pick_times):
        if t >= pt - 1e-9:
            k = i
    return k + 1


for s in steps:
    t = s['t_start_us']
    if s['awg'] != 'moving':
        if s.get('stim_lines'):
            s['maps_to_tick'] = next(L['tick_layer'] for L in labels if L['line'] == s['stim_lines'][0])
        elif s['awg'] == 'camera':
            s['maps_to_tick'] = 8
        elif t is not None and t >= 0:
            s['maps_to_tick'] = 2 * round_of(t) - 1
        else:
            s['maps_to_tick'] = 0 if (t is not None and s['awg'] == 'raman' and s['kind'] == 'raman_global' and t > -100) else None
        continue
    seg = s.get('segment')
    if seg in (1, 2) or t is None:
        s['maps_to_tick'] = None
        s['stim_note'] = 'before the circuit: loading/clearing and placing data + first ancilla block (no Stim operation)'
        continue
    if seg == 6:
        s['maps_to_tick'] = 8
        s['stim_lines'] = m_lines
        s['stim_note'] = 'spin-to-position conversion of all atoms (realizes every Stim M; the Stim file places each ancilla M at the end of its round because the block idles in storage until this final readout)'
        continue
    if t >= data_back_t - 1e-9:
        s['maps_to_tick'] = 8
        s['stim_lines'] = [m_data_line]
        s['stim_note'] = 'data block returns to storage/readout zone before the final measurement (no Stim operation besides M)'
        continue
    k = round_of(t)
    layer = 2 * k - 1
    s['maps_to_tick'] = layer
    if 'stim_lines' in s:            # CZ hold (Wait[10 us])
        continue
    aod = s.get('aod')
    if s['kind'] == 'wait':
        lines = set()
        for o in steps:
            if o['awg'] == 'raman' and o.get('stim_lines') and o['t_start_us'] is not None:
                a, b = o['t_start_us'], o['t_start_us'] + o['duration_us']
                if min(b, t + s['duration_us']) - max(a, t) > 1.0 and (o['kind'] == 'raman_local' or (o['kind'] == 'raman_global' and o['duration_us'] < 100)):
                    lines |= set(o['stim_lines'])
        if lines:
            s['stim_lines'] = sorted(lines)
            s['stim_note'] = 'AOD hold while local Raman pulses act (see the overlapping raman steps)'
        continue
    at_gate_comb = aod is not None and aod['x_comb'] == 'xanc_ent' and aod['y_comb'] == 'yanc_ent'
    if s['kind'] == 'move' and at_gate_comb and aod['shift_slm'] != [0.0, 0.0]:
        s['stim_lines'] = [L['line'] for L in labels if L['label'] == 'idle_before_cz' and L['gap'] == gap_of(t)]
        s['stim_note'] = 'ancilla grid moves from its home sites to the next gate sites: realized in Stim as the idle before the CZ'
    elif s['kind'] == 'move' and at_gate_comb and aod['shift_slm'] == [0.0, 0.0] and t > round_first_cz[k - 1]:
        s['stim_lines'] = [L['line'] for L in labels if L['label'] == 'idle_after_cz' and L['gap'] == gap_of(t)]
        s['stim_note'] = 'ancilla grid returns to its home sites after the CZ: realized in Stim as the idle after the CZ'
    elif t < round_first_cz[k - 1]:
        s['stim_lines'] = lines_of('idle_exchange_in', layer)
        s['stim_note'] = 'ancilla block brought from storage to the entangling zone: realized in Stim as the exchange-in idle of this round'
    else:
        s['stim_lines'] = lines_of('idle_exchange_out', layer)
        s['stim_note'] = 'used ancilla block returned to storage: realized in Stim as the exchange-out idle of this round'

steps.sort(key=lambda s: (s['t_start_us'] if s['t_start_us'] is not None else -1e9))
for i, s in enumerate(steps):
    s['id'] = f'qec-{i:04d}'

# ----------------------------------------------------------------------------- totals
pick = [c['t_us'] for c in mv if c['segment'] == 4 and c['norm'].startswith('MoveAOD[Initial[x_st,y_st]')]
data_back = next(c['t_us'] for c in mv if 'Move data back to storage' in c['norm'])
round_windows = [(0.0, pick[0]), (pick[0], pick[1]), (pick[1], pick[2]), (pick[2], data_back)]
per_round = []
for k, (a, b) in enumerate(round_windows):
    tot = {}
    for s in steps:
        if s['awg'] != 'moving' or s['t_start_us'] is None or not (a <= s['t_start_us'] < b):
            continue
        tot[s['kind']] = round(tot.get(s['kind'], 0) + s['duration_us'], 3)
    ryd = [s for s in steps if s['awg'] == 'rydberg' and a <= s['t_start_us'] < b]
    rl = [s for s in steps if s['awg'] == 'raman' and s['kind'] == 'raman_local' and a <= s['t_start_us'] < b]
    rg = [s for s in steps if s['awg'] == 'raman' and s['kind'] == 'raman_global' and a <= s['t_start_us'] < b]
    per_round.append({
        'round': k + 1, 'window_us': [round(a, 3), round(b, 3)], 'moving_awg_total_us': round(b - a, 3),
        'moving_awg_by_kind_us': tot,
        'rydberg_pulses': len(ryd),
        'raman_local_pulses': len(rl), 'raman_local_pulses_addressing_atoms': sum(1 for s in rl if 'fake' not in s.get('note', '')),
        'raman_local_time_us': round(sum(s['duration_us'] for s in rl), 3),
        'raman_global_pulses': len(rg),
        'note': ('round 1 window starts at SEGMENT[4] (ancilla block 1 was already brought in by SEGMENT[2]); '
                 'its pick-up (1.25 ms equivalent) is in the pre-circuit segment') if k == 0 else
                ('window ends where the data block starts its return to storage' if k == 3 else
                 'window = pick-up of this ancilla block until pick-up of the next one'),
    })


def own_markers(key):
    out = []
    for c in streams[key]:
        if c['comment']:
            out.append({'t_own_us': c['t_own_us'], 'marker': c['text']})
    return out


cz_periods = {
    'moving': [round(b - a, 3) for a, b in zip(mv_cz_c, mv_cz_c[1:])],
    'rydberg_inferred_pulse': [round(b - a, 3) for a, b in zip(ry_c, ry_c[1:])],
    'raman': [round(b - a, 3) for a, b in zip(ra_c, ra_c[1:])],
    'raman_aod': [round(b - a, 3) for a, b in zip(ao_c, ao_c[1:])],
}
round_period = {k: [round(v[4 * i + 3] + v[4 * i + 2] + v[4 * i + 1] + v[4 * i], 3) for i in range(3)]
                for k, v in cz_periods.items()}

# ----------------------------------------------------------------------------- geometry
def comb(name):
    return defs[name]


geometry = {
    'units': 'SLM units unless stated; x_um = 4.6 * x_slm, y_um = 4.9 * y_slm (approximate, quote below)',
    'um_per_slm_unit': UM_PER_SLM,
    'um_per_slm_unit_quote': QUOTE_SLM,
    'supplementary_video_unit_quote': 'One unit on the x/y axes corresponds to approximately 0.66 um.',
    'aod_comb_definitions_verbatim': [c['text'] for c in mv if c.get('name') in ('COMB', 'REPEAT_VAL', 'VAR')],
    'aod_comb_values': defs,
    'zones': {
        'entangling': {
            'y_slm': [0, 12], 'y_um_approx': [0, 58.8],
            'gate_site_rows_y_slm': [0, 2, 4, 6, 8, 10, 12],
            'data_sites': 'data (r,c) at x = 16 + 3c, y = 2 + 2r (inferred: data occupy x tones 1..5 of xd_ent=COMB[13,3,6] and y tones 0..4 of yd_ent=COMB[2,2,6])',
            'ancilla_home': 'ancilla at plaquette centre (ra,ca) sits at x = 16.36 + 3ca, y = 2 + 2ra (xanc_ent=COMB[14.86,3,6], yanc_ent=COMB[1,2,6]); during a CZ layer the whole ancilla grid is shifted by SHIFT[[dx],[dy]]',
            'quotes': ['The 420-nm and 1013-nm Rydberg tophat beams cover 7 rows of gate sites in the entangling zone and are homogenized to ≈ 1% peak-to-peak variation over a vertical extent of 60 μm.',
                       'The entangling zone is separated by 40 μm from the storage and readout zone (overlapping in these measurements) to ensure negligible error on stored qubits from the tails of the Rydberg beams.'],
            'section': 'Methods / Details of processor configuration / Surface code',
        },
        'storage_and_readout': {
            'y_slm': [20, 30.9], 'y_um_approx': [98, 151.4],
            'atom_rows_y_slm': comb('y_st'),
            'note': 'storage and readout zones overlap in the surface-code experiments; each atom row has a second trap row 1 SLM unit (4.9 um) below/above it for spin-to-position readout (SSR moves shift dark atoms by dy=-1)',
            'block_x_offsets_slm': {'data': 0.0, 'ancilla_block_1': 1.0, 'ancilla_block_2': 1.938,
                                    'ancilla_block_3': 17.959, 'ancilla_block_4': 18.972,
                                    'ancilla_block_5_unused': 'not addressed in the command string'},
            'block_x_formula': 'x = x_st[k] + offset, x_st = COMB[-0.98,3,6] (6 tones, pitch 3 SLM = 13.8 um): six blocks interlaced column-by-column',
            'quotes': ['For surface code experiments (Figs. 1-3), the same static traps are used for mid-circuit storage of ancilla blocks and for readout of all qubits at the end of the computation. The readout zone is 12 rows tall (55 μm) with two rows of traps per atom for the lattice readout, Fig. 2a. Six blocks of qubits are interlaced horizontally for storage, corresponding to five (four) 6x6 ancilla blocks and one (two) 5x5 data block(s) in Fig. 2(3).',
                       'Two additional columns of traps form a small reservoir used for initial rearrangement, resulting in a total array width of 165 μm.'],
            'section': 'Methods / Details of processor configuration / Surface code',
        },
        'reservoir': 'two extra trap columns (initial rearrangement only)',
    },
    'cz_layer_shifts_slm': {
        'a': {'shift': [-1.5, 1], 'partner': '(ra+.5, ca-.5)'},
        'b': {'shift': [-1.5, -1], 'partner': '(ra-.5, ca-.5)'},
        'c': {'shift': [0.78, 1], 'partner': '(ra+.5, ca+.5)', 'round1_value': [0.75, 1]},
        'd': {'shift': [0.78, -1], 'partner': '(ra-.5, ca+.5)'},
        'round_orders': {'1': 'abcd', '2': 'acbd', '3': 'dbca', '4': 'dcba'},
        'gate_pair_separation': 'ancilla-data separation at a gate site = 0.36 SLM units in x (= 1.66 um; 0.39 units = 1.79 um for the round-1 c layer), 0 in y',
        'derivation': 'The Stim CZ layers (verify.txt) touch, for ancilla (ra,ca): a->(ra+.5,ca-.5), b->(ra-.5,ca-.5), c->(ra+.5,ca+.5), d->(ra-.5,ca+.5). The Moving-AWG round orders [(-1.5,1),(-1.5,-1),(.75,1),(.78,-1)], [(-1.5,1),(.78,1),(-1.5,-1),(.78,-1)], [(.78,-1),(-1.5,-1),(.78,1),(-1.5,1)], [(.78,-1),(.78,1),(-1.5,-1),(-1.5,1)] match the Stim orders abcd, acbd, dbca, dcba only under a=(-1.5,+1), b=(-1.5,-1), c=(+.78,+1), d=(+.78,-1).',
    },
    'raman_aod_rows': 'rN_* = row N of the Raman-AOD light grid (positions/powers loaded from repetitiveQEC_d5_variables.txt, not published). Suffixes: _Ad data sublattice A; _d data; _a ancillas; _nl/_nr no left/right edge; _l/_r left/right edge only. Inferred: ancilla row N = ra + 0.5; r1_r_a -> Stim 11, r3_r_a -> 31, r2_l_a -> 17, r4_l_a -> 37, r0_a -> {0,1} (+row-0 bulk), r5_a -> {47,48} (+row-5 bulk).',
}

qubits = []
for q in range(49):
    if q in DATA:
        r, c = (q - 2) // 10, (q - 2) % 10
        qubits.append({'stim_index': q, 'role': 'data', 'lattice_rc': [r, c],
                       'entangling_slm': [16 + 3 * c, 2 + 2 * r],
                       'entangling_um': [round(4.6 * (16 + 3 * c), 2), round(4.9 * (2 + 2 * r), 2)],
                       'storage_slm': [round(-0.98 + 3 * (c + 1), 3), round(21 + 1.98 * r, 3)],
                       'sublattice': 'A' if (r + c) % 2 == 0 else 'B'})
sys.path.insert(0, HERE)
import gen_surface as G  # noqa: E402
pmap = G.published_index_map()
P5 = G.Patch(5, 5, pmap)
for (ra_, ca_, typ) in P5.anc:
    q = pmap[(ra_, ca_)]
    qubits.append({'stim_index': q, 'role': 'ancilla', 'css_type': typ, 'plaquette_centre_rc': [ra_, ca_],
                   'weight': len(P5.partners[(ra_, ca_)]),
                   'partners_by_layer': {L: pmap[d] for L, d in P5.partners[(ra_, ca_)].items()},
                   'entangling_home_slm': [round(16.36 + 3 * ca_, 3), 2 + 2 * ra_],
                   'storage_slm_by_block': {f'block_{b}': [round(-0.98 + 3 * (ca_ + 0.5) + off, 3), round(21 + 1.98 * (ra_ + 0.5), 3)]
                                            for b, off in ((1, 1.0), (2, 1.938), (3, 17.959), (4, 18.972))},
                   'note': 'the Stim file re-uses this index for the 4 physical ancilla blocks (one fresh 24-atom block per round)'})
qubits.sort(key=lambda x: x['stim_index'])

# ----------------------------------------------------------------------------- output
out = {
    'experiment': 'd=5 rotated (XZZX-form) surface code, 4 rounds of stabilizer measurement, X basis (Bluvstein et al., arXiv:2506.20661, Fig. 2; Nature 649, 39-46 (2025))',
    'source': 'anc/RawExperimentalCommands_SurfaceCodeQEC.pdf (arXiv ancillary file) + anc/Stim_circuit_repeated_QEC_Xbasis.txt',
    'stim_file': 'circuit-qec.stim',
    'clock': 't_start_us is on the Moving-AWG clock, t=0 at SEGMENT[4] ("### Start of circuit"). Other AWGs are placed by a single constant offset each, fitted so that their 16 CZ anchors coincide with the 16 Moving-AWG Wait[10 us] slots (residuals below). SEGMENT[1] loops until the trigger (t_start_us=null); SEGMENT[2] is placed back-to-back before t=0; SEGMENT[6] (readout) is placed at the end of the Raman string (end of the bright-state transfer) -- an assumption, its trigger time is not given.',
    'maps_to_tick_definition': 'index of the TICK-delimited layer of circuit-qec.stim containing the realized operation: 0 = data preparation, 1/3/5/7 = QEC rounds 1-4, 2/4/6 = empty layers between the double TICKs, 8 = final data rotation + measurement. The published file has only 8 TICKs (no per-CZ TICK); stim_lines gives the exact line(s) of circuit-qec.stim (1-based).',
    'kinds': {'move': 'AOD grid changes position', 'ramp': 'AOD tone powers ramp at fixed position (pick-up / drop-off / gate power)',
              'wait': 'AOD holds (Moving-AWG Wait or hold)', 'rydberg': 'global Rydberg CZ pulse', 'raman_local': 'locally addressed Raman pulse (Raman AWG + Raman-AOD tones)',
              'raman_global': 'global Raman pulse', 'image': 'camera image', 'other': 'annotation, segment marker, optical pumping'},
    'duration_rules': A.DURATION_RULES,
    'stream_alignment': {
        'offset_us_to_moving_clock': {k: round(v, 3) for k, v in offsets.items()},
        'cz_anchor_residuals_us': residuals,
        'anchors': 'moving: centre of each Wait[10 us] in SEGMENT[4]; rydberg: centre of each Pulse[]; raman: centre of each E[397.968 us] that brackets a CZ (all but the first and last); raman_aod: centre of each WAIT[398.02/397.99 us] after the first',
        'cz_to_cz_periods_us': cz_periods,
        'round_period_us_from_cz_periods': round_period,
    },
    'totals': {
        'per_round': per_round,
        'paper_round_time': {'value_ms': 4.45, 'quote': 'In the repeated surface code experiments in Figure 2, each QEC round was 4.45 ms. This originated from 0.47 ms time between gates, and a total of 2.57 ms from moving the ancilla atoms to the storage zone and bringing in the next group to the entangling zone.', 'section': 'Methods / Processor clock speed'},
        'reconciliation': (
            'Moving AWG: rounds 2-4 are each exactly 4450 us = 4 x 470 us (0.195 ms move + 10 us CZ hold + 0.195 ms move + 70 us local-gate hold) '
            '+ 2570 us exchange (1250 us return of the used block: 0.1+0.4+0.4+0.1+0.25 ms; 1250 us pick-up of the next block: 0.25+0.1+0.4+0.4+0.1 ms; one 70 us hold before the first CZ). '
            'This reproduces the paper (4 x 0.47 + 2.57 = 4.45 ms). Rydberg AWG: 4 x (Pulse + Wait[467.800 us]) + Wait[2570.02 us] = 4450.02 us with the inferred 2.2 us pulse segment. '
            'Raman AWG: 4449.164 us between round markers of rounds 2-3 (0.84 us short; individual CZ periods are 467.784 / 471.784 us, i.e. up to +-1.8 us local slip against the 470 us Moving period; the Raman string is one phase-continuous waveform). '
            'Raman AOD AWG: 4449.80 us. Round 1 differs by construction: the first ancilla block is brought in before the circuit (SEGMENT[2]) and round 1 begins with the data pi/2, fake ancilla pi/2 and a 76 us global echo instead of a pick-up. '
            'Text notes inside the command string disagree with its own durations: "Exchanging the ancilla arrays is currently given 1 ms total time" (commands: 2 x 1.25 ms), '
            '"Move data back to storage zone, 1.2 ms" (commands: 1.85 ms), "SSR on half, 1.2 ms" / "1.23 ms" (commands: 2.1 / 1.9 ms incl. waits).'),
        'circuit_totals_us': {
            'segment4_moving': round(data_back - 0.0, 3),
            'data_return_to_storage': round(sum(c['duration_us'] for c in mv if c['segment'] == 4 and c['t_us'] >= data_back), 3),
            'segment6_ssr_moving': round(sum(c['duration_us'] for c in mv if c['segment'] == 6), 3),
            'raman_bright_state_transfer': round(sum(c['duration_us'] for c in ra if c['t_us'] is not None and c['t_us'] > data_back - 2000 and (c['name'] in ('E',) and c['duration_us'] > 1000 or c['name'].startswith('BB1') or c['name'].startswith('CPROBUST'))), 3),
        },
        'stim_idle_model': 'original-noisy.stim idles 2 x 235 us per CZ gap (= 470 us) and 2 x 1285 us per block exchange (= 2570 us), i.e. 3 x 470 + 2 x 235 + 2 x 1285 = 4450 us per round: the noise model uses exactly the hardware timing (verify.txt).',
    },
    'geometry': geometry,
    'qubits': qubits,
    'stim_line_labels': labels,
    'stim_lines_not_realized_by_a_raman_pulse': unrealized,
    'steps': steps,
    'awg_streams': {k: {'preamble_prose_verbatim': sections[k]['preamble_prose'],
                        'commands': [{'t_own_us': c['t_own_us'], 't_us': c.get('t_us'), 'duration_us': round(c['duration_us'], 4),
                                      'duration_rule': c['duration_rule'], 'text': c['text']} for c in streams[k]]}
                    for k in streams},
}
with open(os.path.join(HERE, 'schedule-qec.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
print('steps', len(steps), 'offsets', {k: round(v, 3) for k, v in offsets.items()})
print('residuals', residuals)
print('round periods', round_period)
print('unrealized stim lines', [(u['line'], u['op']) for u in unrealized])
for r in per_round:
    print(r['round'], r['moving_awg_total_us'], r['moving_awg_by_kind_us'], r['rydberg_pulses'], r['raman_local_pulses'], r['raman_global_pulses'])
