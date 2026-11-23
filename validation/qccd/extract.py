"""Reconstruct the factual Fig. 2 data table from the authors' pinned source archive.

Only this optional regeneration command requires PyMuPDF (tested with 1.28.2).
Pass an existing archive or omit the argument to fetch the named publication.
"""

import argparse
import csv
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

import pymupdf


URL = "https://arxiv.org/src/2301.05279v2"
ARCHIVE_HASH = "817ccada93fe9638f4836502c571ebed833e614ffdbcb1b844a511f051260f27"
MEMBER = "20230324_Transport_Fig2_3panel.pdf"
MEMBER_HASH = "59f87b37058b61f6c310c90f7bc7724a0afc52cd5de5d23d17430396e7bb30da"


def verify(data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Source SHA-256 mismatch")


def panel(drawings, background, first_circle, first_bar, max_y):
    # The plot background matches its four axis spines. Page y increases down.
    box = drawings[background]["rect"]
    values = []
    for i in range(161):
        marker = drawings[first_circle + i]
        bar = drawings[first_bar + i]
        r, b = marker["rect"], bar["rect"]
        assert marker["type"] == "fs" and len(marker["items"]) == 8
        assert 5.99 <= r.width <= 6.01 and 5.99 <= r.height <= 6.01
        assert max(marker["fill"]) < 0.15 and bar["type"] == "s"
        cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
        assert abs(b.x0 - cx) < 0.01 and b.width < 0.01 and b.y0 <= cy <= b.y1
        delay = (cx - box.x0) * 1500 / box.width
        # Snap the two nominal plot endpoints across PDF sub-point roundoff.
        if i in (0, 160):
            assert abs(delay - i * 1500 / 160) < 0.01
            delay = i * 1500 / 160
        scale = max_y / box.height
        values.append((delay, (box.y1 - cy) * scale, (box.y1 - b.y1) * scale,
                       (box.y1 - b.y0) * scale))
    assert all(right[0] > left[0] for left, right in zip(values, values[1:]))
    return values


def extract(archive_data):
    verify(archive_data, ARCHIVE_HASH)
    with tarfile.open(fileobj=io.BytesIO(archive_data)) as archive:
        figure = archive.extractfile(MEMBER).read()
    verify(figure, MEMBER_HASH)
    with pymupdf.open(stream=figure, filetype="pdf") as pdf:
        draws = pdf[0].get_drawings()
    # These object indices refer only to the hash-checked figure above.
    probability = panel(draws, 0, 214, 53, 1)
    position = panel(draws, 404, 593, 429, 200)
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(("marker", "delay_ns", "position_um", "position_low_um", "position_high_um",
                     "deshelving_probability", "probability_low", "probability_high"))
    for i, (pos, prob) in enumerate(zip(position, probability)):
        assert abs(pos[0] - prob[0]) < 0.02
        writer.writerow((i, f"{pos[0]:.2f}", *(f"{n:.3f}" for n in pos[1:]),
                         *(f"{n:.6f}" for n in prob[1:])))
    return buf.getvalue().encode("ascii")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?")
    args = parser.parse_args()
    archive_bytes = args.archive.read_bytes() if args.archive else urlopen(URL, timeout=60).read()
    data = extract(archive_bytes)
    Path(__file__).with_name("fig2.csv").write_bytes(data)
    print("fig2.csv", hashlib.sha256(data).hexdigest())
