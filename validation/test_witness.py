"""Exercise the actual Lean scorer, including exact boundary and invalid-input cases."""
import copy
from decimal import Decimal
from fractions import Fraction
import json
from pathlib import Path
import unittest

from witness import make_witness, score_witness, verify


def observations(observed, predicted):
    rows = [{"id": "train", "split": "calibration", "observed": 13, "predicted": -809}]
    rows.extend({"id": f"test-{i}", "split": "holdout", "observed": o, "predicted": p}
                for i, (o, p) in enumerate(zip(observed, predicted, strict=True)))
    return rows


def as_fraction(value):
    return Fraction(int(value["numerator"]), int(value["denominator"]))


class NativeScoring(unittest.TestCase):
    def test_decimal_boundary_and_training_isolation(self):
        rows = observations([1, 1], [Decimal("1.25"), Decimal("0.75")])
        scored = verify("neutral", rows)
        self.assertTrue(scored["passed"])
        self.assertEqual((scored["calibrationCount"], scored["holdoutCount"]), (1, 2))
        self.assertEqual(as_fraction(scored["meanSquaredError"]), Fraction(1, 16))
        rows[-1]["predicted"] = Decimal("0.7499999999999999999999999999")
        failed = verify("neutral", rows)
        self.assertTrue(failed["evaluated"])
        self.assertFalse(failed["passed"])

    def test_independent_normalized_boundaries(self):
        # Exactly 0.15 normalized RMSE with R² = 0.91.
        normalized = observations([0, 1], [Decimal(".15"), Decimal("1.15")])
        edge = verify("superconducting", normalized)
        self.assertTrue(edge["passed"])
        self.assertEqual(as_fraction(edge["r2"]), Fraction(91, 100))
        normalized[1]["predicted"] = Decimal("0.15000000000000000000000001")
        self.assertFalse(verify("superconducting", normalized)["passed"])

        # Exactly R² = 0.75 while the normalized RMSE remains below its threshold.
        actual = [-1, 1] + [0] * 14
        boundary = observations(actual, [-0.5, 1.5] + [0] * 14)
        score = verify("superconducting", boundary)
        self.assertTrue(score["passed"])
        self.assertEqual(as_fraction(score["r2"]), Fraction(3, 4))
        boundary[1]["predicted"] = Decimal("-0.499999999999999999999999")
        failed = verify("superconducting", boundary)
        self.assertFalse(failed["passed"])
        self.assertLess(as_fraction(failed["normalizedMeanSquaredError"]), Fraction(9, 400))

    def test_independent_qccd_profiles_use_their_registered_units(self):
        for platform, boundary in (("qccd", 12), ("qccd-pair", 10), ("qccd-slow", Decimal("0.1"))):
            with self.subTest(platform=platform):
                self.assertTrue(verify(platform, observations([0], [boundary]))["passed"])
                self.assertFalse(verify(platform, observations([0], [boundary + 1]))["passed"])

    def test_rejects_malformed_witnesses(self):
        original = make_witness("neutral", observations([1], [1]))
        mutations = [
            lambda w: w.update(platform="unregistered"),
            lambda w: w.update(version=2),
            lambda w: w["rows"].clear(),
            lambda w: w["rows"].pop(0),
            lambda w: w["rows"].pop(),
            lambda w: w["rows"][1].update(id="train"),
            lambda w: w["rows"][1].update(id=" "),
            lambda w: w["rows"][1].update(split="test"),
            lambda w: w["rows"][0].update(observed="NaN"),
            lambda w: w["rows"][1].update(predicted=None),
            lambda w: w["rows"][1].update(predicted=True),
            lambda w: w["rows"][1].update(typo=1),
            lambda w: w["rule"].update(maxRmse=3),
            lambda w: w["rule"].update(maxError=3),
        ]
        for mutate in mutations:
            with self.subTest(change=mutate):
                altered = copy.deepcopy(original)
                mutate(altered)
                with self.assertRaises(ValueError):
                    score_witness(altered)
        with self.assertRaisesRegex(ValueError, "Range"):
            verify("superconducting", observations([1, 1], [1, 1]))
        with self.assertRaises(ValueError):
            verify("neutral", observations([Decimal("NaN")], [1]))

    def test_all_stored_decimal_reports_against_rationals(self):
        path = Path(__file__).with_name("results.json")
        reports = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)["experiments"]
        for platform, report in reports.items():
            with self.subTest(platform=platform):
                rows = report["rows"]
                held = [r for r in rows if r["split"] == "holdout"]
                sse = sum((Fraction(r["observed"]) - Fraction(r["predicted"])) ** 2 for r in held)
                result = verify(platform, rows)
                self.assertEqual(result["calibrationCount"], len(rows) - len(held))
                self.assertEqual(result["holdoutCount"], len(held))
                self.assertEqual(as_fraction(result["sumSquaredError"]), sse)
                self.assertEqual(as_fraction(result["meanSquaredError"]), sse / len(held))
                self.assertEqual(result["passed"], report["metrics"]["passed"])


if __name__ == "__main__":
    unittest.main()
