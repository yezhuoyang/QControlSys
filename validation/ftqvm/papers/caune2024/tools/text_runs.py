"""Read a binary stream (an HDF5 file from Zenodo) on stdin and write every run of >= MIN printable
ASCII characters (tab/newline/CR/space..~) to stdout, one run per block, blocks separated by a
line '=====RUN====='. Unlike `strings`, newlines are kept inside a run, so short lines of the
stored Stim circuits / Quil programs (e.g. 'TICK', '\tnop', '}') are preserved verbatim.
Usage: curl -sL <url> | python -I tools/text_runs.py > runs.txt
"""
import re, sys

MIN = 24
pat = re.compile(rb'[\t\n\r\x20-\x7e]{%d,}' % MIN)
inp, out = sys.stdin.buffer, sys.stdout.buffer
carry = b''
while True:
    chunk = inp.read(1 << 24)
    if not chunk:
        break
    buf = carry + chunk
    # keep an unfinished printable tail for the next chunk
    cut = len(buf)
    while cut > 0 and (buf[cut - 1] in (9, 10, 13) or 0x20 <= buf[cut - 1] <= 0x7e):
        cut -= 1
    carry = buf[cut:]
    for r in pat.finditer(buf, 0, cut):
        out.write(r.group(0).replace(b'\r\n', b'\n') + b'\n=====RUN=====\n')
for r in pat.finditer(carry):
    out.write(r.group(0) + b'\n=====RUN=====\n')
