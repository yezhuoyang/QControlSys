"""Rebuild the INO/LENS observations from the pinned author archives (standard library)."""
import argparse
import csv
import hashlib
import io
import json
from decimal import Decimal
from pathlib import Path
import re
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
REV = "94cecd4eb9d04f4ebb957f70a5783b45cbd7a51a"
BASE = f"https://raw.githubusercontent.com/INO-quantum/FPGA-SoC-experiment-control/{REV}/paper/data/"
ARCHIVES = {
    "figure_4": "0ed7bdf8d70b325710f51b08e62f27a366b41a8732723ee8e0183f2b7cc595a8",
    "figure_10": "a36d638a23e3fc02a6e70c728afff7df567bf780a5eab54303b2d51c3d9bc9ee",
    "figure_6_and_8": "d09f60412be5a9c76116ab7f7f5c1c4950c30897b9e1e9431cbb3805d61d0246",
}


def archive(name, cache):
    filename = name + ".zip"
    data = (cache / filename).read_bytes() if cache else urllib.request.urlopen(BASE + filename, timeout=30).read()
    if hashlib.sha256(data).hexdigest() != ARCHIVES[name]:
        raise ValueError(f"Archive checksum changed: {filename}")
    return zipfile.ZipFile(io.BytesIO(data))


def scope_channel(z, name):
    rows = csv.reader(io.StringIO(z.read(name).decode("latin1")))
    times, values = [], []
    for row in rows:
        us, mv = Decimal(row[3]) * 10**6, Decimal(row[4]) * 1000
        if us != int(us) or mv != int(mv):
            raise ValueError(f"Lossy normalization in {name}")
        times.append(int(us))
        values.append(int(mv))
    if len(times) != 2500 or any(t != times[0] + i * 400 for i, t in enumerate(times)):
        raise ValueError(f"Unexpected scope grid in {name}")
    return times[0], values


def pinout(cache):
    member = "firmware-source/2017.4/Vivado/xdc/Cora-Z7-buffer-board-v1.2.xdc"
    url = f"https://raw.githubusercontent.com/INO-quantum/FPGA-SoC-experiment-control/{REV}/{member}"
    data = (cache / "cora-v12.xdc").read_bytes() if cache else urllib.request.urlopen(url, timeout=30).read()
    sha = hashlib.sha256(data).hexdigest()
    if sha != "46378d4fae215ae2e85cbb0f251b1cee18fb04a8b3e216f0ed66411dfa6eae92":
        raise ValueError("Unexpected FPGA package constraints")
    assignments = dict((port, pin) for pin, port in re.findall(
        r"^set_property -dict \{PACKAGE_PIN (\w+) IOSTANDARD LVCMOS33\} \[get_ports \{?(\w+(?:\[\d+\])?)\}?\]",
        data.decode(), re.MULTILINE))
    return dict(member=member, sha256=sha, data=[assignments[f"bus_data_0[{i}]"] for i in range(16)],
                address=[assignments[f"bus_addr_0[{i}]"] for i in range(7)],
                strobe=assignments["bus_strb_0"], start=assignments["trg_start_0"])


def extract(cache):
    captures, cables = [], []
    with archive("figure_10", cache) as z:
        for mode, folder in [("free", "FREE"), ("gated", "START_STOP")]:
            for rep in range(5):
                paths = [f"figure_10/CYCLING_{folder}/ch{ch+1}/TEK{2*rep+ch:04}.CSV" for ch in range(2)]
                (first, trigger), (other, output) = [scope_channel(z, name) for name in paths]
                if first != other:
                    raise ValueError("Channel time bases disagree")
                captures.append(dict(id=f"{mode}-{rep+1}", mode=mode, members=paths, startUs=first,
                                     stepUs=400, triggerMv=trigger, outputMv=output))
    with archive("figure_6_and_8", cache) as z:
        pattern = re.compile(r"figure_6_and_8/data_1/prim/data_(0|90|180|270)/result_prim_([\d.]+)m\.csv")
        for name in sorted(z.namelist()):
            if match := pattern.fullmatch(name):
                rows = csv.reader(io.StringIO(z.read(name).decode()))
                # Row type 8 in the authors' analysis gives the board-estimated one-way delay in ps.
                values = [int(row[1]) for row in rows if row and row[0] == "8"]
                if not values:
                    raise ValueError(name)
                cables.append(dict(member=name, phaseDeg=int(match[1]), lengthMm=int(Decimal(match[2])*1000),
                                   estimatesPs=values))
    if len(cables) != 47 or len({row["lengthMm"] for row in cables}) != 12:
        raise ValueError("Unexpected length/phase inventory (11.3 m at 270° is absent in the archive)")
    member = "figure_4/data/Cora-Z7-10/20201111_c10_TX.csv"
    groups, excluded = {}, []
    with archive("figure_4", cache) as z:
        for line, row in enumerate(csv.reader(io.StringIO(z.read(member).decode())), 1):
            if not row:
                continue
            if row[1].startswith("*") and "remove outlier" in [v.strip() for v in row[12:]]:
                excluded.append(line)
                continue
            count, transmitted, cycles = map(int, row[:3])
            if count != transmitted or cycles <= 0 or int(row[11]) != 0:
                raise ValueError(f"Unexpected TX-only counter record at line {line}")
            groups.setdefault(count, []).append(cycles)
    if sum(map(len, groups.values())) != 580 or len(excluded) != 1:
        raise ValueError("Unexpected TX-only counter inventory")
    dma = dict(member=member, excludedAuthorMarkedLines=excluded,
               groups=[dict(records=n, cycles=groups[n]) for n in sorted(groups)])
    return dict(revision=REV, archiveSHA256=ARCHIVES, captures=captures, cables=cables, dma=dma)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, help="Read the original zip files from this directory")
    cache = parser.parse_args().cache
    data = extract(cache)
    pins = pinout(cache)
    (ROOT / "observations.json").write_bytes((json.dumps(data, separators=(",", ":")) + "\n").encode())
    (ROOT / "cora-pinout.json").write_bytes((json.dumps(pins, indent=2) + "\n").encode())
