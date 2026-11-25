"""Expand a FormalRV .sysprog listing into its concrete timed operations, as JSON.

FormalRV's own reader and expander are used unchanged: this script imports `ftq_vm.sysprog` from
the FormalRV checkout (a sibling folder `FormalRV`, or the directory named by FORMALRV_ROOT) and
prints what `parse_source` and `expand` produce. QuantumOS never re-implements the listing's
semantics; it executes what FormalRV says the listing is.

Usage: python bridge/ftqvm_expand.py LISTING.sysprog [--max-ops N] [--guards taken]
Output: {"source": {...}, "machine": {...}, "specs": {...}, "ops": [...], "calls": [...]}
Errors are printed as {"error": {"code", "message", "line"}} with exit status 1.

Units: every time is an integer number of nanoseconds, as in the listing.
`ftq_vm.sysprog` is FormalRV's Python VM, a test oracle there; by default it refuses runtime guards
(`when`). With `--guards taken` (or QUANTUMOS_GUARDS=taken) its own guard hook (`_expand`'s
`choose_guard`) takes every guarded body, as the VM reserves resources for it, and each op written
inside a guard carries `guard`: the guard's text and line, so a runtime can drop it when the measured
bits say the guard is false.
"""
import json
import re
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def formalrv_root():
    root = Path(os.environ.get("FORMALRV_ROOT", HERE.parents[1] / "FormalRV")).resolve()
    if not (root / "ftq_vm" / "sysprog.py").is_file():
        raise SystemExit(json.dumps({"error": {"code": "FORMALRV_MISSING",
                                               "message": f"no FormalRV checkout at {root}"}}))
    return root


def site(key):
    register, index = key
    return {"register": register, "index": index}


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    path, max_ops = argv[0], 1_000_000
    if "--max-ops" in argv:
        max_ops = int(argv[argv.index("--max-ops") + 1])
    guards = argv[argv.index("--guards") + 1] if "--guards" in argv else os.environ.get("QUANTUMOS_GUARDS", "")
    root = formalrv_root()
    sys.path.insert(0, str(root))
    from ftq_vm import sysprog  # FormalRV, unchanged

    from scripts.program_sources import read_program_bytes  # FormalRV's shared stage reader
    stripped = []
    try:
        # The staged back end writes background maintenance (`spec maintenance`, `maintenance …`)
        # and whole-block requests (`request_ancilla … patch`), which this reader does not parse.
        # They change how services are reserved for idle blocks and add no operation, so the
        # operations are read from a copy without them; every removal is recorded in `stripped`.
        text = read_program_bytes(path).decode("utf-8-sig").splitlines()
        kept, skip = [], False
        for line in text:
            if line.startswith("spec maintenance"):
                skip = True
                stripped.append("spec maintenance")
                continue
            if skip and line.startswith("  "):
                continue
            skip = False
            if line.strip().startswith("maintenance "):
                stripped.append(line.strip())
                continue
            if ("request_ancilla" in line or "release_ancilla" in line) and re.search(r"\bpatch\b", line):
                line = re.sub(r"\s+patch\b", "", line)
                if "patch" not in stripped:
                    stripped.append("patch")
            kept.append(line)
        if stripped:
            import tempfile
            copy = Path(tempfile.mkdtemp()) / Path(path).name
            copy.write_text(chr(10).join(kept) + chr(10), encoding="utf-8")
            source = sysprog.parse_source(str(copy))
        else:
            source = sysprog.parse_source(path)
        # The statement of every line, as the expander numbered them: Pauli tags such as
        # `CZ ancilla[1], Z data[0]` and frame Paulis are read from it.
        lines = kept
        guarded = {}  # line of a statement inside a guard -> the guard (text, line)
        if guards == "taken":
            def mark(node, guard):
                for child in node.children:
                    guarded.setdefault(child.line, guard)
                    mark(child, guard)
            def take(node, env, offset, stack):
                mark(node, {"text": node.text, "line": node.line})
                return True
            ops, calls = sysprog._expand(source, max_ops, choose_guard=take)
        else:
            ops, calls = sysprog.expand(source, max_ops)
    except sysprog.VMError as error:
        info = getattr(error, "info", {})
        print(json.dumps({"error": {"code": info.get("code"), "message": str(error),
                                    "line": info.get("line", 0)}}, default=str))
        return 1
    out = {
        "source": {"path": str(Path(path).resolve()), "sha256": source.sha256, "stripped": stripped, "guards": guards or "refused",
                   "params": list(source.params), "witness": dict(source.witness),
                   "formalrv": str(root)},
        "machine": source.machine,
        "specs": {name: {k: v for k, v in spec.items()} if isinstance(spec, dict) else str(spec)
                  for name, spec in source.specs.items()},
        "ops": [{
            "uid": op.uid, "order": op.order, "kind": op.kind,
            "start": op.start, "duration": op.duration, "end": op.end,
            "qubits": [site(q) for q in op.qubits], "work": [site(q) for q in op.work],
            "reads": [site(r) for r in op.reads], "writes": [site(w) for w in op.writes],
            "arg": op.arg, "inputNs": op.input_ns, "line": op.line,
            "text": lines[op.line - 1].split("#", 1)[0].strip() if 0 < op.line <= len(lines) else "",
            "stack": [str(s) for s in op.stack],
            **({"guard": guarded[op.line]} if op.line in guarded else {}),
        } for op in ops],
        "calls": [{"uid": c.uid, "name": c.name, "start": c.start, "end": c.end,
                   "line": c.line, "ops": [op.uid for op in c.ops]} for c in calls],
    }
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
