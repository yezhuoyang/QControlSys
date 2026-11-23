"""Build and export a native Quantum Metal TransmonPocket. Requires quantum-metal==0.10.1."""

import argparse
import json
import math
from tempfile import TemporaryDirectory
from importlib.metadata import version
from pathlib import Path

from qiskit_metal import designs
from qiskit_metal.qlibrary.qubits.transmon_pocket import TransmonPocket
from shapely import box, union_all
from shapely.geometry import Polygon
import gdstk


METAL_VERSION = "0.10.1"
REVISION = "6d67d409b0994259cb3e9ac1b492440e03178a6b"
SOURCE = ("https://github.com/qiskit-community/qiskit-metal/blob/" + REVISION +
          "/src/qiskit_metal/qlibrary/qubits/transmon_pocket.py")
PADS = {"drive": {"loc_W": "-1", "loc_H": "+1"}, "emit": {"loc_W": "+1", "loc_H": "-1"}}


def xy(coords):
    return [[round(float(x), 12), round(float(y), 12)] for x, y in coords]


def polygon_record(poly):
    return {
        "points": xy(poly.exterior.coords[:-1]),
        "holes": [xy(ring.coords[:-1]) for ring in poly.interiors],
    }


def polygon_members(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    raise ValueError("Expected polygonal geometry, got " + geometry.geom_type)


def verify_gds(design, masks):
    """Compare the native positive-mask GDS and the browser mask at its 1 nm write precision."""
    renderer = design.renderers.gds
    renderer.options.cheese.view_in_file.main[1] = False
    renderer.options.no_cheese.view_in_file.main[1] = False
    with TemporaryDirectory() as directory:
        filename = Path(directory, "layout.gds")
        if renderer.export_to_gds(str(filename)) != 1:
            raise ValueError("The upstream GDS renderer rejected the example")
        library = gdstk.read_gds(str(filename), unit=1e-3)
    native = [p for cell in library.top_level() for p in cell.get_polygons() if p.layer == 1]
    # The GDS ground uses fractured/keyhole boundaries. A zero buffer resolves the touching seams.
    actual = union_all([Polygon(p.points).buffer(0) for p in native])
    expected = union_all([Polygon(r["points"], r["holes"]) for r in masks])
    difference = expected.symmetric_difference(actual).area
    if difference > 1e-7:
        raise ValueError(f"Native GDS and displayed metal differ by {difference:g} mm²")
    return {"layer": 1, "nativePolygonCount": len(native), "nativeAreaMm2": actual.area,
            "displayAreaMm2": expected.area, "symmetricDifferenceMm2": difference,
            "maxDifferenceMm2": 1e-7, "gdsPrecisionM": library.precision}


def build():
    if version("quantum-metal") != METAL_VERSION:
        raise RuntimeError("Install quantum-metal==" + METAL_VERSION + " to reproduce this export")
    design = designs.DesignPlanar()
    component = TransmonPocket(design, "Q1", options={"connection_pads": PADS})
    if design.get_units() != "mm":
        raise ValueError("Expected millimetres from DesignPlanar")
    chip = design.parse_value(design.chips["main"]["size"])
    x, y = chip["center_x"], chip["center_y"]
    w, h = chip["size_x"], chip["size_y"]
    bounds = [x - w / 2, y - h / 2, x + w / 2, y + h / 2]
    ground = box(*bounds)
    negatives = []
    additions = []
    records = {"polygons": [], "paths": [], "junctions": []}
    for table, group in [("poly", "polygons"), ("path", "paths"), ("junction", "junctions")]:
        for row in design.qgeometry.tables[table].itertuples(index=False):
            if row.component != component.id or row.helper:
                continue
            if row.chip != "main" or int(row.layer) != 1:
                raise ValueError("Unexpected chip or layer")
            shape = row.geometry
            record = {"name": row.name, "layer": int(row.layer), "subtract": bool(row.subtract)}
            if table == "poly":
                record.update(polygon_record(shape))
                mask = shape
            else:
                record.update({"points": xy(shape.coords), "widthMm": float(row.width)})
                if table == "path":
                    fillet = float(row.fillet or 0)
                    if math.isfinite(fillet) and fillet != 0:
                        raise ValueError(f"Path {row.name} needs {fillet} mm upstream fillet tessellation")
                mask = shape.buffer(row.width / 2, cap_style="flat", join_style="mitre")
            records[group].append(record)
            # Metal's junction QGeometry is a lumped simulation element, not a lithographic mask.
            if table != "junction":
                if row.subtract:
                    negatives.append(mask)
                else:
                    additions.append((row.name, mask))

    ground = ground.difference(union_all(negatives))
    metal = [{"name": "ground", "role": "ground", "layer": 1, **polygon_record(p)}
             for p in polygon_members(ground)]
    for p in polygon_members(union_all([shape for _, shape in additions])):
        names = sorted(name for name, shape in additions if p.intersection(shape).area > 1e-14)
        if p.intersection(ground).area > 1e-12:
            raise ValueError("Additive electrodes overlap the resolved ground plane")
        role = "electrode" if any(name in {"pad_top", "pad_bot"} for name in names) else "port"
        metal.append({"name": " + ".join(names), "role": role, "layer": 1, **polygon_record(p)})
    metal.sort(key=lambda r: (r["role"] != "ground", r["name"]))
    pins = [
        {"name": name, "layer": 1, "widthMm": float(pin.width), "gapMm": float(pin.gap),
         "points": xy(pin.points), "middle": xy([pin.middle])[0], "normal": xy([pin.normal])[0]}
        for name, pin in component.pins.items()
    ]
    if len(pins) != 2 or len(records["junctions"]) != 1:
        raise ValueError("Expected two connected pins and one lumped junction")
    return {
        "version": 1, "unit": "mm", "component": "TransmonPocket", "instance": component.name,
        "distribution": "quantum-metal", "distributionVersion": METAL_VERSION, "revision": REVISION,
        "source": SOURCE, "license": "Apache-2.0", "pinOptions": PADS,
        "chip": {"name": "main", "material": design.chips["main"]["material"],
                 "boundsMm": bounds, "surfaceZMm": chip["center_z"],
                 "substrateThicknessMm": abs(chip["size_z"]), "substrateDirection": "-Z"},
        "metalPolygons": metal, "pins": pins, **records, "gdsCheck": verify_gds(design, metal),
        "scope": "Planar example layout generated by native Quantum Metal. Film thickness, physical junction mask and identity of any fabricated device are unspecified.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("metal-layout.json"))
    args = parser.parse_args()
    args.output.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
