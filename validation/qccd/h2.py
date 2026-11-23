"""Measured parity after a shared analysis rotation of a 32-ion GHZ state on H2."""
import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import strobes, waveform


N = 32
LIMIT = 0.15
TABLE_SHA = "ff095dc1307064ca3a435fbe47a65d25b10e9887912a5e15b8bb01c298dc27c5"
REV = "d422a716977899d7d6603c9efadb44e89e495125"
META = {
    "title": "Quantinuum H2, 32-ion GHZ parity versus analysis phase",
    "observable": "Mean signed parity of the 32 measured bits",
    "unit": "parity",
    "source": f"https://github.com/Quantinuum/quantinuum-hardware-h2-benchmark/blob/{REV}/ghz/data/GHZ_N32.json",
    "paper": "https://doi.org/10.1103/PhysRevX.13.041052",
    "datasetMember": "ghz/data/GHZ_N32.json, nonadaptive theta1–theta32 shot strings with matched QASM",
    "sourceSha256": "4d6741f76830ef711b501c82372d1d3d630f0654e8107b1032bd4001b0af3db4",
    "dataSha256": TABLE_SHA,
    "license": "Quantinuum’s repository reserves rights. The local table records factual measurements and circuit settings with source hashes.",
    "criterion": "Signed-parity RMSE at most 0.15 across 16 held-out phase settings. Adjacent phase pairs alternate between calibration and holdout.",
    "plotAxis": ["phaseRad", "Analysis phase θ (rad)"],
    "physicalPath": ["Waveform RAM", "DMA and FIFO", "Analysis rotation words", "Ion phase frame",
                     "Raman analysis rotation", "32 trapped ions on H2", "Fluorescence bits", "Parity reduction"],
    "drive": "Two reference DAC slots encode digital rotation words: a virtual Z frame change Rz(−θ), then Ry(−π/2) on each ion. The nominal voltage scale and slot spacing describe this encoding.",
    "scope": "Same-H2 analysis parity at the sampled fringe extrema using physical shots. Offset and in-phase contrast are identifiable; the independent sine quadrature is unobserved.",
    "traceObservable": "Decoded signed Rz and Ry analysis words delivered by the reference DAC",
}


def cases():
    raw = Path(__file__).with_name("h2-shots.csv").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != TABLE_SHA:
        raise ValueError("Unexpected H2 shot table")
    cases_out = []
    for row in csv.DictReader(io.StringIO(raw.decode("ascii"))):
        k = int(row["k"])
        # Rz((4-k/32) pi) and Ry(3.5 pi) use equal unitaries after removing 4 pi.
        rz, ry = float(row["rz_pi"]) - 4, float(row["ry_pi"]) - 4
        pcm = [round(turns_pi * 16384) for turns_pi in (rz, ry)]
        buf = row["ordered_uint32_hex"]
        outcomes = [int(buf[j:j + 8], 16) for j in range(0, len(buf), 8)]
        parity = fmean(1 if shot.bit_count() % 2 == 0 else -1 for shot in outcomes)
        cases_out.append({
            "id": f"h2-ghz32-theta{k:02d}", "split": "calibration" if k % 4 in (1, 2) else "holdout",
            "phaseIndex": k, "phaseRad": -math.pi * rz, "rzPi": rz + 4, "ryPi": ry + 4,
            "qubitCount": N, "observed": parity, "shotCount": len(outcomes),
            "sourceKey": f"({row['job']}, 'theta{k}')", "qasmSha256": row["qasm_sha256"],
            "program": waveform(pcm, 10),
        })
    return cases_out


def delivered_angles(trace):
    """Decode actual signed fixed-point analysis words to (Rz, Ry) in radians."""
    fs = strobes(trace)
    if len(fs) != 2 or any(f["op"] != "convert" for f in fs):
        raise ValueError("Both analysis rotation words must reach the phase controls")
    # The shared controller reports integer microvolts. Recover the nearest
    # signed word for a nominal ±1 V reference and map 32,768 codes to 2π.
    return tuple(math.tau * round(f["state"]["outputUv"] * 32768 / 1_000_000) / 32768
                 for f in fs)


def analysis_phase(trace):
    rz, ry = delivered_angles(trace)
    if not math.isclose(ry, -math.pi / 2, abs_tol=1e-10):
        raise ValueError("Only the published equatorial Ry(−π/2) readout was calibrated")
    return -rz


def fit(calibration):
    groups = {-1: [], 1: []}
    for c, trace in calibration:
        if c["split"] != "calibration" or c["phaseIndex"] % 4 not in (1, 2):
            raise ValueError("Parity calibration requires only the reserved pairs")
        x = math.cos(c["qubitCount"] * analysis_phase(trace))
        if abs(abs(x) - 1) > 1e-10:
            raise ValueError("Expected a calibration observation at a parity extremum")
        groups[1 if x > 0 else -1].append(c["observed"])
    lo, hi = fmean(groups[-1]), fmean(groups[1])
    return {"offset": (lo + hi) / 2, "inPhaseContrast": (hi - lo) / 2, "sineQuadratureAssumed": 0.0}


def predict(case, trace, params):
    theta = analysis_phase(trace)
    return params["offset"] + params["inPhaseContrast"] * math.cos(case["qubitCount"] * theta)


def assess(rows):
    if not rows or any(r["split"] != "holdout" or r["phaseIndex"] % 4 not in (0, 3) for r in rows):
        raise ValueError("Only reserved held-out H2 phase settings may be scored")
    errs = [r["predicted"] - r["observed"] for r in rows]
    rmse = math.sqrt(fmean(e * e for e in errs))
    return {"passed": rmse <= LIMIT, "rmseParity": rmse, "limitParity": LIMIT,
            "maxAbsoluteError": max(map(abs, errs)), "heldOutSettings": len(rows),
            "heldOutShots": sum(r["shotCount"] for r in rows)}
