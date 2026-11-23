"""Recreate the 25 ns experimental slice from the original MATLAB archive."""

import argparse
import csv
import hashlib
import io
from pathlib import Path
from urllib.request import Request, urlopen


SOURCE_URL = (
    "https://data.mendeley.com/public-files/datasets/vzs49gddsm/files/"
    "cffd7634-d4df-490b-8653-658744784345/file_downloaded"
)
SOURCE_SHA256 = "d72b3251e478594dd86320415553b5253c240fa72ad7644f2db445c2d14aa844"


def extract(raw, output):
    # SciPy is confined to one-time preparation. The benchmark itself uses stdlib.
    from scipy.io import loadmat

    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError("The file differs from Mendeley Data v1 RabiOscillations.mat")
    data = loadmat(io.BytesIO(raw), simplify_cells=True)["output"]
    row = min(range(len(data["pulseSigmas"])), key=lambda i: abs(data["pulseSigmas"][i] - 25e-9))
    assert row == 2 and abs(data["pulseSigmas"][row] - 25e-9) < 1e-18
    assert float(data["frequency"]) == 7893595218 and int(data["nSigmaTrunc"]) == 2
    assert data["PCorr"].shape == (93, 50) and not data["PCorr"].dtype.kind == "c"
    with output.open("w", encoding="ascii", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["source_column", "amp_if", "attenuation_db", "cross_power"])
        for i, a in enumerate(data["ampIf"]):
            writer.writerow([i, repr(float(a)), repr(float(data["attenuation"][i])),
                             repr(float(data["PCorr"][row, i]))])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mat", type=Path, help="Path to the original RabiOscillations.mat")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("rabi_25ns.csv"))
    args = parser.parse_args()
    if args.mat:
        raw = args.mat.read_bytes()
    else:
        with urlopen(Request(SOURCE_URL, headers={"User-Agent": "QControlSys dataset replay"}), timeout=45) as response:
            raw = response.read()
    extract(raw, args.output)
