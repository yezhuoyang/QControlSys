"""Run with python -B -m unittest discover -s validation/neutral -p test_zac.py."""

import copy
import json
import unittest

import zac_adapter as zac


class ZACReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.arch = zac.pinned(zac.ARCH)
        cls.code = zac.pinned(zac.CODE)

    def test_replays_all_transfers_and_both_aods(self):
        jobs = zac.replay(self.arch, self.code)
        self.assertEqual(len(jobs), 26)
        self.assertEqual({j["inst"]["aod_id"] for j in jobs}, {0, 1})
        selected = zac.selected_move(next(j for j in jobs if len(j["src"]) == 1))
        self.assertEqual(selected["sourceSite"], [1, 0, 0])
        self.assertEqual(selected["destinationSite"], [0, 99, 13])
        self.assertEqual(selected["pathUm"], [[35, 307], [39, 297]])
        self.assertEqual([e["operation"] for e in selected["events"]], ["load", "move", "store"])

    def test_rejects_disagreement_with_architecture_and_switched_tone_tracks(self):
        code = copy.deepcopy(self.code)
        job = next(i for i in code["instructions"] if i["type"] == "rearrangeJob")
        move = job["insts"][1]
        move["end_coord"][0][0]["x"] += 1
        with self.assertRaisesRegex(ValueError, "coordinate disagrees"):
            zac.replay(self.arch, code)
        move["end_coord"][0][0]["x"] -= 1
        move["col_x_end"].reverse()
        with self.assertRaisesRegex(ValueError, "tones cross or disagree"):
            zac.replay(self.arch, code)

    def test_reference_projection_replays_from_actual_dac_samples(self):
        generated = zac.design()
        saved = json.loads((zac.HERE / "design.json").read_text(encoding="utf-8"))
        expected = saved["selectedMove"].pop("projection")
        actual = generated["selectedMove"].pop("projection")
        self.assertEqual(generated, saved)
        self.assertEqual(actual["appliedPrograms"], expected["appliedPrograms"])
        self.assertAlmostEqual(actual["predictedDeltaUm"], expected["predictedDeltaUm"], places=8)
        self.assertAlmostEqual(actual["predictedDeltaUm"], 4.08358, places=5)
        # Changing only delivered times lowers the measured tone frequency by two.
        trace = zac.execute(actual["appliedPrograms"][0])
        f = zac.experiment.delivered_frequency_mhz(trace)
        for step in trace["frames"]:
            step["atPs"] *= 2
        self.assertAlmostEqual(zac.experiment.delivered_frequency_mhz(trace), f / 2)


if __name__ == "__main__":
    unittest.main()
