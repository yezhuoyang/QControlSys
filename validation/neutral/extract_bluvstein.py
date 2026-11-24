"""Extract marker centres (not shot records) from Bluvstein et al. Fig. 1c.
Usage: python validation/neutral/extract_bluvstein.py <published-pdf>
Requires PyMuPDF. Redigitization is only needed to regenerate the course fixture.
"""
import hashlib
import json
from pathlib import Path
import sys

import pymupdf

raw = Path(sys.argv[1]).read_bytes()
digest = hashlib.sha256(raw).hexdigest()
if digest != "d4d785e2579cf38a50988b25657b90cfcbd4440f553c957cd4050caa1dd06382":
    raise ValueError("Use the MIT author-hosted published PDF named in the fixture.")
page = pymupdf.open(stream=raw, filetype="pdf")[1]
series = {"stationary": [], "transported": []}
colors = {(0.30, 0.30, 0.30): "stationary", (0.95, 0.50, 0.44): "transported"}
# PDF point coordinates of the axis ticks: left/right = 0, 2 pi; bottom/top = -1, +1.
left, right = 339.95, 429.89
bottom, top = 328.34454, 234.92163
for path in page.get_drawings():
    rect = path["rect"]
    color = tuple(round(v, 2) for v in path["fill"] or [])
    x, y = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
    if color not in colors or not (4.2 < rect.width < 4.4 and 4.2 < rect.height < 4.4):
        continue
    if left - 0.1 <= x <= right + 0.1 and top < y < bottom:
        k = round(40 * (x - left) / (right - left))
        series[colors[color]].append((k, round(2 * (bottom - y) / (bottom - top) - 1, 4)))
for key, points in series.items():
    points.sort()
    if [k for k, _ in points] != list(range(41)):
        raise ValueError(f"Incomplete {key} sweep")
    series[key] = [v for _, v in points]
record = {"figure": "Bluvstein et al., Nature 604, Fig. 1c (2022)",
          "source": "https://eapg.mit.edu/wp-content/uploads/2022/10/Q-Processor-coherent-transport-Nature-Bluvstein.pdf",
          "license": "CC BY 4.0", "pdfSha256": digest, "phaseStepRad": "pi/20",
          "method": "Digitized vector marker centres, rounded to four decimals. Underlying shots and error bars are unavailable here.",
          **series}
out = Path(__file__).resolve().parents[2] / "studio/course/labs/atom-parity.json"
out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
