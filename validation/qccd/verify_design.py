"""Check the recorded native H2 move and before/after state against QCCD Studio."""

import hashlib
import json
from pathlib import Path
import sys


HERE = Path(__file__).resolve().parent


def verify():
    sys.path.insert(0, str(HERE.parents[1] / "bridge"))
    import qccd_studio

    design = json.loads((HERE / "design.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(qccd_studio.ROOT))
    machine_files = {}
    for key in ("architecture", "program"):
        data = (qccd_studio.ROOT / design[key]).read_bytes()
        if hashlib.sha256(data).hexdigest() != design[key + "Sha256"]:
            raise ValueError(f"Native {key} differs from the pinned design")
        machine_files[key] = data.decode("utf-8")
    trace = qccd_studio.execute(machine_files)
    witness = design["frame"]
    before = dict(trace["initial"]["positions"])
    for frame in trace["frames"]:
        if frame["id"] == witness["id"]:
            break
        before.update(frame["positions"])
    else:
        raise ValueError("The selected Studio move is missing")
    assert {key: frame[key] for key in witness} == witness
    assert trace["engine"]["name"] == design["engine"]
    assert trace["summary"] == design["summary"]
    assert trace["timing"]["unit"] == design["timeUnit"]
    assert frame["control"]["action"] == design["action"]
    assert frame["control"]["banks"][0]["channels"] == design["channels"]
    source = trace["sourceInstructions"][frame["sourceIndex"]]
    assert source["id"] == frame["sourceId"] and source["class"] == "shuttle"
    assert source["participants"] == frame["moves"]
    for move in frame["moves"]:
        assert before[move["ion"]] == move["from"] and frame["positions"][move["ion"]] == move["to"]
    return {"verified": True, "witness": frame["id"], "summary": trace["summary"],
            "engineRevision": trace["engine"]["revision"], "timeUnit": trace["timing"]["unit"]}


if __name__ == "__main__":
    print(json.dumps(verify(), allow_nan=False))
