"""Verify the native Quantinuum experiment circuits and pack the original ordered shots."""
import argparse
import ast
import csv
from fractions import Fraction
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.request import urlopen


COMMIT = "d422a716977899d7d6603c9efadb44e89e495125"
URL = f"https://raw.githubusercontent.com/Quantinuum/quantinuum-hardware-h2-benchmark/{COMMIT}/ghz/data/GHZ_N32.json"
RAW_SHA = "4d6741f76830ef711b501c82372d1d3d630f0654e8107b1032bd4001b0af3db4"
SOURCE_Z_SHA = "f51e7c0493bfd29db3efc60a0b8fbedb6817627ff3c23aaa406e173bd8f403d5"
HERE = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def extract(data):
    if sha(data) != RAW_SHA:
        raise ValueError("Physical shot file differs from the pinned Quantinuum commit")
    doc = json.loads(data)
    qasm, results = doc["qasm"], doc["results"]
    if qasm.keys() != results.keys() or len(qasm) != 64:
        raise ValueError("Expected the same 64 QASM and shot settings")
    z_circuits = {q for key, q in qasm.items() if ast.literal_eval(key)[1] == "Z"}
    if len(z_circuits) != 1:
        raise ValueError("Expected one shared computational-basis preparation")
    z_source = z_circuits.pop()
    if sha(z_source.encode()) != SOURCE_Z_SHA:
        raise ValueError("Z-basis source differs from QCCD Studio's published reproduction")
    n = 32
    tree = [f"cx q[{i}],q[{i + stride}];" for stride in (1, 2, 4, 8, 16) for i in range(stride)]
    if [line for line in z_source.splitlines() if line.startswith("cx ")] != tree:
        raise ValueError("Source GHZ preparation tree differs")
    expected_measure = [f"measure q[{i}] -> c[{i}];" for i in range(n)]
    rows = []
    for key, source in qasm.items():
        job, setting = ast.literal_eval(key)
        if setting == "Z":
            continue
        k = int(re.fullmatch(r"theta(\d+)", setting)[1])
        phase_lines = source.splitlines(keepends=True)
        # Removing only analysis rotations must recover precisely the same
        # QASM text the Studio reproduction used, including both barriers.
        groups = {axis: [] for axis in ("rz", "ry")}
        baseline = []
        for line in phase_lines:
            if line.startswith(("ry(", "rz(")):
                m = re.fullmatch(r"(r[zy])\(([\d.]+)\*pi\) q\[(\d+)\];", line.strip())
                if m is None:
                    raise ValueError("Unexpected analysis rotation")
                groups[m[1]].append((int(m[3]), Fraction(m[2])))
            else:
                baseline.append(line)
        if "".join(baseline) != z_source:
            raise ValueError("Analysis circuit changed the preparation or readout")
        angles = [Fraction(4) - Fraction(k, n), Fraction(7, 2)]
        for (axis, group), angle in zip(groups.items(), angles):
            if group != [(i, angle) for i in range(n)]:
                raise ValueError(f"Unexpected {axis} gates for {setting}")
        analysis = [line.split("(")[0] for line in source.splitlines() if line.startswith(("rz(", "ry("))]
        if analysis != ["rz"] * n + ["ry"] * n or source.splitlines()[-n:] != expected_measure:
            raise ValueError("Expected Rz, Ry and indexed computational-basis readout")
        shots = results[key]["c"]
        if len(shots) != 50 or any(not re.fullmatch("[01]{32}", shot) for shot in shots):
            raise ValueError("Expected 50 ordered 32-ion measurement strings per phase")
        packed = "".join(f"{int(shot, 2):08x}" for shot in shots)
        rows.append((k, job, float(angles[0]), float(angles[1]), sha(source.encode()), packed))
    rows.sort()
    if [r[0] for r in rows] != list(range(1, 33)):
        raise ValueError("Incomplete parity scan")
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["k", "job", "rz_pi", "ry_pi", "qasm_sha256", "ordered_uint32_hex"])
    writer.writerows(rows)
    return out.getvalue().encode("ascii"), qasm["(1, 'theta1')"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path)
    arg = parser.parse_args()
    raw = arg.source.read_bytes() if arg.source else urlopen(URL, timeout=60).read()
    table, _ = extract(raw)
    (HERE / "h2-shots.csv").write_bytes(table)
    print("h2-shots.csv", sha(table))
