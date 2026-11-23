"""Single-ion shuttle position, Clark et al., Phys. Rev. A 107, 043119, Fig. 2c."""

import csv
import hashlib
import io
import math
from pathlib import Path
from statistics import fmean

from bench_common import strobes, waveform


TRAVEL_UM = 120
SAMPLES = 30
SAMPLE_NS = 40
PROBE_NS = 200
ORIGIN_CALIBRATION_END_NS = 100
LIMIT_UM = 12
CSV_SHA256 = "ceeac8c994a8e0e5814bb71b27092ed7cb222e578d99bb1772d049a457277c6e"

META = {
    "title": "Clark et al. (2023), fast transport of one calcium ion",
    "observable": "Axial ion position inferred from optical deshelving",
    "unit": "µm",
    "source": "https://doi.org/10.1103/PhysRevA.107.043119",
    "dataSource": "https://arxiv.org/src/2301.05279v2",
    "datasetMember": "20230324_Transport_Fig2_3panel.pdf, Fig. 2c black data markers",
    "license": "arXiv non-exclusive distribution license for the source paper. Local CSV contains factual readings only.",
    "licenseUrl": "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "archiveSha256": "817ccada93fe9638f4836502c571ebed833e614ffdbcb1b844a511f051260f27",
    "memberSha256": "59f87b37058b61f6c310c90f7bc7724a0afc52cd5de5d23d17430396e7bb30da",
    "dataSha256": CSV_SHA256,
    "criterion": "Held-out position RMSE at most 12 µm (10% of commanded travel). Only delays through 100 ns calibrate the position offset.",
    "physicalPath": ["Waveform RAM", "DMA and FIFO", "DAC samples", "Trap control electrodes",
                     "Axial potential minimum", "Calcium ion", "854 nm probe", "397 nm fluorescence detector"],
    "traceObservable": "Zero-order-held DAC outputUv and conversion times, integrated over the optical exposure",
    "drive": "Reconstructed linear well command, 30 updates × 40 ns, 120 µm",
    "scope": "Effective single-axis command-following model on the GTRI surface trap. Individual electrode voltages, filtered fields and fluorescence shots are unavailable.",
}


def cases():
    raw = Path(__file__).with_name("fig2.csv").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != CSV_SHA256:
        raise ValueError("Fig. 2 observations differ from the pinned vector extraction")
    # Positive full-scale DAC coordinates encode a normalized well position.
    # Laboratory voltages on individual electrodes were not deposited.
    pcm = [round(i * 32767 / SAMPLES) for i in range(1, SAMPLES + 1)]
    program = waveform(pcm, SAMPLE_NS)
    result = []
    for row in csv.DictReader(io.StringIO(raw.decode("ascii"))):
        delay = float(row["delay_ns"])
        result.append({
            "id": f"clark-fig2c-{int(row['marker']):03d}",
            "split": "calibration" if delay <= ORIGIN_CALIBRATION_END_NS else "holdout",
            "observed": float(row["position_um"]),
            "probeDelayNs": delay, "probeDurationNs": PROBE_NS,
            "sourceMarker": int(row["marker"]), "program": program,
        })
    return result


def probe_displacement(case, trace):
    """Exposure average of the quasi-static ion displacement driven by delivered DAC levels."""
    delivered = strobes(trace)
    if not delivered:
        raise ValueError("A transport waveform needs at least one DAC strobe")
    start = float(case["probeDelayNs"])
    duration = float(case["probeDurationNs"])
    if duration <= 0:
        raise ValueError("The optical probe must have positive duration")
    end = start + duration
    # Register the first output to the end of its first 40 ns interval.
    def time_ns(frame):
        return frame["atPs"] / 1000 if frame.get("atPs") is not None else frame["atNs"]
    t_zero = time_ns(delivered[0]) - SAMPLE_NS
    hold_start, displacement, area = 0.0, 0.0, 0.0
    for frame in delivered:
        t = time_ns(frame) - t_zero
        if t < hold_start:
            raise ValueError("DAC strobe times must increase")
        area += max(0, min(t, end) - max(hold_start, start)) * displacement
        # The independently specified 120 µm span maps to +1,000,000 µV
        # on the reconstructed control coordinate. Actual DAC gain is observable.
        displacement = TRAVEL_UM * frame["state"]["outputUv"] / 1_000_000
        hold_start = t
    area += max(0, end - max(hold_start, start)) * displacement
    return area / duration


def fit(calibration):
    if not calibration or any(case["split"] != "calibration"
                              or case["probeDelayNs"] > ORIGIN_CALIBRATION_END_NS
                              for case, _ in calibration):
        raise ValueError("The position origin uses only the leading calibration block")
    offset = fmean(c["observed"] - probe_displacement(c, trace) for c, trace in calibration)
    return {"originUm": offset}


def predict(case, trace, params):
    return params["originUm"] + probe_displacement(case, trace)


def assess(rows):
    if not rows or any(row["split"] != "holdout" for row in rows):
        raise ValueError("Assessment needs held-out observations")
    residuals = [r["predicted"] - r["observed"] for r in rows]
    rmse = math.sqrt(fmean(r * r for r in residuals))
    return {"passed": rmse <= LIMIT_UM, "rmseUm": rmse, "limitUm": LIMIT_UM,
            "maxAbsoluteErrorUm": max(map(abs, residuals)), "meanResidualUm": fmean(residuals),
            "heldOutSettings": len(rows)}
