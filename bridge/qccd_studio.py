"""Replay original QCCD Studio files for the 3D debugger.

Use Python 3.10+ and set QCCD_STUDIO_ROOT or place the QCCD checkout next to
QControlSys. stdin and stdout are UTF-8 JSON. --demo sends the original file
texts, including the extended numeric spelling in the compiler's metadata.
"""

import base64
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(
    os.environ.get("QCCD_STUDIO_ROOT", Path(__file__).resolve().parents[2] / "QCCD")
).resolve()
MAX_INPUT = 8 * 1024 * 1024
MAX_NODES = 4096
MAX_CYCLES = 20000
MAX_ION_CYCLES = 1_500_000


def document(value, name):
    if isinstance(value, str):

        def unique(pairs):
            result = {}
            for key, item in pairs:
                if key in result:
                    raise ValueError(f"{name}: duplicate key {key!r}")
                result[key] = item
            return result

        value = json.loads(value.removeprefix("\ufeff"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise TypeError(f"{name} must be a JSON document")
    return value


def limit_geometry(params):
    # Bound expansion before handing compact generators to the reference API.
    dims = ["a", "b", "spacing", "n", "width", "height", "straight", "verticals"]
    for key in dims:
        if key in params and (
            type(params[key]) is not int or abs(params[key]) > MAX_NODES
        ):
            raise ValueError(f"geometry parameter {key} exceeds the preview range")
    if params.get("a", 1) * params.get("b", 1) * params.get("spacing", 1) > MAX_NODES:
        raise ValueError("generated lattice exceeds the preview range")


def studio_sources(doc, program_input):
    from qccd.api import Machine
    from qccd.arch.generators import GENERATORS
    from qccd.workspace.design import DesignState, replay

    design = DesignState.from_studio(doc)
    # Studio's from_template dispatches by constructor name. Only in-memory
    # generators can be selected here. Resolve named templates against a fixed
    # table of shipped files, rather than interpreting a submitted path.
    shipped = {
        p.name.removesuffix(".arch.json"): p
        for p in (ROOT / "arch").glob("*.arch.json")
    }
    for call in design.base_calls():
        method = call["method"]
        args, kwargs = call["args"], call["kwargs"]
        if method in ("blank", "from_template"):
            generator = args[0] if args else kwargs.get("generator")
            if (
                generator not in GENERATORS
                or method == "from_template"
                and not hasattr(Machine, generator)
            ):
                raise ValueError(f"unknown Studio geometry generator {generator!r}")
            limit_geometry(kwargs)
        if method in ("from_template", "from_device"):
            template = kwargs.get("template")
            if isinstance(template, str):
                if template not in shipped:
                    raise ValueError(
                        "Studio seed must reference a shipped template by name or embed it"
                    )
                payload = json.loads(shipped[template].read_bytes())
                kwargs["template"] = {
                    k: v
                    for k, v in payload.items()
                    if k not in ("geometry", "name", "description", "provenance")
                }
            elif template is not None and not isinstance(template, dict):
                raise ValueError("invalid template declaration")
    if len(design.base_calls()) + len(design.edits) > 4 * MAX_NODES:
        raise ValueError("Studio design exceeds the preview statement limit")
    built = replay(design, strict=True)
    ref = design.final_program or {}
    if ref.get("compiled_for") and ref["compiled_for"] != built.arch_digest():
        raise ValueError(
            "Studio's compiled_for digest differs from the replayed machine"
        )
    if ref.get("artifact"):
        if not isinstance(program_input, str):
            raise ValueError(
                "include the original compiled TSIR file named by this Studio artifact"
            )
        actual = "sha256:" + hashlib.sha256(program_input.encode("utf-8")).hexdigest()
        if actual != ref["artifact"]:
            raise ValueError(
                "compiled TSIR file differs from the Studio artifact digest"
            )
    if program_input is None:
        program_input = (
            Machine(built.arch)
            .program("authored", provenance="off")
            .apply_calls(design.program)
            .build()
            .to_json()
        )
    return built.arch, program_input


def reference_h2(arch):
    """Only the published reconstruction's nodes and routes inherit its scale."""
    if (
        arch.provenance.get("paper") != "2305.03828"
        or arch.provenance.get("pitch_um") != 750
    ):
        return False
    path = ROOT / "Reproduce" / "moses2023" / "h2.arch.json"
    if not path.is_file():
        return False
    expected = json.loads(path.read_bytes())["geometry"]
    return {n.id: tuple(n.pos) for n in arch.device.nodes.values()} == {
        n["id"]: tuple(n["pos"]) for n in expected["nodes"]
    } and {s.id: tuple(s.ends) for s in arch.device.segments.values()} == {
        s["id"]: tuple(s["ends"]) for s in expected["segments"]
    }


def machine_data(arch, calibrated):
    nodes = []
    for node in arch.device.nodes.values():
        if len(node.pos) not in (2, 3) or not all(map(math.isfinite, node.pos)):
            raise ValueError(f"node {node.id} needs a finite 2D or 3D position")
        nodes.append(
            {
                "id": node.id,
                "pos": [*node.pos, *([0] if len(node.pos) == 2 else [])],
                "kind": node.kind,
                "zone": node.zone_type,
                "capacity": node.capacity,
                "gate": arch.can(node.id, "gate"),
            }
        )
    segments = [
        {"id": s.id, "a": s.ends[0], "b": s.ends[1]}
        for s in arch.device.segments.values()
    ]
    note = "Coordinates follow the architecture's native layout. The electrode cross-section and ion sizes are schematic."
    if calibrated:
        note = "H2 coordinates are in 750 µm gate pitches. Conveyor well locations are figure estimates. Ion sizes and electrode heights are schematic."
    return {
        "name": arch.name,
        "nodes": nodes,
        "segments": segments,
        "geometryNote": note,
    }


def program_limits(prog, arch):
    node_count = len(arch.device.nodes)
    if node_count > MAX_NODES:
        raise ValueError(f"preview accepts up to {MAX_NODES} architecture nodes")
    channels = arch.control.get("channels") or {}
    roles = channels.get("roles", ["linear"])
    count = (
        sum(map(int, roles.values()))
        if isinstance(roles, dict)
        else len(roles) * int(channels.get("channels_per_role", 1))
    )
    if channels.get("grouping", "direct") != "broadcast":
        count *= node_count
    if count * int(channels.get("differential", 1)) > 100_000:
        raise ValueError("declared channel bank exceeds preview capacity")
    ion_names = {ion for instr in prog.instructions for ion in instr.placement}
    cycles = sum(
        max(1, abs(int((i.template or {}).get("delta", 1)))) for i in prog.instructions
    )
    if cycles > MAX_CYCLES or cycles * len(ion_names) > MAX_ION_CYCLES:
        raise ValueError(
            "program exceeds the expanded cycle or ion-cycle preview limit"
        )
    if any(abs(i.id) > 2**53 - 1 for i in prog.instructions):
        raise ValueError("TSIR instruction ID exceeds exact browser integer range")


def control_data(record):
    return {
        "driver": record.driver,
        "action": record.action,
        "channelsEngaged": record.channels_engaged,
        "channelsTotal": record.channels_total,
        "feasible": record.feasible,
        "banks": [
            {
                "channels": list(bank.ids),
                "role": bank.role,
                "action": bank.action,
                "actingPerChannel": bank.acting,
                "fanoutPerChannel": bank.fanout,
            }
            for bank in record.banks
        ],
    }


def strict_display(value):
    # The raw source stays with the caller. Annotate extended numbers in the
    # human-readable source inspect pane, never silently coerce them to zero.
    if isinstance(value, dict):
        return {k: strict_display(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strict_display(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value).replace("inf", "Infinity").replace("nan", "NaN")
    return value


def read_program(request):
    from qccd.arch import Architecture
    from qccd.ir.tsir import TSIR, validate_program

    design = document(
        request.get("architecture", request.get("studio")), "architecture"
    )
    source = request.get("program")
    if design.get("kind") == "qccd.studio":
        arch, source = studio_sources(design, source)
    else:
        geometry = design.get("geometry", {})
        limit_geometry(geometry.get("params", {}))
        if len(geometry.get("nodes", [])) > MAX_NODES:
            raise ValueError(f"preview accepts up to {MAX_NODES} architecture nodes")
        arch = Architecture.from_json(design)
    source = document(source, "TSIR program")
    if not isinstance(source.get("instructions"), list):
        raise TypeError("TSIR program needs an instructions array")
    for n, row in enumerate(source["instructions"]):
        if not isinstance(row, dict) or type(row.get("id")) is not int:
            raise ValueError(f"instructions[{n}] needs an integer source ID")
    prog = TSIR.from_json(source)
    errors = validate_program(prog)
    if errors:
        raise ValueError("\n".join(errors[:12]))
    program_limits(prog, arch)
    return design, arch, prog, source


def native_page(design, arch, prog, model, source, *, has_tsir, calibrated):
    from qccd.verify import verify
    from qccd.verify.control import assemble_trace, control_record
    from qccd.viz import render_html
    from qccd.viz.scale import DEFAULT_TECH, load_preset

    # Native Studio needs one folded control record per TSIR instruction. Its
    # own assembler handles multi-hop cycles and opcodes without callbacks.
    records = {}

    def collect(view):
        rows = records.setdefault(view.instr.id, [])
        rows.append(control_record(view, hop=len(rows)))

    result = verify(prog, arch, model, on_cycle=collect).result
    controls = assemble_trace(prog, arch, records)
    # The renderer includes its own machine and the default template. Bring
    # along any additional shipped templates a saved design actually names.
    stems = set()
    if not has_tsir:
        shipped = {
            p.name.removesuffix(".arch.json")
            for p in (ROOT / "arch").glob("*.arch.json")
        }
        calls = [
            *(design.get("geom") or []),
            design.get("seed"),
            *(design.get("post") or []),
        ]
        for call in calls:
            if call and call.get("method") in ("from_template", "from_device"):
                stem = (call.get("kwargs") or {}).get("template")
                if isinstance(stem, str) and stem in shipped:
                    stems.add(stem)
    tech = None
    if calibrated:
        from qccd.phys.tech import Dim

        scale = Dim(
            750000, arch.provenance.get("pitch_source") or "Moses et al., Sec. II.A"
        )
        tech = replace(
            load_preset(DEFAULT_TECH),
            name="H2 pitch, schematic electrodes",
            nm_per_unit_x=scale,
            nm_per_unit_y=scale,
        )
    with tempfile.TemporaryDirectory(prefix="qcontrol-studio-") as temp:
        path = Path(temp) / "studio.html"
        render_html(
            arch,
            prog,
            result,
            model,
            path,
            stage3d="always",
            template_stems=sorted(stems),
            control=controls,
            tech=tech,
        )
        page = path.read_text(encoding="utf-8")
    handoff = {}
    if has_tsir:
        # Use the original typed instructions to export a compiled program. The
        # native frame-to-TSIR exporter only retains part of the operand data.
        handoff["compiled"] = strict_display(source)
    else:
        # A native project restores its seed, edits, authored calls and cursor.
        # With an external TSIR, restoring a different seed would replace the
        # compiled program already on the Studio page with the authored calls.
        snapshot = {
            k: design.get(k)
            for k in ("kind", "version", "geom", "seed", "post", "edits", "program")
        }
        if type(design.get("saved_at_frame")) is int:
            snapshot["saved_at_frame"] = min(
                max(0, design["saved_at_frame"]), max(0, len(prog.instructions) - 1)
            )
        handoff["snapshot"] = snapshot
    raw = json.dumps(
        handoff, allow_nan=False, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    encoded = base64.b64encode(raw).decode("ascii")
    adapter = Path(__file__).with_name("studio-handoff.js").read_text(encoding="utf-8")
    page = page.replace(
        "</body></html>",
        "<script>"
        + adapter.replace("ENCODED_DOCUMENT", encoded)
        + "</script></body></html>",
    )
    return {"html": page}


def execute(request, *, as_page=False):
    from qccd.cost import corrected_model
    from qccd.ir.tsir import iter_operands
    from qccd.verify import verify
    from qccd.verify.control import control_record, idle_record

    design, arch, prog, source = read_program(request)
    calibrated = reference_h2(arch)
    geometry = machine_data(arch, calibrated)
    model = corrected_model(table="local")
    if as_page:
        return native_page(
            design,
            arch,
            prog,
            model,
            source,
            has_tsir=request.get("program") is not None,
            calibrated=calibrated,
        )
    frames = []
    positions = {}
    substeps = {}
    indices = {i.id: idx for idx, i in enumerate(prog.instructions)}
    current = None

    def append(instr, changes, moves, ions, targets, control):
        substep = substeps.get(instr.id, 0)
        substeps[instr.id] = substep + 1
        frame_id = f"tsir-{instr.id}-{substep}"
        frames.append(
            {
                "id": frame_id,
                "sourceIndex": indices[instr.id],
                "sourceId": instr.id,
                "substep": substep,
                "op": instr.type,
                "label": instr.gate or instr.cls or instr.type,
                "parents": [frames[-1]["id"]] if frames else [],
                "positions": changes,
                "moves": moves,
                "ions": list(dict.fromkeys(ions)),
                "targets": sorted(set(targets)),
                "control": control_data(control),
            }
        )
        positions.update(changes)

    def before(instr, _quanta):
        nonlocal current
        current = instr
        # These three opcodes are zero-duration entries in the upstream cycle
        # ledger, so they don't get an on_cycle callback. A later init can re-place.
        if instr.type in ("init", "barrier", "decode"):
            changes = {
                i: n for i, n in instr.placement.items() if positions.get(i) != n
            }
            targets = set(instr.placement.values()) | {
                positions[i] for i in instr.ions if i in positions
            }
            append(
                instr,
                changes,
                [],
                list(instr.placement) or instr.ions,
                targets,
                idle_record(instr, arch),
            )

    def cycle(view):
        if positions != view.pos_before:
            raise ValueError(
                "trace position reconstruction disagrees with Studio before this cycle"
            )
        instr = view.instr
        changes = {i: n for i, n in view.pos_after.items() if positions.get(i) != n}
        routes = {}
        targets = set()
        for m in view.moves:
            route = routes.setdefault(m.ion, {"ion": m.ion, "from": m.src, "via": []})
            route["via"].append(m.seg.id)
            route["to"] = m.dst
            targets.update((m.src, m.dst))
        ions = list(routes) if instr.type == "simd" else list(instr.ions)
        if view.c2lr and view.c2lr.template:
            ions = sorted(view.c2lr.heated)
        if instr.type == "gate":
            ions = [i for operand in iter_operands(instr) for i in operand]
        if instr.type == "cool" and instr.broadcast and not ions:
            ions = list(positions)
        targets.update(positions[i] for i in ions if i in positions)
        append(
            instr,
            changes,
            list(routes.values()),
            ions,
            targets,
            control_record(view, with_ids=True),
        )

    try:
        report = verify(prog, arch, model, on_cycle=cycle, probe=before)
    except (
        ValueError,
        TypeError,
        KeyError,
        RuntimeError,
        IndexError,
        ArithmeticError,
    ) as exc:
        context = (
            f"TSIR {current.id} ({current.type})" if current is not None else "machine"
        )
        raise ValueError(f"{context}: {exc}") from None
    result = report.result
    if len(frames) != len(result.cycles) or positions != result.final_positions:
        raise ValueError("trace differs from Studio's final positions or cycle count")
    system = None
    if calibrated:
        manifest = (
            Path(__file__).resolve().parents[1] / "physical" / "qccd-installation.json"
        )
        system = json.loads(manifest.read_bytes())
    for frame, record in zip(frames, result.cycles):
        if frame["sourceId"] != record.instr_id or frame["op"] != record.type:
            raise ValueError("cycle order differs from Studio's replay")
        frame.update(start=record.t0, end=record.t1)
        if system:
            bindings = system["studioBindings"]
            frame["physicalParts"] = bindings["driver"].get(
                frame["control"]["driver"],
                bindings["operation"].get(frame["op"], bindings["default"]),
            )
    rules = report.rules.summary()
    rules["details"] = [
        {
            "rule": v.rule,
            "sourceId": v.instr_id,
            "message": v.message,
            "severity": v.severity,
        }
        for v in report.rules.violations
    ]
    timing_note = arch.provenance.get("times", "")
    unit_time = "unit time" in str(timing_note).lower()
    if not timing_note:
        timing_note = "Durations use the machine's declared primitives and Studio's corrected local model."
    try:
        revision = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            timeout=2,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        revision = None
    return {
        "schema": "qcontrol.qccd-studio.v1",
        "engine": {
            "name": "qccd.verify.verify",
            "revision": revision,
            "model": strict_display(model.describe()),
        },
        "machine": geometry,
        "system": system,
        "program": {"name": prog.name, "instructions": len(prog.instructions)},
        "timing": {
            "unit": "model units" if unit_time else "model µs",
            "note": timing_note,
        },
        "sourceInstructions": strict_display(source["instructions"]),
        "initial": {"positions": {}},
        "frames": frames,
        "final": {"positions": positions},
        "rules": rules,
        "summary": {
            "ions": len(positions),
            "cycles": len(frames),
            "gatePairs": result.n_gate_pairs,
            "measurements": result.n_measure,
            "ruleViolations": len(report.rules.violations),
        },
    }


def main():
    if not (ROOT / "qccd" / "verify" / "replay.py").is_file():
        raise ValueError(
            "QCCD Studio checkout missing. Set QCCD_STUDIO_ROOT to the QCCD repository or place it beside QControlSys."
        )
    sys.path.insert(0, str(ROOT))
    if sys.argv[1:] == ["--demo"]:
        demo = ROOT / "Reproduce" / "moses2023"
        return {
            key: (demo / path).read_bytes().decode("utf-8")
            for key, path in (
                ("architecture", "h2.arch.json"),
                ("program", "demo/ghz32.tsir.json"),
            )
        }
    if sys.argv[1:] not in ([], ["--studio-html"]):
        raise ValueError("expected no arguments, --demo or --studio-html")
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError("request exceeds 8 MiB")
    return execute(
        document(data.decode("utf-8-sig"), "request"), as_page=bool(sys.argv[1:])
    )


if __name__ == "__main__":
    try:
        output = json.dumps(
            main(), ensure_ascii=True, allow_nan=False, separators=(",", ":")
        )
    except (
        OSError,
        ImportError,
        ValueError,
        TypeError,
        KeyError,
        RuntimeError,
        IndexError,
        AttributeError,
        ArithmeticError,
    ) as error:
        print(
            json.dumps({"error": str(error) or type(error).__name__}, ensure_ascii=True)
        )
        sys.exit(1)
    print(output)
