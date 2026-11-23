"""Rebuild all 32 native H2 phase circuits and their compact verified TSIR edits."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import urlopen

from extract_h2 import COMMIT, HERE, RAW_SHA, SOURCE_Z_SHA, URL, extract, sha


def inspect_analysis(tsir, circuit_ops):
    """Check actual emitted single-ion rotations against the source-gate angles."""
    pulses = {op["i"]: [] for op in circuit_ops if op["name"] in ("rz", "ry")}
    for step in tsir["instructions"]:
        if step["type"] != "gate":
            continue
        for op in step.get("meta", {}).get("source_op", []):
            if op in pulses:
                # A batched gate lists source IDs in ascending order, and ions
                # in spatial zone order. The circuit qubit joins the two lists.
                ion = f"q{circuit_ops[op]['qubits'][0]}"
                j = step["ions"].index(ion)
                pulses[op].append((step["gate"], step["ions"][j], step["params"][j], step["id"]))
    assert len(pulses) == 64
    for op in circuit_ops:
        if op["i"] not in pulses:
            continue
        rotation, frame = pulses[op["i"]]
        gate, ion, (angle, axis), _ = rotation
        virtual, ion2, (z,), _ = frame
        assert gate == "R" and virtual == "VZ" and ion == ion2 == f"q{op['qubits'][0]}"
        expected, = op["params"]
        if op["name"] == "rz":
            assert angle == 0 and math.isclose(z, expected, abs_tol=1e-12)
        else:
            assert z == 0 and math.isclose(angle, expected, abs_tol=1e-12)
            assert math.isclose(axis, math.pi / 2, abs_tol=1e-12)
    return pulses


def compile_all(data, studio):
    extract(data)
    shots = json.loads(data)
    sys.path[:0] = [str(studio), str(studio / "Reproduce/moses2023"), str(HERE.parents[1] / "bridge")]
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["QCCD_STUDIO_ROOT"] = str(studio)
    from circuits import rewrite
    import qccd_studio
    from qccd.qec import _toolchain, compile_with_qccdc
    from qccd.ir.provenance import blank_root
    exp = studio / "Reproduce/moses2023"
    arch = exp / "h2.arch.json"
    native_ref = json.loads((exp / "results.json").read_bytes())
    preparation = next(c for c in native_ref["circuits"] if c["id"] == "ghz_n32")
    assert preparation["source_sha256"] == SOURCE_Z_SHA
    rev = subprocess.check_output(["git", "-C", str(studio), "rev-parse", "HEAD"], text=True).strip()
    source = f"https://github.com/Quantinuum/quantinuum-hardware-h2-benchmark/blob/{COMMIT}/ghz/data/GHZ_N32.json"
    design = {"title": "Quantinuum H2 hardware GHZ32 phase-scan circuits", "source": source,
              "paper": "https://doi.org/10.1103/PhysRevX.13.041052",
              "studioSource": "https://www.qccd.academy/reproduce/moses2023/",
              "program": "h2-theta1.tsir.json", "rawSha256": RAW_SHA,
              "architectureSha256": sha(arch.read_bytes()), "studioRevision": rev,
              "compilerSha256": sha(_toolchain()[0].read_bytes()), "timeUnit": "model units",
              "publishedZBasisSourceSha256": SOURCE_Z_SHA,
              "scope": "All 32 source circuits were independently compiled and checked on the Studio H2 design. The 947-cycle Studio demo uses a different GHZ tree. Hardware shots measure parity and do not timestamp routing.",
              "phases": {}}
    with tempfile.TemporaryDirectory(prefix="qcontrol-h2-scan-") as tmp:
        for k in range(1, 33):
            key = f"({2*k-1}, 'theta{k}')"
            qasm = shots["qasm"][key]
            rewritten, _ = rewrite(qasm)
            work = Path(tmp) / str(k)
            program, certificate = compile_with_qccdc(rewritten, arch, work, mode="compile", timeout=90)
            tsir = blank_root(json.loads(program.read_bytes()))
            cert = json.loads(certificate.read_bytes())
            pulses = inspect_analysis(tsir, cert["circuit_ops"])
            prefix = str(certificate).removesuffix(".qcert.json")
            qin = work / "check.json"
            bridge = studio / "Compiler/bridge"
            subprocess.run([sys.executable, "-B", str(bridge / "mk_qcheck_input.py"), prefix, "--arch",
                            str(work / "device.expanded.json"), "-o", str(qin)], check=True,
                           capture_output=True, timeout=90)
            check = subprocess.run([sys.executable, "-B", str(bridge / "check_cert.py"), prefix, "--qasm",
                                    str(work / "circuit.qasm"), "--arch", str(arch), "--qcheck", str(qin),
                                    "--json"], capture_output=True, text=True, timeout=90)
            verdict = json.loads(check.stdout)
            assert verdict["lean"] == "accepted" and verdict["binding"] == "ok"
            assert verdict["order"] == verdict["o1_transport"] == "ok" and not verdict["unrealised_ops"]
            out = json.dumps(tsir, ensure_ascii=True, separators=(",", ":")) + "\n"
            trace = qccd_studio.execute({"architecture": arch.read_text(encoding="utf-8"), "program": out})
            assert trace["summary"]["gatePairs"] == 31 and trace["summary"]["ruleViolations"] == 0
            assert trace["summary"]["ions"] == trace["summary"]["measurements"] == 32
            first = pulses[33]
            literals = [repr(first[0][2][1]), repr(first[1][2][0])]
            if k == 1:
                base, old = out, literals
                assert all(base.count(token) == 32 for token in old)
                witness = next(f for f in trace["frames"] if f["sourceId"] == first[1][3])
                design["frame"] = {key: witness[key] for key in ("id","sourceId","substep","op","label","ions","targets","start","end")}
                design["summary"] = trace["summary"]
                design["programSha256"] = sha(base.encode())
            restored = base
            replacements = []
            for prev, new in zip(old, literals):
                if prev != new:
                    replacements.append([prev, new])
                    restored = restored.replace(prev, new)
            if restored != out:
                raise ValueError(f"Unexpected non-angle native program difference at phase {k}")
            design["phases"][str(k)] = {
                "sourceKey": key, "qasmSha256": sha(qasm.encode()), "programSha256": sha(out.encode()),
                "replacements": replacements, "instructions": len(tsir["instructions"]),
                "cycles": trace["summary"]["cycles"], "ruleViolations": trace["summary"]["ruleViolations"],
                "certificate": verdict["lean"], "R10": verdict["R10"], "sourceAnalysisRotationsChecked": 64,
            }
            print(f"theta{k}: native replay, source analysis, and certificate checked", flush=True)
    (HERE / "h2-theta1.tsir.json").write_bytes(base.encode())
    (HERE / "h2-design.json").write_bytes((json.dumps(design, indent=2, ensure_ascii=False) + "\n").encode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?")
    parser.add_argument("--studio", type=Path,
                        default=Path(os.environ.get("QCCD_STUDIO_ROOT", HERE.parents[2] / "QCCD")))
    args = parser.parse_args()
    raw = args.source.read_bytes() if args.source else urlopen(URL, timeout=60).read()
    compile_all(raw, args.studio.resolve())
