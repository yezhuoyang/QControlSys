"""RF Paul trap transport and coherent cancellation, Walther et al. Fig. 3(a)."""

import cmath
import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import pair_waveform, strobes


FREQUENCY_MHZ = 1.41
TRAVEL_UM = 280
STEPS = 28
CALIBRATION = {0, 3, 6, 9}
CSV_SHA256 = "d0839fa255daebfda442ad14edccb3ba18e742747625bf6ee5948252ea64734e"
META = {
    "title": "Walther et al. (2012), coherent return transport in an RF Paul trap",
    "observable": "Mean coherent motional excitation from sideband Rabi thermometry",
    "unit": "phonons",
    "source": "https://arxiv.org/abs/1206.0364v1",
    "paper": "https://doi.org/10.1103/PhysRevLett.109.080501",
    "license": "Numeric readings from the authors’ figure. arXiv non-exclusive distribution license for the source.",
    "sourceMember": "pE_curves.eps, first plot group 2, blue Circle marker centers",
    "sourceSha256": "74c3f643b486187f2591abee0ca5743fd1a78bf005d7f94233e0f8525e509dc1",
    "criterion": "Seven held-out sideband-thermometry markers must have a mean-phonon RMSE at most 10.",
    "plotAxis": ["plottedDwellNs", "Dwell between shuttles (ns, plotted)"],
    "physicalPath": ["Waveform RAM", "DMA and FIFO", "Timed DAC updates", "Segment DC electrodes",
                     "Moving axial well of RF Paul trap", "Calcium ion", "Sideband Rabi thermometry"],
    "traceObservable": "Complex oscillator response to changes in delivered DAC voltage at actual strobe times",
    "drive": "Two 280 µm, 11.2 µs sinusoidal-squared well-centre ramps with 400 ns updates",
    "scope": "Sweep-scale coherent motional energy at distinct dwell times on one trapped calcium ion.",
}


def cases():
    raw = Path(__file__).with_name("pair-data.csv").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != CSV_SHA256:
        raise ValueError("Paul-trap benchmark differs from the extracted source markers")
    outward = [round(32767 * math.sin(math.pi * j / (2 * STEPS)) ** 2) for j in range(1, STEPS + 1)]
    inward = [32767 - word for word in outward]
    result = []
    for row in csv.DictReader(io.StringIO(raw.decode("ascii"))):
        index = int(row["marker_index"])
        plotted = float(row["plotted_dwell_ns"])
        # The EPS grid is 0.77 ns wide. Resolve to whole ns first; half-tick ties round up.
        dwell = 20 * ((round(plotted) + 10) // 20)
        result.append({
            "id": f"walther-fig3a-marker-{index:02d}",
            "split": "calibration" if index in CALIBRATION else "holdout",
            "markerIndex": index,
            "plottedDwellNs": plotted,
            "executedDwellNs": dwell,
            "driveDurationNs": 11200,
            "axialFrequencyMHz": FREQUENCY_MHZ,
            "observed": float(row["mean_phonons"]),
            "program": pair_waveform(outward, inward, dwell),
        })
    return result


def responses(trace):
    """Stepwise trap-centre shifts excite a fixed-frequency harmonic mode."""
    frames = strobes(trace)
    if len(frames) != 2 * STEPS:
        raise ValueError("Expected 28 outward and 28 return DAC strobes")
    parts = [0j, 0j]
    reference_ps = frames[0].get("atPs", frames[0]["atNs"] * 1000)
    prior = trace["initial"]["outputUv"]
    for i, frame in enumerate(frames):
        uv = frame["state"]["outputUv"]
        time_ps = frame.get("atPs", frame["atNs"] * 1000) - reference_ps
        rotation = cmath.exp(1j * math.tau * FREQUENCY_MHZ * time_ps / 1e6)
        parts[i // STEPS] += (uv - prior) * (TRAVEL_UM / 1e6) * rotation
        prior = uv
    return parts


def fit(calibration):
    if len(calibration) != 4 or {c["markerIndex"] for c, _ in calibration} != CALIBRATION:
        raise ValueError("Fit needs the four predeclared calibration markers")
    records = [(responses(trace), c["observed"]) for c, trace in calibration]
    best = None
    for j in range(3600):
        phase = math.radians(j / 10)
        turn = cmath.exp(1j * phase)
        x = [abs(out + turn * back) ** 2 for (out, back), _ in records]
        norm = sum(v * v for v in x)
        if norm == 0:
            continue
        scale = max(0.0, sum(v * y for v, (_, y) in zip(x, records)) / norm)
        sse = sum((scale * v - y) ** 2 for v, (_, y) in zip(x, records))
        if best is None or sse < best[0]:
            best = (sse, phase, scale)
    if best is None:
        raise ValueError("The controller delivered no resolvable transport")
    return {"relativePhaseRad": best[1], "phononsPerSquareUm": best[2]}


def predict(case, trace, params):
    outward, inward = responses(trace)
    return params["phononsPerSquareUm"] * abs(outward + cmath.exp(1j * params["relativePhaseRad"]) * inward) ** 2


def assess(rows):
    if (len(rows) != 7 or {r["markerIndex"] for r in rows} != set(range(11)) - CALIBRATION
            or any(r["split"] != "holdout" for r in rows)):
        raise ValueError("Assessment needs the seven distinct predeclared holdout markers")
    residuals = [r["predicted"] - r["observed"] for r in rows]
    rmse = math.sqrt(fmean(r * r for r in residuals))
    return {"passed": rmse <= 10, "rmsePhonons": rmse, "limitPhonons": 10,
            "maxAbsoluteErrorPhonons": max(map(abs, residuals)), "heldOutSettings": len(rows)}
