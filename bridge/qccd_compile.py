"""Compile an OpenQASM circuit to a TSIR program with the QCCD Studio compiler.

Reads {"qasm": <text>, "architecture": <path relative to the Studio checkout, optional>} on
stdin and prints {"architecture": <architecture text>, "program": <TSIR text>, "revision": …}.
The result is the input of bridge/qccd_studio.py. The Studio checkout is the sibling directory
`QCCD`, or the directory named by QCCD_STUDIO_ROOT. Errors are printed as {"error": …}.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
DEFAULT_ARCH = "Reproduce/moses2023/h2.arch.json"


def main():
    request = json.loads(sys.stdin.read())
    studio = Path(os.environ.get("QCCD_STUDIO_ROOT", HERE.parents[1] / "QCCD")).resolve()
    if not studio.is_dir():
        raise ValueError(f"QCCD Studio checkout not found at {studio}")
    arch = (studio / request.get("architecture", DEFAULT_ARCH)).resolve()
    if studio not in arch.parents or not arch.is_file():
        raise ValueError("The architecture must be a file inside the Studio checkout")
    sys.path[:0] = [str(studio)]
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["QCCD_STUDIO_ROOT"] = str(studio)
    from qccd.qec import compile_with_qccdc

    with tempfile.TemporaryDirectory(prefix="qcontrol-qccdc-") as tmp:
        program, _certificate = compile_with_qccdc(request["qasm"], arch, Path(tmp), mode="compile", timeout=120)
        tsir = program.read_text(encoding="utf-8")
    revision = subprocess.check_output(["git", "-C", str(studio), "rev-parse", "HEAD"], text=True).strip()
    return {"architecture": arch.read_text(encoding="utf-8"), "program": tsir, "revision": revision,
            "architecturePath": str(arch.relative_to(studio)).replace("\\", "/")}


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception as error:  # the caller shows this text
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)
