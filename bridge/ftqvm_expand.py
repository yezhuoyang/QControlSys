"""Expand a QSysASM (.sysprog) listing into its concrete timed operations, as JSON.

The compiler's own reader and expander are used unchanged: this script imports `ftq_vm.sysprog` from
the fault-tolerant compiler's checkout (FT_COMPILER_ROOT, or the path in ft-compiler.local) and
prints what `parse_source` and `expand` produce. QuantumOS never re-implements the listing's
semantics; it executes what the compiler says the listing is.

Usage: python bridge/ftqvm_expand.py LISTING.sysprog [--max-ops N] [--guards taken]
Output: {"source": {...}, "machine": {...}, "specs": {...}, "ops": [...], "calls": [...]}
Errors are printed as {"error": {"code", "message", "line"}} with exit status 1.

Units: every time is an integer number of nanoseconds, as in the listing.
`ftq_vm.sysprog` is the compiler's Python VM, a test oracle there; by default it refuses runtime guards
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


def _compiler_root_path():
    """The fault-tolerant compiler's checkout: FT_COMPILER_ROOT, else the first line of the
    git-ignored file ft-compiler.local at the repository root."""
    if os.environ.get("FT_COMPILER_ROOT"):
        return Path(os.environ["FT_COMPILER_ROOT"]).resolve()
    local = HERE.parent / "ft-compiler.local"
    line = local.read_text(encoding="utf-8").strip().splitlines()[:1] if local.is_file() else []
    return (HERE.parent / (line[0].strip() if line else "ft-compiler")).resolve()


def compiler_root():
    root = _compiler_root_path()
    if not (root / "ftq_vm" / "sysprog.py").is_file():
        raise SystemExit(json.dumps({"error": {"code": "FT_COMPILER_MISSING",
                                               "message": f"no compiler checkout at {root} (set FT_COMPILER_ROOT)"}}))
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
    root = compiler_root()
    sys.path.insert(0, str(root))
    from ftq_vm import sysprog  # The compiler, unchanged

    from scripts.program_sources import read_program_bytes  # The compiler's shared stage reader
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
        # With `--guards taken`, every guarded body is expanded, and each op carries the guards around
        # it, evaluated where the expander evaluated them: the guard's own bands, as concrete records,
        # from the compiler's `split` and `sites` in the guard's environment.
        enclosing = {}  # statement line -> the lines of the guards around it in its body, outer first
        instances = {}  # guard line -> [(stack, bands)], one per time the expander reached it
        def mark(node, line):
            for child in node.children:
                chain = enclosing.setdefault(child.line, [])
                if line not in chain:
                    chain.append(line)
                mark(child, line)
        def take(node, env, offset, stack):
            if node.line not in instances:
                mark(node, node.line)
            bands = []
            for band in sysprog.split(node.text[5:-1]):
                band = band.strip()
                negated = band.startswith("¬")
                records = sysprog.sites(band.lstrip("¬").strip(), env, node.line, records=True, allow_empty=True)
                bands.append({"negated": negated, "records": [site(r) for r in records]})
            instances.setdefault(node.line, []).append((tuple(stack), bands))
            return True
        if guards == "taken":
            ops, calls = sysprog._expand(source, max_ops, choose_guard=take)
        else:
            ops, calls = sysprog.expand(source, max_ops)

        def guard_of(op):
            """The guards around one op, as one conjunction of bands, outer first: the op's own body,
            then the bodies of the calls that reached it (each call's statement line)."""
            lines = [calls[cid].line for cid in op.frames] + [op.line]
            stack, bands, seen = tuple(op.stack), [], []
            for line in lines:
                for guard in enclosing.get(line, []):
                    # The instance of this guard whose stack the op's stack extends, the latest reached.
                    match = [b for s, b in instances.get(guard, []) if stack[:len(s)] == s]
                    if match and guard not in seen:
                        seen.append(guard)
                        bands.extend(max(((s, b) for s, b in instances[guard] if stack[:len(s)] == s), key=lambda x: len(x[0]))[1])
            return {"bands": bands, "lines": seen} if seen else None
    except sysprog.VMError as error:
        info = getattr(error, "info", {})
        print(json.dumps({"error": {"code": info.get("code"), "message": str(error),
                                    "line": info.get("line", 0)}}, default=str))
        return 1
    out = {
        "source": {"path": str(Path(path).resolve()), "sha256": source.sha256, "stripped": stripped, "guards": guards or "refused",
                   "params": list(source.params), "witness": dict(source.witness),
                   "compiler": str(root)},
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
            **({"guard": g} if (g := guard_of(op)) else {}),
        } for op in ops],
        "calls": [{"uid": c.uid, "name": c.name, "start": c.start, "end": c.end,
                   "line": c.line, "ops": [op.uid for op in c.ops]} for c in calls],
    }
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
