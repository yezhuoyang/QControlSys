"""Submit only split membership, outcomes and predictions to the exact Lean scorer."""
import argparse
from decimal import Decimal
import json
from pathlib import Path
import subprocess

from bench_common import EXECUTABLE


RULES = {
    "qccd": {"kind": "absolute", "maxRmse": 12},
    "qccd-h2": {"kind": "absolute", "maxRmse": 0.15},
    "qccd-slow": {"kind": "absolute", "maxRmse": 0.10},
    "qccd-pair": {"kind": "absolute", "maxRmse": 10},
    "neutral": {"kind": "absolute", "maxRmse": 0.25},
    "superconducting": {"kind": "normalized", "maxNrmse": 0.15, "minR2": 0.75},
}


def make_witness(platform, rows):
    if platform not in RULES:
        raise ValueError(f"Unregistered physical benchmark {platform!r}")
    fields = ("id", "split", "observed", "predicted")
    return {
        "version": 1, "platform": platform, "rule": RULES[platform].copy(),
        "rows": [{field: row[field] for field in fields} for row in rows],
    }


def _exact_json(value):
    """A Decimal parsed from a published JSON report stays a numeric token with full precision."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Witness values must be finite")
        return str(value)
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k) + ":" + _exact_json(v) for k, v in value.items()) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_exact_json(v) for v in value) + "]"
    return json.dumps(value, allow_nan=False)


def score_witness(witness):
    scored = subprocess.run([str(EXECUTABLE), "--check-validation"], input=_exact_json(witness),
                            capture_output=True, encoding="utf-8", timeout=90)
    if scored.returncode:
        raise ValueError(scored.stderr.strip() or "Lean rejected the validation witness")
    return json.loads(scored.stdout)


def verify(platform, rows):
    """Return the native verdict. A well-formed witness can legitimately return passed=False."""
    return score_witness(make_witness(platform, rows))


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--report", type=Path, default=Path(__file__).with_name("results.json"))
    cli.add_argument("--platform", choices=RULES)
    args = cli.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"), parse_float=Decimal)
    platforms = [args.platform] if args.platform else list(report["experiments"])
    print(json.dumps({p: verify(p, report["experiments"][p]["rows"]) for p in platforms}, indent=2))
