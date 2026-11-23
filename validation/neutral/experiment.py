"""Durham AOD frequency sweep with fluorescence-fitted positions of a trapped Cs atom."""

import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import strobes, waveform_ps


ARCHIVE_URL = "https://researchdata.durham.ac.uk/downloads/r1k3569440m"
ARCHIVE_SHA256 = "59f2c7ef470f2e936c921a66e71c0b6255a38c09f657079bb5566c83d24f6df4"
MEMBER = (
    "Preparation of one 87Rb and one 133Cs atom in a single optical tweezer/"
    "[fig4] tweezer control/fig4a_data.csv"
)
MEMBER_SHA256 = "d1f55acc53db86e8791a3b30195e05af8e3a2b52dbf3469cc50cc85452b34b17"
LIMIT_UM = 0.25
SAMPLE_PS = 1600
SAMPLE_COUNT = 32
REFERENCE_MHZ = 170.0
# Eq. (2) of Brooks et al., converted from m/Hz to µm/MHz and camera-axis sign.
OPTICAL_SLOPE_UM_PER_MHZ = -(938e-9 * 35.24e-3 / (4200 * 25)) * 1e12

META = {
    "title": "Brooks et al. (2021), Cs position versus AOD drive frequency",
    "observable": "Camera-fitted Cs atom position along the deflection axis",
    "unit": "µm",
    "source": "https://doi.org/10.15128/r1k3569440m",
    "paper": "https://doi.org/10.1088/1367-2630/ac0000",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "datasetMember": MEMBER,
    "archiveSha256": ARCHIVE_SHA256,
    "memberSha256": MEMBER_SHA256,
    "criterion": "Held-out position RMSE at most 0.25 µm, with the even sorted indices used for calibration.",
    "physicalPath": [
        "Waveform RAM", "DMA and FIFO", "DAC voltage samples", "RF tone",
        "938 nm tweezer AOD", "Objective", "Cs atom", "Camera centroid",
    ],
    "traceObservable": "Uniformly spaced DAC outputUv values and exact strobe timestamps atPs",
    "drive": "Reconstructed single-tone segment at the reported 625 MS/s AWG rate",
    "scope": "Static single-axis equilibrium positions at held-out RF settings from the same sweep.",
}


def tone_program(frequency_mhz):
    """A representative steady RF segment at the source AWG's sample rate."""
    if not 0 < frequency_mhz < 500_000 / SAMPLE_PS:
        raise ValueError("Frequency must be positive and below the AWG Nyquist limit")
    phase_step = math.tau * frequency_mhz * SAMPLE_PS / 1_000_000
    pcm = [round(16000 * math.cos(n * phase_step)) for n in range(SAMPLE_COUNT)]
    return waveform_ps(pcm, SAMPLE_PS)


def cases():
    """Load the source file, retaining its deposited row numbers and camera-axis sign."""
    data = Path(__file__).with_name("fig4a_data.csv").read_bytes()
    # Check the deposit's original CRLF encoding even on a newline-normalizing checkout.
    original = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    if hashlib.sha256(original).hexdigest() != MEMBER_SHA256:
        raise ValueError("Neutral-atom CSV differs from the published Fig. 4(a) dataset")
    rows = sorted(csv.DictReader(io.StringIO(data.decode("ascii"))),
                  key=lambda row: float(row["AOM freq / MHz"]))
    result = []
    for index, row in enumerate(rows):
        frequency_mhz = float(row["AOM freq / MHz"])
        result.append({
            "id": f"durham-fig4a-row-{row['']}",
            "split": "calibration" if index % 2 == 0 else "holdout",
            "observed": float(row["atom position / um"]),
            "reportedPositionErrorUm": float(row["error"]),
            "sourceRow": int(row[""]),
            "appliedFrequencyMHz": frequency_mhz,
            "program": tone_program(frequency_mhz),
        })
    return result


def delivered_frequency_mhz(trace):
    """Least-squares estimate of a single real sinusoid's frequency below Nyquist."""
    frames = strobes(trace)
    if len(frames) < 3 or any(frame["op"] != "convert" for frame in frames):
        raise ValueError("Tone estimation needs at least three delivered DAC conversions and no underruns")
    times = [frame["atPs"] for frame in frames]
    period = times[1] - times[0]
    if period <= 0 or any(b - a != period for a, b in zip(times, times[1:])):
        raise ValueError("Tone estimation needs a uniform positive DAC sample period")
    samples = [frame["state"]["outputUv"] for frame in frames]
    center = samples[1:-1]
    power = sum(value * value for value in center)
    if not power:
        raise ValueError("A zero RF waveform does not specify a tweezer position")
    # v[n-1] + v[n+1] = 2 cos(2π f Δt) v[n] for an unoffset, fixed-frequency tone.
    adjacent = sum((a + c) * b for a, b, c in zip(samples, center, samples[2:]))
    cosine = max(-1.0, min(1.0, adjacent / (2 * power)))
    return math.acos(cosine) * 1_000_000 / (math.tau * period)


def fit(calibration):
    if len(calibration) < 2 or any(case["split"] != "calibration" for case, _ in calibration):
        raise ValueError("Fit needs at least two calibration cases and no held-out measurements")
    frequencies = [delivered_frequency_mhz(trace) for _, trace in calibration]
    observed = [case["observed"] for case, _ in calibration]
    mean_f, mean_x = fmean(frequencies), fmean(observed)
    variance = sum((f - mean_f) ** 2 for f in frequencies)
    if not variance:
        raise ValueError("Cannot calibrate displacement against a single RF frequency")
    slope = sum((f - mean_f) * (x - mean_x) for f, x in zip(frequencies, observed)) / variance
    return {
        "referenceMHz": REFERENCE_MHZ,
        "positionAtReferenceUm": mean_x + slope * (REFERENCE_MHZ - mean_f),
        "slopeUmPerMHz": slope,
        "nominalOpticsSlopeUmPerMHz": OPTICAL_SLOPE_UM_PER_MHZ,
    }


def predict(case, trace, params):
    """Use only delivered samples, their timestamps, and the independent calibration."""
    frequency = delivered_frequency_mhz(trace)
    return params["positionAtReferenceUm"] + params["slopeUmPerMHz"] * (frequency - params["referenceMHz"])


def assess(rows):
    if not rows or any(row["split"] != "holdout" for row in rows):
        raise ValueError("Assessment requires held-out observations")
    residuals = [row["predicted"] - row["observed"] for row in rows]
    rmse = math.sqrt(fmean(r * r for r in residuals))
    return {
        "passed": rmse <= LIMIT_UM,
        "rmseUm": rmse,
        "maxAbsoluteErrorUm": max(map(abs, residuals)),
        "meanResidualUm": fmean(residuals),
        "limitUm": LIMIT_UM,
        "heldOutSettings": len(rows),
    }
