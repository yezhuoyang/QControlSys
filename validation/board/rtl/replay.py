"""Compare the published INO timing core's pin transitions with the saved RTL run."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import urllib.request

ROOT = Path(__file__).resolve().parent
REV = "94cecd4eb9d04f4ebb957f70a5783b45cbd7a51a"
MEMBER = "firmware-source/2017.4/Vivado/hdl/dio24_timing.v"
URL = f"https://raw.githubusercontent.com/INO-quantum/FPGA-SoC-experiment-control/{REV}/{MEMBER}"
SHA = "dcc2c6bfe67ba4f107324336b5d45b2b03c279ed453e9be6d8f3935c724f4816"


def replay(source):
    raw = source.read_bytes() if source else urllib.request.urlopen(URL, timeout=30).read()
    if hashlib.sha256(raw).hexdigest() != SHA:
        raise ValueError("Reference RTL checksum mismatch")
    program = json.loads((ROOT / "program.json").read_text())
    commands = [(int(cmd.get("nop", False)) << 63) | (program["address"] << 48) |
                ((cmd["word"] % 65536) << 32) | cmd["tick"] for cmd in program["instructions"]]
    with TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "dio24_timing.v").write_bytes(raw)
        (work / "program.hex").write_text("".join(f"{word:017x}\n" for word in commands))
        # Unelaborated external FIFO/CDC instances are isolated by the testbench.
        iv = [os.getenv("IVERILOG", "iverilog")]
        if lib := os.getenv("IVERILOG_LIB"):
            iv.extend(["-B", lib])
        subprocess.run(iv + ["-g2012", "-i", "-s", "pins_tb", "-o", "pins.vvp",
                             str(ROOT / "pins_tb.v"), "dio24_timing.v"], cwd=work, check=True)
        sim = subprocess.run([os.getenv("VVP", "vvp"), "pins.vvp"], cwd=work,
                             capture_output=True, text=True, check=True)
    if "COMPLETED" not in sim.stdout.splitlines():
        raise ValueError("Reference HDL failed to complete")
    pins = []
    for line in sim.stdout.splitlines():
        if line.startswith("PINS "):
            ns, address, value, strobe = map(int, line.split()[1:])
            pins.append(dict(atPs=ns * 1000, address=address, word=value, strobe=strobe))
    if not pins:
        raise ValueError("No observed transitions")
    origin = pins[0]["atPs"]
    for row in pins:
        row["atPs"] -= origin
    return dict(revision=REV, member=MEMBER, sha256=SHA, origin="first change of output data",
                timeGridPs=program["clockPs"], pins=pins)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, help="Verified local copy of the upstream module")
    parser.add_argument("--write", action="store_true", help="Replace the archived RTL result")
    args = parser.parse_args()
    result = replay(args.source)
    target = ROOT / "pins.json"
    if args.write:
        target.write_bytes((json.dumps(result, indent=2) + "\n").encode())
    elif result != json.loads(target.read_text()):
        raise SystemExit("Published timing-core simulation differs from the archived pin sequence")
    print(f"Replayed {len(result['pins'])} RTL pin transitions.")
