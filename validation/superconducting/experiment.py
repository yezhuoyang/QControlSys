"""Experimental Gaussian-IF drive sweep on the Labranca et al. transmon."""

import cmath
import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import strobes, waveform


IF_CYCLES_PER_NS = 0.05
SIGMA_NS = 25
SAMPLE_NS = 2
HALF_WIDTH_NS = 2 * SIGMA_NS
SOURCE_SHA256 = "d72b3251e478594dd86320415553b5253c240fa72ad7644f2db445c2d14aa844"
CSV_SHA256 = "f54e605a7bbe535c93cc1b2538e922c64ddeda8394b96f2fef066fcc3dcde9f6"

META = {
    "title": "Labranca et al. (2025), transmon emission after a Gaussian drive",
    "observable": "Mode-matched two-channel emission cross-power",
    "unit": "archived cross-power units",
    "source": "https://doi.org/10.17632/vzs49gddsm.1",
    "paper": "https://doi.org/10.1088/1367-2630/ade736",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "sourceFile": "RabiOscillations.mat, output.PCorr[2, :] (zero-based)",
    "sourceSha256": SOURCE_SHA256,
    "criterion": "All 25 odd-index held-out settings: RMSE at most 15% of their measured range and R² at least 0.75.",
    "physicalPath": [
        "Waveform RAM", "DMA and FIFO", "DAC, 50 MHz IF", "IQ mixer and LO",
        "Attenuated drive line", "Transmon", "90° hybrid and two receiver chains",
        "Heterodyne digitizer", "Mode-matched emission cross-power",
    ],
    "traceObservable": "Complex 50 MHz demodulation of delivered zero-order-held outputUv at the emitted strobe times",
    "drive": "25 ns sigma, 2-sigma truncated Gaussian, 50 MHz IF, 7.893595218 GHz drive",
    "scope": "Cross-power interpolation at held-out amplitude settings of one physical sweep and pulse width.",
}


def cases():
    raw = Path(__file__).with_name("rabi_25ns.csv").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != CSV_SHA256:
        raise ValueError("Superconducting benchmark CSV differs from the verified extraction")
    result = []
    for row in csv.DictReader(io.StringIO(raw.decode("ascii"))):
        index = int(row["source_column"])
        amp = float(row["amp_if"])
        samples = []
        for left in range(-HALF_WIDTH_NS, HALF_WIDTH_NS, SAMPLE_NS):
            t = left + SAMPLE_NS / 2
            envelope = amp * math.exp(-0.5 * (t / SIGMA_NS) ** 2)
            samples.append(round(32767 * envelope * math.cos(math.tau * IF_CYCLES_PER_NS * t)))
        samples.append(0)
        result.append({
            "id": f"labranca-fig6c-column-{index:02d}",
            "split": "calibration" if index % 2 == 0 else "holdout",
            "sourceColumn": index,
            "amplitudeIf": amp,
            "attenuationDb": float(row["attenuation_db"]),
            "driveHz": 7893595218,
            "sigmaNs": SIGMA_NS,
            "observed": float(row["cross_power"]),
            "program": waveform(samples, SAMPLE_NS),
        })
    return result


def delivered_area(trace):
    """Magnitude of the resonant voltage-time integral, in V ns."""
    frames = strobes(trace)
    if len(frames) < 2:
        raise ValueError("The controller emitted fewer than two DAC strobes")
    times = [f.get("atPs", f["atNs"] * 1000) / 1000 for f in frames]
    omega = math.tau * IF_CYCLES_PER_NS
    integral = 0j
    for i, (start, end) in enumerate(zip(times, times[1:])):
        dt = end - start
        if dt <= 0:
            raise ValueError("DAC strobe timestamps must increase")
        # Integral of exp(-iωt) over this exact hold interval.
        mid = (start + end) / 2 - times[0]
        weight = 2 * math.sin(omega * dt / 2) / omega * cmath.exp(-1j * omega * mid)
        integral += frames[i]["state"]["outputUv"] * 1e-6 * weight
    return 2 * abs(integral)


def fit(calibration):
    if not calibration or any(case["split"] != "calibration" for case, _ in calibration):
        raise ValueError("Only even-index calibration observations may be fitted")
    areas = [delivered_area(trace) for _, trace in calibration]
    observed = [case["observed"] for case, _ in calibration]
    ymean = fmean(observed)
    xmax = max(areas)
    if xmax <= 0:
        raise ValueError("Calibration failed to deliver a nonzero drive")
    best = None
    for j in range(25, 4001):
        k = math.tau * (j / 500) / xmax
        excited = [(1 - math.cos(k * area)) / 2 for area in areas]
        xmean = fmean(excited)
        variance = sum((x - xmean) ** 2 for x in excited)
        if variance == 0:
            continue
        covariance = sum((x - xmean) * (y - ymean) for x, y in zip(excited, observed))
        contrast = max(0.0, covariance / variance)
        offset = ymean - contrast * xmean
        sse = sum((offset + contrast * x - y) ** 2 for x, y in zip(excited, observed))
        if best is None or sse < best[0]:
            best = (sse, k, contrast, offset)
    if best is None:
        raise ValueError("Calibration needs distinct pulse areas")
    _, rotation, contrast, offset = best
    return {"rotationRadPerVNs": rotation, "crossPowerContrast": contrast, "crossPowerOffset": offset}


def predict(case, trace, params):
    theta = params["rotationRadPerVNs"] * delivered_area(trace)
    return params["crossPowerOffset"] + params["crossPowerContrast"] * (1 - math.cos(theta)) / 2


def assess(rows):
    indices = {r["sourceColumn"] for r in rows}
    if len(rows) != 25 or indices != set(range(1, 50, 2)) or any(r["split"] != "holdout" for r in rows):
        raise ValueError("Assessment requires the 25 distinct predeclared holdout settings")
    observed = [r["observed"] for r in rows]
    residuals = [r["predicted"] - r["observed"] for r in rows]
    sse = sum(r * r for r in residuals)
    rmse = math.sqrt(sse / len(rows))
    span = max(observed) - min(observed)
    mean = fmean(observed)
    sst = sum((y - mean) ** 2 for y in observed)
    nrmse = rmse / span if span > 0 else None
    r2 = 1 - sse / sst if sst > 0 else None
    return {
        "passed": nrmse is not None and r2 is not None and nrmse <= 0.15 and r2 >= 0.75,
        "rmse": rmse, "holdoutRange": span, "nrmse": nrmse, "r2": r2,
        "maxAbsoluteError": max(map(abs, residuals)), "heldOutSettings": len(rows),
        "nrmseLimit": 0.15, "minimumR2": 0.75,
    }
