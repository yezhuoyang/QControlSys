"""Shared instrument and accessors for the three physical benchmarks."""

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLE = (
    ROOT
    / ".lake"
    / "build"
    / "bin"
    / ("qcontrol.exe" if os.name == "nt" else "qcontrol")
)


def waveform_ps(pcm, sample_ps):
    words = list(pcm)
    if not 1 <= len(words) <= 128 or any(
        type(w) is not int or not -32768 <= w <= 32767 for w in words
    ):
        raise ValueError("A waveform needs 1–128 signed 16-bit sample words.")
    if type(sample_ps) is not int or not 1 <= sample_ps <= 10_000_000:
        raise ValueError(
            "The controller sample period must be 1–10,000,000 integer ps."
        )
    ns, ps = divmod(sample_ps, 1000)
    return {
        "kind": "waveform-controller",
        "version": 1,
        "clockNs": ns,
        **({"clockSubNsPs": ps} if ps else {}),
        "busEvery": 1,
        "busBits": 32,
        "grantPattern": [True],
        "fifoWords": 8,
        "sampleEvery": 1,
        "dacBits": 16,
        "fullScaleUv": 1_000_000,
        "gainPermille": 1000,
        "firQ15": [32768],
        "inputWord": 0,
        "memory": words,
        "code": [
            {"dma": {"address": 0, "count": len(words)}},
            {"play": {"count": len(words)}},
            "halt",
        ],
        "maxCycles": len(words) + 6,
    }


def waveform(pcm, sample_ns):
    if type(sample_ns) is not int:
        raise ValueError("Use waveform_ps for fractional nanoseconds.")
    return waveform_ps(pcm, sample_ns * 1000)


def strobes(trace):
    return [
        frame for frame in trace["frames"] if frame["op"] in ("convert", "underrun")
    ]


def pair_waveform(outbound, inbound, dwell_ns, sample_ns=400, clock_ns=20):
    """Two trigger-aligned banks. The gap between their adjacent strobes is sample_ns + dwell_ns."""
    outward, inward = list(outbound), list(inbound)
    if (
        not outward
        or not inward
        or not 0 < clock_ns <= sample_ns
        or sample_ns % clock_ns
    ):
        raise ValueError(
            "Both waveform banks and an integer DAC clock divider are required."
        )
    if type(dwell_ns) is not int or dwell_ns < 0 or dwell_ns % clock_ns:
        raise ValueError(
            "The programmed dwell must be an integer number of nonnegative core ticks."
        )
    program = waveform(outward + inward, clock_ns)
    divider, dwell = sample_ns // clock_ns, dwell_ns // clock_ns
    code = [program["code"][0], {"playTriggered": {"count": len(outward)}}]
    if dwell:
        code.append({"wait": {"ticks": dwell - 1}})
    code.extend([{"playTriggered": {"count": len(inward)}}, "halt"])
    return {
        **program,
        "version": 2,
        "code": code,
        "busEvery": max(1, divider // 2),
        "sampleEvery": divider,
        "maxCycles": (len(outward) + len(inward)) * divider + dwell + 5,
    }


def execute(document, *flags):
    result = subprocess.run(
        [str(EXECUTABLE), *flags],
        input=json.dumps(document),
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=90,
    )
    if result.returncode:
        raise ValueError(
            result.stderr.strip() or "The controller rejected the program."
        )
    return json.loads(result.stdout)
