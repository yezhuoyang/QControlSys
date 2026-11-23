"""Digitize the published Figure 8 curves. Input is the authors' CC BY 4.0 raster."""
import argparse
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen
from PIL import Image

FIGURE = "https://arxiv.org/html/2605.01132v1/images/slew_plot.png"
DIGEST = "2da243838fe8e01b7986148075bfe2d9ac2b9ea80a80b9ba7a5a0fd20d626990"
ROOT = Path(__file__).resolve().parent


def digitize(raw):
    if hashlib.sha256(raw).hexdigest() != DIGEST:
        raise ValueError("Figure 8 image checksum changed")
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.size != (877, 879):
        raise ValueError("Unexpected figure dimensions")
    edges = {}
    for name, zero, top, bottom in [("rising", 215, 41, 389), ("falling", 635, 461, 809)]:
        low, high = [], []
        for x in range(94, 866):
            ys = [y for y in range(top, bottom + 1) if im.getpixel((x, y)) == (31, 119, 180)]
            if not ys:
                raise ValueError(f"No blue stroke at {name} x={x}")
            # The +10 V and -10 V grid lines lie 304 pixels apart in both panels.
            low.append(round((zero - max(ys)) * 20000 / 304))
            high.append(round((zero - min(ys)) * 20000 / 304))
        edges[name] = dict(lowMv=low, highMv=high)
    return dict(figure=FIGURE, sha256=DIGEST, attribution="Peaks, Kaarls and Noel (2026), Figure 8, CC BY 4.0",
                firstPixel=94, zeroPixel=479, pixelsPer80Us=619, edges=edges)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, help="Use a local copy of slew_plot.png")
    args = parser.parse_args()
    raw = args.image.read_bytes() if args.image else urlopen(FIGURE, timeout=30).read()
    result = digitize(raw)
    (ROOT / "peaks-figure8.json").write_bytes((json.dumps(result, separators=(",", ":")) + "\n").encode())
