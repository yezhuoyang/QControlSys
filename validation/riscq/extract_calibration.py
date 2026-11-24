"""Extract the control-relevant numbers of RISC-Q's example device calibration.

Source: RISC-Q `examples/cal-config-x6y3.yaml` (MIT, commit 243d814), an eight-qubit ring.
Output: x6y3-calibration.json with durations in seconds, frequencies in Hz, amplitudes as a
fraction of DAC full scale and phases in radians, exactly as the source states them.

    python validation/riscq/extract_calibration.py <path to RISC-Q checkout>
"""
import json
import pathlib
import re
import sys

import yaml

source = pathlib.Path(sys.argv[1]) / "examples" / "cal-config-x6y3.yaml"
data = yaml.safe_load(source.read_text())


def drive(entry):
    pulses = entry["pulse"]
    shaped = [p for p in pulses if p["env"] != "virtualz"]
    virtual = [p for p in pulses if p["env"] == "virtualz"]
    assert len(shaped) == 1
    return {
        "time": shaped[0]["time"],
        "amp": shaped[0]["kwargs"]["amp"],
        "phase": shaped[0]["kwargs"]["phase"],
        "env": shaped[0]["env"],
        "virtualZ": [p["kwargs"]["phase"] for p in virtual],
    }


def qubit_of(channel):
    return int(re.fullmatch(r"Q(\d+)\.qdrv", channel).group(1))


qubits = []
for index, q in sorted(data["single_qubit"].items()):
    ge = q["GE"]
    ro = data["readout"][index]
    qubits.append({
        "qubit": index,
        "freq": ge["freq"],
        "T1": ge["T1"],
        "X90": drive(ge["X90"]),
        "X": drive(ge["X"]),
        "readout": {
            "freq": ro["freq"], "amp": ro["amp"], "time": ro["time"], "env": ro["env"],
            "demod": {"delay": ro["demod"]["delay"], "time": ro["demod"]["time"], "phase": ro["demod"]["phase"]},
        },
    })

pairs = []
for key, pair in data["two_qubit"].items():
    a, b = (int(x) for x in re.fullmatch(r"\((\d+), (\d+)\)", key).groups())
    cz = pair["CZ"]
    # Two pairs wrap their CZ in a pulse on the second excited level, given by reference.
    steps = [p for p in cz["pulse"] if not isinstance(p, str)]
    pairs.append({
        "pair": [a, b],
        "freq": cz["freq"],
        "pulses": [{"qubit": qubit_of(p["channel"]), "time": p["time"], "amp": p["kwargs"]["amp"],
                    "phase": p["kwargs"]["phase"], "env": p["env"]}
                   for p in steps if p["env"] != "virtualz"],
        "virtualZ": [{"qubit": qubit_of(p["channel"]), "phase": p["kwargs"]["phase"]}
                     for p in steps if p["env"] == "virtualz"],
        "sandwich": [p for p in cz["pulse"] if isinstance(p, str)],
    })

out = {
    "source": "RISC-Q examples/cal-config-x6y3.yaml, commit 243d814dc2bdb323dbca891f6c6a263d18ab853f",
    "sampleRate": data["hardware"]["sample_rate"],
    "passiveResetDelay": data["reset"]["passive"]["delay"],
    "qubits": qubits,
    "pairs": pairs,
}
target = pathlib.Path(__file__).with_name("x6y3-calibration.json")
target.write_text(json.dumps(out, indent=1) + "\n")
print(len(qubits), "qubits,", len(pairs), "pairs ->", target.name)
