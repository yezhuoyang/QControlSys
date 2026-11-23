"""Adiabatic return and matched sideband spectroscopy, Jain et al. Extended Data Fig. 2."""
from bisect import bisect_right
from collections import defaultdict
import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import strobes, waveform


CSV_SHA256 = "99766aaa392e2589bb14554fada4a2c1da4617e17d535130a3bdf199393f0253"
EXCURSION_UM = 30
ONE_WAY_NS = 300_000
KNOTS = 5
DETUNING_RANGE_KHZ = 12.5

META = {
    "title": "Jain et al. (2024), sideband readout after slow ion transport",
    "observable": "Beryllium ion bright-state population after a sideband probe",
    "unit": "probability",
    "source": "https://doi.org/10.1038/s41586-024-07111-x",
    "dataSource": "https://arxiv.org/src/2308.07672v2",
    "datasetMember": "FigS2.pdf, measured markers in all 12 axes",
    "archiveSha256": "0ca9a27d15a054a5d5d7cbb2d45a76ec3ce7d5af8543ccf3d0cc1afec82016b5",
    "memberSha256": "0b864cfd8c37970fe78af091d8e60fb1283b3b8f2d243f969afb5a012a836942",
    "dataSha256": CSV_SHA256,
    "license": "Published article CC BY 4.0. Factual marker coordinates extracted from the authors’ versioned figure.",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "criterion": "Absolute bright-population RMSE at most 0.10 across all visible transported settings. Calibration uses stationary scans only.",
    "physicalPath": ["Waveform RAM", "DMA and FIFO", "DAC command", "Penning trap electrodes",
                     "9Be+ ion", "Raman sideband probe", "Fluorescence readout"],
    "drive": "Reconstructed slow well trajectory and a separate detuning setting in the final DAC word. Electrode voltages and Raman carrier waveform are unavailable.",
    "traceObservable": "Delivered excursion, elapsed time per leg, return to origin and final probe detuning",
    "scope": "Endpoint spectroscopy under the matched slow-transport null, 30 µm in about 300 µs per leg on this Penning trap. Coverage includes two travel axes and three motional modes.",
    "plotAxis": ["detuningKHz", "Probe detuning (kHz)"],
    "seriesKey": "spectrum",
    "seriesTitle": "Travel axis · motional mode · probe sideband",
    "designScope": "The Penning-trap experiment uses a different ion and apparatus from the H2 Studio design.",
}


def program_for(repetitions, transported, detuning):
    # Smooth half-cosine control knots reconstruct a nominal adiabatic leg.
    # Their exact time profile and digital routing were not published.
    outward = [round((1 - math.cos(math.pi * j / KNOTS)) * 32767 / 2) for j in range(KNOTS + 1)]
    round_trip = outward[1:] + outward[-2::-1]
    positions = [0] + round_trip * repetitions
    if not transported:
        positions = [0] * len(positions)
    # Time multiplex two effective control coordinates in one replay. The
    # final word selects the Raman detuning and does not move an electrode.
    tuning_word = round(detuning / DETUNING_RANGE_KHZ * 32768)
    program = waveform(positions + [tuning_word], 10_000)
    program.update(version=2, sampleEvery=6, busEvery=3, maxCycles=6 * (len(positions) + 2) + 5)
    return program


def cases():
    raw = Path(__file__).with_name("slow_fig_s2.csv").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != CSV_SHA256:
        raise ValueError("Unexpected Jain sideband observations")
    result = []
    for i, row in enumerate(csv.DictReader(io.StringIO(raw.decode("ascii")))):
        axis, mode, band = row["axis"], row["mode"], row["sideband"]
        moved = row["motion"] == "transported"
        detuning = float(row["detuning_khz"])
        repeats = 10 if mode == "axial" else 4
        result.append({
            "id": f"jain-ed2-{i:03d}", "split": "holdout" if moved else "calibration",
            "observed": float(row["bright_population"]), "detuningKHz": detuning,
            "spectrum": f"{axis} · {mode} · {band}", "travelAxis": axis, "motionalMode": mode,
            "sideband": band, "condition": row["motion"], "roundTrips": repeats,
            "oneWayUs": 300, "nominalExcursionUm": EXCURSION_UM if moved else 0,
            "program": program_for(repeats, moved, detuning),
        })
    return result


def delivered_setting(case, trace):
    """Check the delivered motion stays inside the empirical comparison domain."""
    frames = strobes(trace)
    nlegs = case["roundTrips"] * 2
    if len(frames) != nlegs * KNOTS + 2 or any(f["op"] != "convert" for f in frames):
        raise ValueError("The complete reference shuttle and probe setting must reach the outputs")
    motion, probe = frames[:-1], frames[-1]
    times = [f["atPs"] / 1000 if f.get("atPs") is not None else f["atNs"] for f in motion]
    positions = [EXCURSION_UM * f["state"]["outputUv"] / 1_000_000 for f in motion]
    if any(t1 <= t0 for t0, t1 in zip(times, times[1:])):
        raise ValueError("Transport timing must be strictly ordered")
    # These windows are command-domain guards for extrapolation, not claims
    # about ion tracking precision or instrument accuracy.
    if abs(positions[0]) > 0.3:
        raise ValueError("The reconstructed shuttle must begin at the origin")
    for leg in range(nlegs):
        i, j = leg * KNOTS, (leg + 1) * KNOTS
        if abs(times[j] - times[i] - ONE_WAY_NS) > 0.01 * ONE_WAY_NS:
            raise ValueError("Sideband calibration covers 300 µs slow legs only")
        segment = positions[i:j + 1]
        if any(abs((times[k + 1] - times[k]) * KNOTS / ONE_WAY_NS - 1) > 0.01
               for k in range(i, j)):
            raise ValueError("The slow reference needs evenly timed control knots")
        if case["condition"] == "stationary":
            if max(map(abs, segment)) > 0.3:
                raise ValueError("The stationary control must hold the ion at its initial setpoint")
        else:
            outward = leg % 2 == 0
            target = EXCURSION_UM if outward else 0
            if abs(segment[-1] - target) > 0.3:
                raise ValueError("Sideband calibration covers 30 µm excursions and closed returns")
            for k, position in enumerate(segment):
                fraction = (1 - math.cos(math.pi * k / KNOTS)) / 2
                expected = EXCURSION_UM * (fraction if outward else 1 - fraction)
                if abs(position - expected) > 0.3:
                    raise ValueError("The delivered well command is outside the reconstructed slow profile")
    return DETUNING_RANGE_KHZ * probe["state"]["outputUv"] / 1_000_000


def fit(calibration):
    curves = defaultdict(list)
    for case, trace in calibration:
        if case["split"] != "calibration" or case["condition"] != "stationary":
            raise ValueError("Only matched stationary controls may calibrate the spectrum")
        curves[case["spectrum"]].append([delivered_setting(case, trace), case["observed"]])
    if len(curves) != 12:
        raise ValueError("The two directions, three modes and two sidebands need matched controls")
    return {"stationarySpectra": {key: sorted(curve) for key, curve in curves.items()}}


def predict(case, trace, params):
    # The slow-return hypothesis preserves the stationary spectrum. The final
    # delivered probe detuning determines the readout within that spectrum.
    x = delivered_setting(case, trace)
    curve = params["stationarySpectra"][case["spectrum"]]
    j = bisect_right([point[0] for point in curve], x)
    if j == 0 or j == len(curve):
        return curve[0 if j == 0 else -1][1]
    (x0, y0), (x1, y1) = curve[j - 1:j + 1]
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0)


def assess(rows):
    if not rows or any(r["split"] != "holdout" or r["condition"] != "transported" for r in rows):
        raise ValueError("Only transported scans belong in the score")
    residuals = [r["predicted"] - r["observed"] for r in rows]
    rmse = math.sqrt(fmean(v * v for v in residuals))
    return {"passed": rmse <= 0.10, "rmse": rmse, "limit": 0.10,
            "maxAbsoluteError": max(map(abs, residuals)), "heldOutSettings": len(residuals)}
