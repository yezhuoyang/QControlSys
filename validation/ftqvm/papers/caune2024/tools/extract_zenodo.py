"""Extract the published Stim circuits, Quil programs and calibration timings
from the text content of the Zenodo HDF5 files (doi:10.5281/zenodo.13961129).

h5py is not available in this environment, so each HDF5 file was streamed through
tools/text_runs.py, which keeps every run of >= 24 printable characters with its newlines
(zenodo/ff_runs.txt, zenodo/main_runs.txt). HDF5 stores variable-length strings contiguously
in global-heap collections, so the Stim circuits and Quil programs come out intact;
this script splits them apart. (It also accepts a plain `strings` dump.)

Usage: python -I tools/extract_zenodo.py <strings-or-runs.txt> <out_dir> <label>
Writes <out_dir>/<label>_groups.json and one .stim / .quil file per experiment group.
"""
import json, os, re, sys

QUBITS = [36, 37, 38, 43, 45, 50, 51, 52]
PAIRS = [(52, 45), (50, 43), (38, 37), (52, 51), (36, 37), (50, 51), (36, 43), (38, 45)]


def read_lines(path):
    with open(path, encoding='latin-1') as f:
        return f.read().split('\n')


def stim_blocks(lines):
    """Contiguous runs of Stim instructions starting at QUBIT_COORDS."""
    stim_re = re.compile(r'^(QUBIT_COORDS|TICK|SQRT_X|SQRT_X_DAG|CZ|M |MX|R |RX|DETECTOR|OBSERVABLE_INCLUDE|S |H |X_ERROR|DEPOLARIZE|REPEAT|\})')
    out, i = [], 0
    while i < len(lines):
        if lines[i].startswith('QUBIT_COORDS'):
            j = i
            while j < len(lines) and stim_re.match(lines[j]):
                j += 1
            out.append((i, '\n'.join(lines[i:j]) + '\n'))
            i = j
        else:
            i += 1
    return out


def quil_programs(lines):
    """Main programs start with the DECLARE block and end before the next non-Quil junk."""
    out, i = [], 0
    while i < len(lines):
        if lines[i].startswith('DECLARE ') and (i == 0 or not lines[i - 1].startswith('DECLARE ')):
            j = i
            if '=====RUN=====' in lines:   # text_runs.py output: the program is the whole run
                while j < len(lines) and lines[j] != '=====RUN=====':
                    j += 1
            else:                          # `strings` output: stop at the first non-Quil line
                while j < len(lines) and (lines[j].startswith(('DECLARE', 'DEFCAL', 'LABEL', 'PRAGMA', 'FENCE', 'RX', 'RZ', 'CZ', 'MEASURE', 'DELAY', '\t', 'JUMP', '"'))):
                    j += 1
            body = '\n'.join(lines[i:j])
            if 'MEASURE' in body and 'CZ ' in body:
                out.append((i, body + '\n'))
            i = j
        else:
            i += 1
    return out


def calibrations(lines):
    """CZ / RX(pi/2) / RX(pi) / MEASURE pulse durations for the 8 stability qubits."""
    text = '\n'.join(lines)
    cal = {'cz': {}, 'rx_pi_2': {}, 'rx_pi': {}, 'measure_pulse': {}}
    for a, b in PAIRS:
        for x, y in ((a, b), (b, a)):
            for m in re.finditer(r'DEFCAL CZ %d %d:\n\tFENCE ([0-9 ]+)\n(?:\t[^\n]*\n){0,3}?\tNONBLOCKING PULSE \d+ "Transmon-\d+_flux_tx[^"]*" erf_square\(detuning: 0, duration: ([0-9.e-]+)' % (x, y), text):
                fence = [int(t) for t in m.group(1).split()]
                coupler = [t for t in fence if t >= 84]
                cal['cz'].setdefault('%d-%d' % (a, b), set()).add((float(m.group(2)), tuple(coupler)))
    for q in QUBITS:
        for key, ang in (('rx_pi_2', '1.5707963267948966'), ('rx_pi', '3.141592653589793')):
            for m in re.finditer(r'DEFCAL RX\(%s\) %d:\n\tFENCE %d\n\tNONBLOCKING PULSE %d "Transmon-%d_charge_tx" drag_gaussian\([^)]*duration: ([0-9.e-]+)' % (ang, q, q, q, q), text):
                cal[key].setdefault(str(q), set()).add(float(m.group(1)))
        for m in re.finditer(r'NONBLOCKING PULSE %d "Transmon-%d_readout_tx" flat\(detuning: 0, duration: ([0-9.e-]+)' % (q, q), text):
            cal['measure_pulse'].setdefault(str(q), set()).add(round(float(m.group(1)), 12))
    return {k: {kk: sorted(vv) for kk, vv in v.items()} for k, v in cal.items()}


def main():
    src, out_dir, label = sys.argv[1], sys.argv[2], sys.argv[3]
    lines = read_lines(src)
    os.makedirs(out_dir, exist_ok=True)
    # group headers: timestamp line followed by the measured-qubit-per-round list
    groups = []
    for i, l in enumerate(lines):
        if l.startswith('[[36, 38, 52, 50]'):
            rounds = json.JSONDecoder().raw_decode(l)[0]
            prev = [x for x in lines[max(0, i - 3):i] if x.startswith('20')]
            groups.append({'line': i, 'timestamp': prev[-1] if prev else None,
                           'measurement_rounds': len(rounds), 'measured_qubits_per_round': rounds,
                           'code_label': lines[i + 1] if i + 1 < len(lines) else None})
    stims = stim_blocks(lines)
    progs = quil_programs(lines)
    seen = {}
    for pos, s in stims:
        n_m = sum(len(l.split()) - 1 for l in s.split('\n') if l.startswith('M '))
        key = s
        if key in seen:
            continue
        n_rounds = s.count('\nM ')
        seen[key] = n_rounds
        fn = os.path.join(out_dir, '%s_meas%02d.stim' % (label, n_rounds))
        with open(fn, 'w', encoding='utf-8', newline='\n') as f:
            f.write(s)
    prog_meta = []
    for pos, p in progs:
        n_rounds = len(re.findall(r'^MEASURE 36 ro', p, re.M))
        cond = 'RX(pi) 50' in p
        fn = os.path.join(out_dir, '%s_meas%02d_program.quil' % (label, n_rounds))
        if not os.path.exists(fn):
            with open(fn, 'w', encoding='utf-8', newline='\n') as f:
                f.write(p)
        prog_meta.append({'line': pos, 'measurement_rounds': n_rounds, 'conditional_rx_pi_50': cond,
                          'ro_bits': re.search(r'DECLARE ro BIT\[(\d+)\]', p).group(1) if 'DECLARE ro BIT' in p else None})
    json.dump({'source': os.path.basename(src), 'groups': groups,
               'stim_circuits': sorted(set(seen.values())), 'programs': prog_meta,
               'calibrations': calibrations(lines)}, open(os.path.join(out_dir, label + '_groups.json'), 'w'), indent=1, default=list)
    print(label, 'groups', len(groups), 'stim', sorted(set(seen.values())), 'programs', len(progs))


if __name__ == '__main__':
    main()
