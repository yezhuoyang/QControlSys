"""Extract the independent Rabi-thermometry markers from the authors' Fig. 3(a) EPS."""

import argparse
import csv
import hashlib
import io
from pathlib import Path
import re
import tarfile
from urllib.request import Request, urlopen


SOURCE = "https://arxiv.org/src/1206.0364v1"
EPS_SHA256 = "74c3f643b486187f2591abee0ca5743fd1a78bf005d7f94233e0f8525e509dc1"


def extract(raw, dest):
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as archive:
        eps = archive.extractfile("pE_curves.eps").read()
    if hashlib.sha256(eps).hexdigest() != EPS_SHA256:
        raise ValueError("Unexpected source figure bytes")
    figure = eps.decode("latin-1")
    start = figure.index("% Begin plot #2")
    stop = figure.index("% End plot #2", start)
    panel = figure[start:stop]
    if "0.00 0.00 1.00 C" not in panel:
        raise ValueError("Blue sideband marker series missing")
    markers = sorted((int(x), int(y)) for x, y in re.findall(r"^(\d+) (\d+) Circle$", panel, re.M))
    if len(markers) != 11 or len({x for x, _ in markers}) != len(markers):
        raise ValueError("Expected eleven distinct sideband dwell settings in the upper panel")
    # Axis tick coordinates from the same EPS. X is linear in µs and Y is log10(phonons).
    with dest.open("w", encoding="ascii", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["marker_index", "eps_x", "eps_y", "plotted_dwell_ns", "mean_phonons"])
        for i, (x, y) in enumerate(markers):
            dwell_ns = 3000 * (x - 504) / (4390 - 504)
            phonons = 10 ** (-1 + 3 * (y - 2878) / (4406 - 2878))
            writer.writerow([i, x, y, f"{dwell_ns:.6f}", f"{phonons:.9f}"])


if __name__ == "__main__":
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument("--tar", type=Path, help="Existing versioned arXiv source archive")
    arg.add_argument("--output", type=Path, default=Path(__file__).with_name("pair-data.csv"))
    opts = arg.parse_args()
    if opts.tar:
        data = opts.tar.read_bytes()
    else:
        with urlopen(Request(SOURCE, headers={"User-Agent": "QControlSys figure replay"}), timeout=45) as response:
            data = response.read()
    extract(data, opts.output)
