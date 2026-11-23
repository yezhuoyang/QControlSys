"""Metric reference installation envelopes and signal paths used by the case debugger."""

import json
from pathlib import Path

REFERENCE = "Illustrative enclosure and placement in millimetres."


def assembly(identifier, label, center, size, shape, basis=REFERENCE):
    return {
        "id": identifier,
        "label": label,
        "centerMm": center,
        "sizeMm": size,
        "kind": shape,
        "basis": basis,
    }


def apparatus(platform, meta, identifier=None):
    rack = assembly(
        "controller", "FPGA sequencer", [-380, 160, 0], [430, 44, 280], "rack"
    )
    dac = assembly("dac", "Waveform DAC", [-380, 92, 0], [430, 44, 280], "rack")
    if platform == "superconducting":
        chamber = assembly(
            "chamber", "Dilution refrigerator", [280, 380, 0], [440, 720, 440], "fridge"
        )
        drive = assembly(
            "drive", "IF and microwave mixer", [-35, 98, 125], [105, 40, 90], "mixer"
        )
        readout = assembly(
            "readout", "Heterodyne receiver", [-250, 52, -260], [320, 60, 150], "rack"
        )
        endpoint = assembly(
            "endpoint",
            "Transmon chip",
            [280, 124, 0],
            [5, 0.5, 5],
            "chip",
            "Reference substrate envelope. The optional Metal layout is an independent design.",
        )
        zoom, link, back = (
            8,
            "Microwave drive line",
            "Microwave emission and amplification",
        )
    elif platform == "neutral":
        chamber = assembly(
            "chamber", "Atom vacuum cell", [280, 150, 0], [130, 145, 130], "vacuum"
        )
        drive = assembly(
            "drive",
            "938 nm tweezer AOD",
            [-40, 102, 130],
            [74, 54, 65],
            "aod",
            "Brooks et al. used an IntraAction ATD-1803DA2.850. The enclosure is illustrative.",
        )
        readout = assembly(
            "readout",
            "Fluorescence camera",
            [540, 142, 0],
            [90, 76, 105],
            "camera",
            "The experiment used an Andor iXon Ultra 897 with 28.4× imaging. The envelope is illustrative.",
        )
        endpoint = assembly(
            "endpoint",
            "Cs imaging plane",
            [280, 150, 0],
            [0.10, 0.002, 0.10],
            "plane",
            "The displayed position markers use the signed source camera coordinate in µm.",
        )
        zoom, link, back = (
            0.082,
            "Diffracted light through relay and objective",
            "Collected fluorescence",
        )
    else:
        chamber = assembly(
            "chamber",
            "Ion trap vacuum assembly",
            [280, 150, 0],
            [230, 190, 210],
            "vacuum",
        )
        drive = assembly(
            "drive",
            "Transport electrode drive",
            [-35, 100, 125],
            [110, 54, 100],
            "mixer",
        )
        readout = assembly(
            "readout",
            "Optical position readout",
            [535, 145, 0],
            [110, 90, 150],
            "camera",
        )
        endpoint = assembly(
            "endpoint",
            "Ion transport axis",
            [280, 150, 0],
            [0.42, 0.005, 0.14],
            "trap",
            "Position markers use the experiment’s signed transport coordinate in µm.",
        )
        zoom, link, back = (
            0.40,
            "Filtered electrode command",
            "Optical probe and photon collection",
        )
        if identifier == "qccd-slow":
            chamber.update(label="Penning microtrap assembly", kind="penning")
            endpoint.update(
                label="Beryllium ion trapping region",
                basis="Reference cross-section for the separate ETH experiment.",
            )
            readout.update(label="Sideband population readout")
        elif identifier == "qccd-pair":
            endpoint.update(
                label="Segmented Paul trap",
                sizeMm=[1.82, 0.005, 0.64],
                basis="Walther et al. show 250 µm segments separated by 30 µm gaps and electrode rows 500 µm apart.",
            )
            zoom = 2.0
            readout.update(label="Motional sideband readout")
        elif identifier == "qccd-h2":
            profile = json.loads(
                (
                    Path(__file__).resolve().parents[1]
                    / "physical"
                    / "qccd-installation.json"
                ).read_text(encoding="utf8")
            )
            die = next(p for p in profile["parts"] if p["id"] == "chip")
            drive.update(label="Analysis-pulse controls")
            dac.update(
                label="Reference angle-word output",
                basis="These reference levels encode signed rotation words. They do not measure H2 DAC voltage.",
            )
            endpoint.update(
                label="H2 racetrack qubits",
                kind="h2",
                sizeMm=die["sizeMm"],
                basis=die["basis"],
                fieldSpanMm=profile["chipModel"]["electrodeSpanMm"],
                isthmusWidthMm=profile["chipModel"]["isthmusWidthMm"],
            )
            zoom = 9.4
            link, back = (
                "Phase-programmed qubit control",
                "State-dependent fluorescence",
            )
            readout.update(label="32-ion state readout")
    parts = [
        assembly(
            "surface",
            "Installation base",
            [0, -8, 0],
            [1340, 16, 720],
            "base",
            "Reference mounting surface. Drawn distances do not set propagation delays.",
        ),
        assembly("frame", "Electronics rack", [-380, 110, 0], [482, 220, 330], "frame"),
        rack,
        dac,
        drive,
        chamber,
        endpoint,
        readout,
    ]
    if platform == "neutral":
        parts.extend(
            [
                assembly(
                    "laser",
                    "938 nm tweezer source",
                    [-60, 90, -140],
                    [150, 65, 155],
                    "mixer",
                ),
                assembly(
                    "objective",
                    "NA 0.55 objective",
                    [280, 82, 0],
                    [42, 70, 42],
                    "optic",
                    "Brooks et al. report a 35.24 mm effective focal length. The housing is illustrative.",
                ),
            ]
        )
    if platform == "superconducting":
        parts.extend(
            [
                assembly(
                    "lo",
                    "Microwave local oscillator",
                    [-40, 90, -155],
                    [160, 55, 150],
                    "rack",
                ),
                assembly(
                    "receiver-split",
                    "90° hybrid and output channels",
                    [50, 65, -220],
                    [95, 36, 70],
                    "mixer",
                ),
            ]
        )
    anchors = {p["id"]: p["centerMm"] for p in parts}
    links = []
    routes = [
        (
            "dac-bus",
            "controller",
            "dac",
            "Digital waveform bus",
            [[-380, 160, 165], [-380, 92, 165]],
        ),
        ("analog", "dac", "drive", "DAC output", [[-152, 92, 160], [-70, 83, 160]]),
        ("drive-path", "drive", "endpoint", link, [[95, 102, 125], [190, 120, 48]]),
        (
            "return-path",
            "endpoint",
            "readout",
            back,
            [[370, 150, -84], [415, 130, -130]],
        ),
    ]
    if platform == "neutral":
        routes[2] = (
            "drive-path",
            "drive",
            "objective",
            "Deflected light through relay",
            [[105, 102, 130], [200, 82, 60]],
        )
        routes.extend(
            [
                ("light-input", "laser", "drive", "Incident tweezer light", []),
                ("focus-light", "objective", "endpoint", "Focused tweezer beam", []),
            ]
        )
    if platform == "superconducting":
        routes[3] = (
            "return-path",
            "endpoint",
            "receiver-split",
            "Microwave emission line",
            [[350, 150, -84], [230, 90, -180]],
        )
        routes.extend(
            [
                ("lo-line", "lo", "drive", "Local oscillator coax", []),
                (
                    "receiver-line",
                    "receiver-split",
                    "readout",
                    "Heterodyne acquisition channels",
                    [],
                ),
            ]
        )
    for link_id, start, end, kind, via in routes:
        links.append(
            {
                "id": link_id,
                "from": start,
                "to": end,
                "kind": kind,
                "pointsMm": [anchors[start], *via, anchors[end]],
            }
        )
    sources = [{"title": "Experimental measurements", "url": meta["source"]}]
    result = {
        "unit": "mm",
        "name": chamber["label"],
        "platform": platform,
        "note": "Rack, cable routes and apparatus envelopes are reference geometry. "
        "The measured output and the independent design source are identified separately.",
        "parts": parts,
        "links": links,
        "sources": sources,
        "focus": [
            {
                "id": "installation",
                "label": "Full control path",
                "centerMm": [0, 180, 0],
                "spanMm": 1540,
            },
            {
                "id": "controller",
                "label": "FPGA and waveform DAC",
                "centerMm": [-380, 125, 0],
                "spanMm": 620,
            },
            {
                "id": "chamber",
                "label": chamber["label"],
                "centerMm": chamber["centerMm"],
                "spanMm": max(chamber["sizeMm"]) * 1.8,
            },
            {
                "id": "endpoint",
                "label": endpoint["label"],
                "centerMm": endpoint["centerMm"],
                "spanMm": zoom,
            },
        ],
    }
    if platform in ("neutral", "superconducting"):
        result["focus"].append(
            {
                "id": "design",
                "label": "ZAC design"
                if platform == "neutral"
                else "Qiskit Metal design",
                "centerMm": endpoint["centerMm"],
                "spanMm": 0.055 if platform == "neutral" else 1.5,
            }
        )
    return result
