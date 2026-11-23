"""Replay sourced experiments on the executable controller and score held-out measurements."""

import argparse
import hashlib
import importlib
import json
import math
import sys
from pathlib import Path

from bench_common import ROOT, execute, strobes
from geometry import apparatus
from witness import verify

PLATFORMS = ("qccd", "neutral", "superconducting")
BENCHMARKS = {
    "qccd": ("qccd", "experiment"),
    "neutral": ("neutral", "experiment"),
    "superconducting": ("superconducting", "experiment"),
    "qccd-slow": ("qccd", "slow"),
    "qccd-pair": ("qccd", "pair"),
    "qccd-h2": ("qccd", "h2"),
}
sys.path.insert(0, str(ROOT))
REPORT = ROOT / "validation" / "results.json"


def digest(document):
    encoded = json.dumps(
        document, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(encoded.encode()).hexdigest()


def samples(programs):
    captures = {}
    keys = list(programs)
    for start in range(0, len(keys), 8):
        batch = keys[start : start + 8]
        runs = execute([programs[key] for key in batch], "--capture-samples")
        for key, trace in zip(batch, runs, strict=True):
            if trace["summary"]["stop"] != "halted" or trace["summary"]["underruns"]:
                raise ValueError(
                    "The reference program did not deliver its complete waveform."
                )
            if digest(trace["program"]) != key:
                raise ValueError("The native controller returned a different program.")
            captures[key] = trace
    return captures


def experiment(identifier):
    if identifier not in BENCHMARKS:
        raise ValueError("Unknown benchmark.")
    platform, module = BENCHMARKS[identifier]
    return importlib.import_module(f"validation.{platform}.{module}")


def inputs(case):
    return {name: value for name, value in case.items() if name != "observed"}


def drive_observables(identifier, model, config, trace):
    frames = strobes(trace)
    values = {"samples": len(frames), "underruns": trace["summary"]["underruns"]}
    if frames:
        volts = [f["state"]["outputUv"] for f in frames]
        values.update(
            firstStrobeNs=frames[0]["atNs"],
            lastStrobeNs=frames[-1]["atNs"],
            minimumUv=min(volts),
            maximumUv=max(volts),
        )
    if identifier == "neutral":
        values["deliveredRFMHz"] = model.delivered_frequency_mhz(trace)
    elif identifier == "superconducting":
        values["deliveredEnvelopeAreaVns"] = model.delivered_area(trace)
    elif identifier == "qccd":
        values["probeAveragedDisplacementUm"] = model.probe_displacement(config, trace)
    elif identifier == "qccd-slow":
        values["deliveredProbeDetuningKHz"] = model.delivered_setting(config, trace)
    elif identifier == "qccd-pair":
        out, back = model.responses(trace)
        values.update(
            outwardResponseMagnitudeUm=abs(out), returnResponseMagnitudeUm=abs(back)
        )
    elif identifier == "qccd-h2":
        rz, ry = model.delivered_angles(trace)
        values.update(
            deliveredRzRadians=rz,
            deliveredRyRadians=ry,
            analysisPhaseRadians=model.analysis_phase(trace),
        )
    return values


def benchmark(identifier):
    platform = BENCHMARKS[identifier][0]
    model = experiment(identifier)
    cases = list(model.cases())
    if len({case["id"] for case in cases}) != len(cases):
        raise ValueError("Duplicate observation identifier.")
    splits = {case["split"] for case in cases}
    if splits != {"calibration", "holdout"}:
        raise ValueError(
            "Each experiment needs distinct calibration and held-out observations."
        )
    programs = {digest(case["program"]): case["program"] for case in cases}
    traces = samples(programs)
    traces_by_id = {c["id"]: traces[digest(c["program"])] for c in cases}
    calibration = [
        (c, traces_by_id[c["id"]]) for c in cases if c["split"] == "calibration"
    ]
    params = model.fit(calibration)
    rows, held = [], []
    for case in cases:
        trace = traces_by_id[case["id"]]
        pred = model.predict(inputs(case), trace, params)
        observed = case["observed"]
        if not math.isfinite(pred) or not math.isfinite(observed):
            raise ValueError("An observable or prediction is nonfinite.")
        row = {k: v for k, v in case.items() if k != "program"}
        row.update(
            predicted=pred,
            residual=pred - observed,
            programHash=digest(case["program"]),
            sampleCount=trace["summary"]["samples"],
        )
        rows.append(row)
        if case["split"] == "holdout":
            held.append({**case, **row})
    metrics = model.assess(held)
    if type(metrics["passed"]) is not bool:
        raise ValueError("The held-out criterion must return a Boolean verdict.")
    errors = [r["residual"] for r in held]
    independent = verify(identifier, rows)
    if (
        independent["passed"] != metrics["passed"]
        or independent["holdoutCount"] != len(held)
        or independent["calibrationCount"] != len(calibration)
    ):
        raise ValueError(
            "Independent Lean scoring disagrees with the experiment assessment."
        )
    return {
        "platform": platform,
        "meta": model.META,
        "parameters": params,
        "metrics": metrics,
        "independentScore": independent,
        "calibrationCount": len(calibration),
        "holdoutCount": len(held),
        "rmse": math.sqrt(sum(e**2 for e in errors) / len(errors)),
        "maxError": max(map(abs, errors)),
        "rows": rows,
    }


def replay(request):
    if not isinstance(request, dict) or not all(
        isinstance(request.get(k), str) for k in ("platform", "case")
    ):
        raise ValueError("A replay needs a platform and observation ID.")
    platform = request["platform"]
    identifier = request.get("experiment", platform)
    if not isinstance(identifier, str):
        raise TypeError("Use a registered experiment ID.")
    model = experiment(identifier)
    if BENCHMARKS[identifier][0] != platform:
        raise ValueError("Wrong platform for this experiment.")
    report = json.loads(REPORT.read_text(encoding="utf8"))
    ref = report["experiments"][identifier]
    case = next((c for c in model.cases() if c["id"] == request["case"]), None)
    if case is None:
        raise ValueError("Unknown observation.")
    expected = next(row for row in ref["rows"] if row["id"] == case["id"])
    if (
        digest(case["program"]) != expected["programHash"]
        or case["observed"] != expected["observed"]
    ):
        raise ValueError("Experiment inputs changed. Regenerate the validation report.")
    program = request.get("program", case["program"])
    if not isinstance(program, dict) or program.get("kind") != "waveform-controller":
        raise ValueError("Expected a waveform-controller program.")
    trace = execute(program)
    # The general controller bench includes a QCCD installation. Each reference experiment
    # supplies its own apparatus view and should never inherit another apparatus by accident.
    trace.pop("system", None)
    original = digest(program) == expected["programHash"]
    prediction = None
    reason = None
    drive_values = {}
    if trace["summary"]["stop"] != "halted" or not strobes(trace):
        reason = "Playback did not finish with a delivered sample."
    else:
        try:
            config = inputs({**case, "program": program})
            drive_values = drive_observables(identifier, model, config, trace)
            prediction = model.predict(config, trace, ref["parameters"])
            if not math.isfinite(prediction):
                raise ValueError("Prediction is nonfinite.")
        except (ValueError, ArithmeticError) as exc:
            reason, prediction = str(exc), None
    if original and (
        prediction is None
        or not math.isclose(
            prediction, expected["predicted"], rel_tol=1e-9, abs_tol=1e-11
        )
    ):
        raise ValueError(
            "Replay differs from the recorded prediction. Regenerate the report."
        )
    endpoint_steps = [
        {
            "id": "drive-observable",
            "part": "drive",
            "op": "Reconstruct delivered drive",
            "atNs": None,
            "targets": ["analog", "drive-path"],
            "parents": [f["id"] for f in strobes(trace)],
            "state": drive_values
            if reason is None
            else {**drive_values, "diagnostic": reason},
        },
        {
            "id": "device-response",
            "part": "endpoint",
            "op": "Evaluate device response",
            "atNs": None,
            "targets": ["drive-path"],
            "parents": ["drive-observable"],
            "state": {
                "predicted": prediction,
                "unit": model.META["unit"],
                "diagnostic": reason,
            },
        },
    ]
    if original:
        endpoint_steps.append(
            {
                "id": "compare-observation",
                "part": "readout",
                "op": "Compare measurement",
                "atNs": None,
                "targets": ["return-path", "endpoint"],
                "parents": ["device-response"],
                "state": {
                    "observed": case["observed"],
                    "predicted": prediction,
                    "residual": prediction - case["observed"],
                    "unit": model.META["unit"],
                },
            }
        )
    return {
        "platform": platform,
        "experiment": identifier,
        "case": case["id"],
        "trace": trace,
        "referenceProgram": original,
        "source": model.META,
        "parameters": ref["parameters"],
        "split": case["split"] if original else None,
        "system": apparatus(platform, model.META, identifier),
        "analysisSteps": endpoint_steps,
        "predicted": prediction,
        "diagnostic": reason,
        "observed": case["observed"] if original else None,
        "residual": prediction - case["observed"]
        if original and prediction is not None
        else None,
    }


def verify_case(document):
    request = {
        "platform": document["platform"],
        "experiment": document["experiment"],
        "case": document["case"],
        "program": document["trace"]["program"],
    }
    expected = replay(request)
    for group, actual, reference in [
        ("controller", document["trace"]["frames"], expected["trace"]["frames"]),
        ("analysis", document["analysisSteps"], expected["analysisSteps"]),
    ]:
        if len(actual) != len(reference):
            raise ValueError(f"Different {group} step count.")
        for a, b in zip(actual, reference):
            if a != b:
                raise ValueError(f"Trace mismatch at {group} step {b['id']}.")
    if expected != document:
        raise ValueError(
            "Case header, physical layout, or measured comparison differs."
        )
    return {
        "verified": True,
        "platform": request["platform"],
        "case": request["case"],
        "steps": len(expected["trace"]["frames"]) + len(expected["analysisSteps"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--write", action="store_true", help="replace the checked-in measurement report"
    )
    group.add_argument(
        "--replay", action="store_true", help="read a JSON observation request on stdin"
    )
    group.add_argument(
        "--verify-case",
        action="store_true",
        help="recompute an exported case trace on stdin",
    )
    group.add_argument(
        "--check",
        action="store_true",
        help="return a failing status for a missed criterion",
    )
    parser.add_argument("--platform", choices=PLATFORMS)
    parser.add_argument("--experiment", choices=BENCHMARKS)
    options = parser.parse_args()
    if options.replay:
        print(
            json.dumps(
                replay(json.load(sys.stdin)), ensure_ascii=False, allow_nan=False
            )
        )
        return
    if options.verify_case:
        print(json.dumps(verify_case(json.load(sys.stdin))))
        return
    if (options.platform or options.experiment) and options.write:
        parser.error("--write requires all three experiments")
    ids = [
        k
        for k in BENCHMARKS
        if (not options.platform or BENCHMARKS[k][0] == options.platform)
        and (not options.experiment or k == options.experiment)
    ]
    if not ids:
        parser.error("The experiment belongs to a different platform.")
    report = {"version": 1, "experiments": {key: benchmark(key) for key in ids}}
    if options.write:
        import tempfile

        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf8", dir=REPORT.parent, delete=False, suffix=".tmp"
        ) as output:
            json.dump(report, output, indent=2, ensure_ascii=False, allow_nan=False)
            output.write("\n")
        Path(output.name).replace(REPORT)
    else:
        print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    if options.check and not all(
        r["metrics"]["passed"] for r in report["experiments"].values()
    ):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, OSError, KeyError) as err:
        sys.exit(str(err))
