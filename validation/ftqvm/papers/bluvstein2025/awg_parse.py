"""Parse the four AWG command strings of anc/RawExperimentalCommands_SurfaceCodeQEC.pdf
(Bluvstein et al., arXiv:2506.20661, Supplementary Information) into timed command lists.

Every command keeps its verbatim text (as extracted by pymupdf; the PDF uses U+2010 for minus
signs, which we keep in `text` and normalise to '-' in `norm`).  Durations come from the
command's own arguments; where the command format does not state a duration, the rule used is
listed in DURATION_RULES and every such command carries `duration_rule` != 'explicit'.
"""
import re
import pymupdf

SECTIONS = [  # (key, first page, last page, line that starts the command text)
    ('moving', 1, 6, '### Define coordinates and powers'),
    ('raman', 7, 11, '### State preparation before circuit begins'),
    ('raman_aod', 12, 22, 'FILE[repetitiveQEC_d5_variables.txt]'),
    ('rydberg', 23, 25, 'Wait[500.91 us]'),
]
FOOTERS = {'Moving AWG command string', 'Raman AWG command string', 'Raman AOD AWG command string',
           'Rydberg AWG command string'}

RAMAN_AOD_SLOT_US = 5.8233   # VAR[time[], WAIT[5.8233us]]
RAMAN_AOD_TURNOFF_US = 0.010  # VAR[turnoff[], MOVEAOD[...,10ns]]
RAMAN_LOCAL_SLOT_US = 5.8180  # 4th argument of SC1_H_/SC1PI_FIXEDLOOPED_SMOOTH_PCOMP
RYDBERG_PULSE_SEGMENT_US = 470.0 - 467.8  # inferred: Moving-AWG CZ period (0.195+0.010+0.195+0.070 ms) minus Rydberg Wait[467.800 us]

DURATION_RULES = {
    'explicit': 'duration stated in the command (ms/us/ns argument)',
    'raman_local_slots': 'n_rows x 5.8180 us (args: [ramp, ?, ?, 5.8180 us per row-slot, phase, n_rows, local]); n_rows equals the number of Raman-AOD time[] slots it overlaps',
    'raman_global_T': 'first time argument taken as the pulse length (BB1_FIXED: third argument; CPROBUST180*: first argument) -- assumption, not stated',
    'pumping': '24 cycles x 8.53 us (SMOOTHPUMPINGLOOPEDTTL args 7 and 8) -- assumption; Methods: "24 cycles of pumping per atom over a few hundred microseconds"',
    'virtual': 'Z[] is a virtual phase update of the 6.8 GHz IQ reference: 0 us',
    'aod_slot': 'time[] = WAIT[5.8233us] (VAR definition in the command string)',
    'aod_turnoff': 'turnoff[] = MOVEAOD[...,10ns] (VAR definition in the command string)',
    'aod_tone': 'row-tone selection rN_*[] loaded from file: taken as 0 us (tones switch at slot boundaries) -- assumption',
    'rydberg_pulse': 'Pulse[...] segment length inferred = 470 us (Moving-AWG CZ period) - 467.8 us (Rydberg Wait) = 2.2 us; the gate itself is 270 ns (Methods)',
    'definition': 'variable / segment / file / note definition: 0 us',
}


def _join_lines(lines):
    out, buf, depth = [], '', 0
    for ln in lines:
        s = ln.rstrip()
        if not s.strip():
            continue
        if buf:
            if re.search(r'\d$', buf.rstrip()) and re.match(r'\d', s.strip()) and not buf.endswith(' '):
                buf = buf + s.strip()          # a number wrapped by the PDF line break
            elif re.search(r'\d$', buf.rstrip()) and re.match(r'\d', s.strip()):
                buf = buf.rstrip() + s.strip()
            else:
                buf = buf.rstrip() + ' ' + s.strip()
        else:
            buf = s.strip()
        depth = buf.count('[') - buf.count(']')
        if depth <= 0:
            out.append(buf)
            buf = ''
    if buf:
        out.append(buf)
    return out


def read_sections(pdf_path):
    doc = pymupdf.open(pdf_path)
    res = {}
    for key, p0, p1, start in SECTIONS:
        lines = []
        for p in range(p0 - 1, p1):
            for ln in doc[p].get_text().splitlines():
                ln = ln.replace('\xa0', ' ')  # the PDF text layer uses no-break spaces
                if ln.strip() in FOOTERS:
                    continue
                lines.append(ln)
        txt = '\n'.join(lines)
        i = txt.index(start)
        res[key] = {'preamble_prose': ' '.join(txt[:i].split()), 'commands': _join_lines(txt[i:].splitlines())}
    return res


def _t_us(s):
    s = s.strip().lower().replace(' ', '')
    m = re.fullmatch(r'(-?[\d.]+)(ms|us|ns)', s)
    if not m:
        return None
    v = float(m.group(1))
    return v * {'ms': 1000.0, 'us': 1.0, 'ns': 1e-3}[m.group(2)]


def _args(cmd):
    inner = cmd[cmd.index('[') + 1: cmd.rindex(']')]
    parts, depth, cur = [], 0, ''
    for ch in inner:
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur.strip()); cur = ''
        else:
            cur += ch
    parts.append(cur.strip())
    return parts


def timed(section_key, commands):
    """Return list of dicts: text, norm, name, duration_us, duration_rule, comment(bool)."""
    out = []
    for text in commands:
        norm = text.replace('‐', '-')
        d = {'text': text, 'norm': norm}
        if norm.startswith('#'):
            d.update(name='#', duration_us=0.0, duration_rule='definition', comment=True)
            out.append(d); continue
        name = norm.split('[')[0].strip()
        d['name'] = name
        args = _args(norm) if '[' in norm else []
        dur, rule = 0.0, 'definition'
        U = name.upper()
        if U in ('WAIT',):
            dur, rule = _t_us(args[0]), 'explicit'
        elif U == 'MOVEAOD':
            dur, rule = _t_us(args[-1]), 'explicit'
        elif section_key == 'raman':
            if U in ('E', 'SC1_ECHO'):
                dur, rule = _t_us(args[0]), 'explicit'
            elif U.startswith('SC1'):
                dur, rule = int(args[5]) * _t_us(args[3]), 'raman_local_slots'
            elif U == 'BB1_FIXED':
                dur, rule = _t_us(args[2]), 'raman_global_T'
            elif U.startswith('CPROBUST180'):
                dur, rule = _t_us(args[0]), 'raman_global_T'
            elif U.startswith('SMOOTHPUMPING'):
                dur, rule = int(args[6]) * _t_us(args[7]), 'pumping'
            elif U == 'Z':
                dur, rule = 0.0, 'virtual'
        elif section_key == 'raman_aod':
            if U == 'TIME':
                dur, rule = RAMAN_AOD_SLOT_US, 'aod_slot'
            elif U == 'TURNOFF':
                dur, rule = RAMAN_AOD_TURNOFF_US, 'aod_turnoff'
            elif re.fullmatch(r'R\d_.*', U):
                dur, rule = 0.0, 'aod_tone'
            elif U == 'E':  # one Raman-style idle command appears verbatim in the Raman-AOD string
                dur, rule = _t_us(args[0]), 'explicit'
        elif section_key == 'rydberg' and U == 'PULSE':
            dur, rule = RYDBERG_PULSE_SEGMENT_US, 'rydberg_pulse'
        if dur is None:
            raise ValueError('no duration parsed for ' + text)
        d.update(duration_us=dur, duration_rule=rule, comment=False)
        out.append(d)
    return out
