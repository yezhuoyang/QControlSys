"""Compile one of the compiler's paper audits against a machine with some fields replaced.

The compiler is used unchanged: its staged compiler (the installed binary), the audit's own .qec stage,
recipe and paper point, exactly as its scripts/regenerate_paper_listings.py PAPERS table states
them. Only the machine file differs: a copy of the audit's machine with the given fields replaced,
written to the output folder. It runs from the compiler's root (as that script runs it);
everything it writes goes to the output folder.

Usage: python -I bridge/audit_variant.py PAPER OUT_DIR field=value [field=value ...]
  e.g. python -I bridge/audit_variant.py GE2021 output/audit/ge2021-v1 pauli_frame_update_ns=322 measure_ns=614
Writes OUT_DIR/<PAPER>.machine, OUT_DIR/<PAPER>.sysprog, out.txt, err.txt and result.json
({ seconds, exit, machine, replaced }).
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
def _compiler_root_path():
    """The fault-tolerant compiler's checkout: FT_COMPILER_ROOT, else the first line of the
    git-ignored file ft-compiler.local at the repository root."""
    if os.environ.get("FT_COMPILER_ROOT"):
        return Path(os.environ["FT_COMPILER_ROOT"]).resolve()
    local = HERE.parent / "ft-compiler.local"
    line = local.read_text(encoding="utf-8").strip().splitlines()[:1] if local.is_file() else []
    return (HERE.parent / (line[0].strip() if line else "ft-compiler")).resolve()


ROOT = _compiler_root_path()


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    paper, out = argv[0], Path(argv[1]).resolve()
    fields = dict(a.split("=", 1) for a in argv[2:])
    sys.path.insert(0, str(ROOT / "scripts"))
    import regenerate_paper_listings as regen  # The compiler's own recipe table, read only

    cfg = regen.PAPERS[paper]
    out.mkdir(parents=True, exist_ok=True)
    machine_text = (ROOT / cfg["machine"]).read_text(encoding="utf-8")
    replaced = {}
    for name, value in fields.items():
        pattern = re.compile(r"(\b" + re.escape(name) + r":\s*)([0-9.]+)")
        if not pattern.search(machine_text):
            raise SystemExit(f"field {name} not in the machine's text")
        replaced[name] = {"was": pattern.search(machine_text).group(2), "now": value}
        machine_text = pattern.sub(lambda m: m.group(1) + value, machine_text, count=1)
    machine = out / f"{paper}.machine"
    machine.write_text(machine_text, encoding="utf-8")
    exe = out / ("qec_sys_staged_bigstack.exe" if os.name == "nt" else "qec_sys_staged")
    if not exe.exists():
        if os.name == "nt":
            regen.big_stack_copy(regen.DEFAULT_EXE, exe)
        else:
            import shutil
            shutil.copyfile(regen.DEFAULT_EXE, exe)
            exe.chmod(0o755)
    cmd = [str(exe), cfg["qec"], "--machine", str(machine)]
    if cfg.get("spec"):
        cmd += ["--system-spec", cfg["spec"]]
    cmd += ["-o", str(out / f"{paper}.sysprog"), "--maintenance", cfg["maintenance"]]
    if cfg["opts"]:
        cmd += ["--opt", cfg["opts"]]
    if cfg.get("point"):
        cmd += ["--point", cfg["point"]]
    env = {**os.environ, "SYSC_CLEAN_MEMO": "1", "SYSC_PROFILE": "1"}
    t0 = time.time()
    with open(out / "out.txt", "w", encoding="utf-8") as fo, open(out / "err.txt", "w", encoding="utf-8") as fe:
        rc = subprocess.run(cmd, cwd=ROOT, env=env, stdout=fo, stderr=fe).returncode
    result = {"paper": paper, "seconds": round(time.time() - t0), "exit": rc, "machine": str(machine), "replaced": replaced, "command": cmd}
    (out / "result.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps(result))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
