"""Replay ZAC activate/move:big/deactivate jobs and project one X move onto the Durham calibration."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from bench_common import execute
from neutral import experiment

PIN = "e5083362f99e6915f20c2bd0eaa88b6d1cdcecac"
BASE = f"https://github.com/UCLA-VAST/ZAC/blob/{PIN}/"
ARCH = "hardware_spec/full_architecture_2aod.json"
CODE = "result/zac/arch_eval/full_2aod/code/bv_n14_transpiled_code.json"
HASHES = {
    ARCH: "731c97ce108d2d1a85cf20303229db6ba845f3e06c13744a3b5d78474e0e08b6",
    CODE: "16c4c3dd2764776e79c5eadafd16c9372f9cf7067bf433602bd1b37252f055b1",
}


def pinned(path):
    data = (HERE / "zac" / Path(path).name).read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(data).hexdigest() != HASHES[path]:
        raise ValueError(f"Pinned upstream content differs: {path}")
    return json.loads(data)


def by_qubit(locations):
    sites = {q: tuple(site) for q, *site in locations}
    if len(locations) != len(sites) or len(set(sites.values())) != len(sites):
        raise ValueError("Duplicate qubit or occupied SLM site")
    return sites


def xy(slms, site):
    sid, row, col = site
    s = slms[sid]
    if not (0 <= row < s["r"] and 0 <= col < s["c"]):
        raise ValueError(f"Site outside native SLM {sid}: {row}, {col}")
    ox, oy = s["location"]
    dx, dy = s["site_seperation"]  # Upstream spelling.
    return [ox + col * dx, oy + row * dy]


def positions(grid):
    atoms = [atom for row in grid for atom in row if isinstance(atom, dict)]
    result = {atom["id"]: [atom["x"], atom["y"]] for atom in atoms}
    if len(atoms) != len(result):
        raise ValueError("Repeated atom in move coordinates")
    return result


def replay(architecture, code):
    slms = {s["id"]: s for key in ("storage_zones", "entanglement_zones")
            for zone in architecture[key] for s in zone["slms"]}
    aods = {a["id"]: a for a in architecture["aods"]}
    instructions = code["instructions"]
    if instructions[0]["type"] != "init":
        raise ValueError("Expected a native initialization record")
    if len({i["id"] for i in instructions}) != len(instructions):
        raise ValueError("Duplicate native instruction IDs")
    initial = by_qubit(instructions[0]["init_locs"])
    for site in initial.values():
        xy(slms, site)
    jobs = []
    for inst in instructions[1:]:
        if inst["type"] in ("1qGate", "rydberg"):
            continue
        if inst["type"] != "rearrangeJob" or inst["aod_id"] not in aods:
            raise ValueError("Unsupported instruction or unknown AOD")
        phases = inst["insts"]
        if [p["type"] for p in phases] != ["activate", "move:big", "deactivate"]:
            raise ValueError("This adapter requires one activation, big move and deactivation per job")
        load, move, store = phases
        if len({p["id"] for p in phases}) != len(phases):
            raise ValueError("Duplicate native phase IDs within job")
        if (load["begin_time"] != inst["begin_time"] or store["end_time"] != inst["end_time"]
                or any(p["begin_time"] >= p["end_time"] for p in phases)
                or any(a["end_time"] != b["begin_time"] for a, b in zip(phases, phases[1:]))):
            raise ValueError("Inconsistent transport phase times")
        src, dst = by_qubit(inst["begin_locs"]), by_qubit(inst["end_locs"])
        if set(src) != set(dst) or set(src) != set(inst["aod_qubits"]):
            raise ValueError("Transport has inconsistent qubit IDs")
        start, end = positions(move["begin_coord"]), positions(move["end_coord"])
        if start != {q: xy(slms, s) for q, s in src.items()} or end != {q: xy(slms, s) for q, s in dst.items()}:
            raise ValueError("Native move coordinate disagrees with its SLM site")
        for label, key in (("row", "y"), ("col", "x")):
            field = label + "_" + key
            tone_ids = move[label + "_id"]
            capacity = aods[inst["aod_id"]]["r" if key == "y" else "c"]
            if (len(set(tone_ids)) != len(tone_ids) or any(not 0 <= i < capacity for i in tone_ids)
                    or load[label + "_id"] != tone_ids or store[label + "_id"] != tone_ids
                    or load[field] != move[field + "_begin"]):
                raise ValueError("Native AOD tone IDs or pickup positions disagree")
            axis = 0 if key == "x" else 1
            begin_tones, end_tones = move[field + "_begin"], move[field + "_end"]
            if (len(set(begin_tones)) != len(tone_ids) or len(set(end_tones)) != len(tone_ids)
                    or len(begin_tones) != len(tone_ids) or len(end_tones) != len(tone_ids)):
                raise ValueError("Malformed native AOD tone array")
            transfer = dict(zip(begin_tones, end_tones))
            ordered = [transfer[v] for v in sorted(transfer)]
            if ordered != sorted(ordered) or any(transfer.get(start[q][axis]) != end[q][axis] for q in src):
                raise ValueError("Native tones cross or disagree with the carried atoms")
        jobs.append({"inst": inst, "src": src, "dst": dst, "start": start, "end": end})

    # Track shared storage and AOD ownership across chronologically interleaved jobs.
    # At coincident boundaries a completed store releases the AOD before a new pickup.
    stored = initial.copy()
    reserved = {}
    boundaries = []
    for j, job in enumerate(jobs):
        inst = job["inst"]
        boundaries.extend([(inst["begin_time"], 1, j), (inst["end_time"], 0, j)])
    for _, is_start, j in sorted(boundaries):
        job = jobs[j]
        aod = job["inst"]["aod_id"]
        if is_start:
            if aod in reserved or any(stored.get(q) != site for q, site in job["src"].items()):
                raise ValueError("AOD busy or pickup site does not contain the requested atom")
            reserved[aod] = j
            for q in job["src"]:
                del stored[q]
        else:
            if reserved.pop(aod, None) != j or set(stored.values()).intersection(job["dst"].values()):
                raise ValueError("Invalid AOD release or occupied destination")
            stored.update(job["dst"])
    if set(stored) != set(initial) or reserved:
        raise ValueError("A transport lost an atom or left an AOD reserved")
    return jobs


def selected_move(job):
    inst = job["inst"]
    q, = inst["aod_qubits"]
    a, b = job["start"][q], job["end"][q]
    events = []
    parent = None
    for p, name, path in zip(inst["insts"], ["load", "move", "store"], [[a, a], [a, b], [b, b]]):
        eid = f"job-{inst['id']}-inst-{p['id']}"
        events.append({
            "id": eid, "nativeId": p["id"], "nativeType": p["type"], "operation": name,
            "beginUs": p["begin_time"], "endUs": p["end_time"], "pathUm": path,
            "fromOwner": "SLM" if name == "load" else "AOD",
            "toOwner": "SLM" if name == "store" else "AOD",
            "parentWithinJob": parent,
        })
        parent = eid
    return {
        "job": inst["id"], "qubit": q, "aod": inst["aod_id"], "nativeDependencies": inst["dependency"],
        "sourceSite": list(job["src"][q]), "destinationSite": list(job["dst"][q]),
        "siteOrder": ["slm", "row", "column"], "pathUm": [a, b], "events": events,
    }


def project_x(move):
    inputs = experiment.cases()
    cal = [c for c in inputs if c["split"] == "calibration"]
    captures = execute([c["program"] for c in cal], "--capture-samples")
    params = experiment.fit(list(zip(cal, captures, strict=True)))
    a, b = move["pathUm"]
    dx = b[0] - a[0]
    start_mhz = experiment.REFERENCE_MHZ
    # Independently design the tone shift from reported optical constants, then
    # predict the resulting displacement using the centroid fit and emitted samples.
    end_mhz = start_mhz + dx / experiment.OPTICAL_SLOPE_UM_PER_MHZ
    limits = (min(c["appliedFrequencyMHz"] for c in cal), max(c["appliedFrequencyMHz"] for c in cal))
    if not all(limits[0] <= f <= limits[1] for f in (start_mhz, end_mhz)):
        raise ValueError("Chosen ZAC X displacement would require extrapolating the Durham calibration")
    traces = execute([experiment.tone_program(f) for f in (start_mhz, end_mhz)], "--capture-samples")
    measured_profile = [experiment.predict({}, t, params) for t in traces]
    delta = measured_profile[1] - measured_profile[0]
    return {
        "axis": "x", "commandedDeltaUm": dx, "nativeDeltaYUm": b[1] - a[1],
        "calibrationRangeMHz": list(limits), "nominalDriveMHz": [start_mhz, end_mhz],
        "deliveredMHz": [experiment.delivered_frequency_mhz(t) for t in traces],
        "predictedDeltaUm": delta, "predictedMinusCommandUm": delta - dx,
        "appliedPrograms": [t["program"] for t in traces],
        "note": "Projection of the ZAC X displacement onto the independent Durham apparatus. "
                "Native Y and transfer times are design coordinates. No measurement of this ZAC job is available.",
    }


def design():
    arch, code = pinned(ARCH), pinned(CODE)
    if code["architecture_spec_path"] != ARCH:
        raise ValueError("The ZAIR result names a different architecture")
    jobs = replay(arch, code)
    # First singleton job in the native instruction list, selected without reference to a fit residual.
    picked = selected_move(next(j for j in jobs if len(j["src"]) == 1))
    picked["projection"] = project_x(picked)
    return {
        "title": "ZAC Bernstein–Vazirani transport on the two-AOD architecture",
        "source": BASE + CODE, "architectureSource": BASE + ARCH, "revision": PIN,
        "lengthUnit": "µm", "timeUnit": "µs", "program": code["name"], "architecture": arch["name"],
        "qubits": len(code["instructions"][0]["init_locs"]), "aods": len(arch["aods"]),
        "replayedJobs": len(jobs), "replayedPhases": sum(len(j["inst"]["insts"]) for j in jobs),
        "selectedMove": picked, "sha256": HASHES, "license": "BSD-3-Clause",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE / "design.json")
    args = parser.parse_args()
    args.output.write_text(json.dumps(design(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
