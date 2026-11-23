"""Regenerate Jain et al. Extended Data Fig. 2 observations; requires PyMuPDF 1.28.2."""
import argparse
import csv
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

import pymupdf

URL = "https://arxiv.org/src/2308.07672v2"
ARCHIVE_SHA = "0ca9a27d15a054a5d5d7cbb2d45a76ec3ce7d5af8543ccf3d0cc1afec82016b5"
FIGURE_SHA = "0b864cfd8c37970fe78af091d8e60fb1283b3b8f2d243f969afb5a012a836942"


def extract(data):
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA:
        raise ValueError("Unexpected arXiv source archive")
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        figure = archive.extractfile("FigS2.pdf").read()
    if hashlib.sha256(figure).hexdigest() != FIGURE_SHA:
        raise ValueError("Unexpected FigS2.pdf")
    with pymupdf.open(stream=figure, filetype="pdf") as doc:
        paths = doc[0].get_drawings()
    panels = [i for i, p in enumerate(paths) if p["type"] == "f" and p["fill"] == (1, 1, 1)
              and 64 < p["rect"].width < 65 and 82 < p["rect"].height < 83]
    assert len(panels) == 12
    result = io.StringIO()
    writer = csv.writer(result, lineterminator="\n")
    writer.writerow(["axis", "mode", "motion", "sideband", "detuning_khz", "bright_population"])
    for panel, (start, stop) in enumerate(zip(panels, panels[1:] + [len(paths)])):
        box = paths[start]["rect"]
        grid = [g["rect"] for g in paths[start:stop] if g["type"] == "s" and g["color"]
                and 0.68 < g["color"][0] < 0.70 and g["rect"].width > 64]
        assert len(grid) == 3
        y0, y1 = max(r.y0 for r in grid), min(r.y0 for r in grid)
        axis = ("z", "x")[panel // 6]
        mode = ("magnetron", "cyclotron", "axial")[(panel % 6) // 2]
        motion = ("stationary", "transported")[panel % 2]
        for p in paths[start:stop]:
            fill = p.get("fill") or ()
            if p["type"] == "f" and len(p["items"]) == 4 and fill and fill[0] == 1 and 0.44 < fill[1] < 0.46:
                sideband = "red"
            elif p["type"] == "fs" and len(p["items"]) == 8 and fill and fill[0] == 0 and 0.67 < fill[1] < 0.69:
                sideband = "blue"
            else:
                continue
            r = p["rect"]
            x, y = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            # The PDF contains points clipped outside the displayed scan.
            if not box.x0 - 0.001 <= x <= box.x1 + 0.001:
                continue
            detuning = -10 + 20 * (x - box.x0) / box.width
            pop = (y0 - y) / (y0 - y1)
            assert -0.0001 <= pop <= 1.0001
            writer.writerow([axis, mode, motion, sideband, f"{detuning:.3f}",
                             f"{min(1, max(0, pop)):.5f}"])
    return result.getvalue().encode("ascii")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", type=Path)
    arg = parser.parse_args()
    data = arg.archive.read_bytes() if arg.archive else urlopen(URL, timeout=80).read()
    table = extract(data)
    Path(__file__).with_name("slow_fig_s2.csv").write_bytes(table)
    print("slow_fig_s2.csv", hashlib.sha256(table).hexdigest())
