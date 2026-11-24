"""Apply the QuantumOS name and theme to the pages and documents. Safe to run again.

    python scripts/rebrand.py            apply
    python scripts/rebrand.py --check    report what would change, change nothing

It renames only what a reader sees. Code identifiers keep their names: the Lean namespace
QControl.RiscQ, the qcontrol executable, QCONTROL_* environment variables and file paths.
The palette is mapped value by value in stylesheets, page markup and the menu bar. Colours that
three.js scenes use are left alone, because they mean parts of the machine, not the brand.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECK = "--check" in sys.argv

# The QuantumOS palette: deep indigo to cyan, cool greys.
PALETTE = {
    "#00695d": "#4338ca",   # primary (was teal)
    "#116959": "#4338ca",
    "#58b8ac": "#22b8cf",   # primary light, logo gradient end
    "#e4f1ec": "#eef0fe",   # primary soft background
    "#eef3f1": "#f1f3f9",   # code background
    "#e3eae7": "#e6e9f2",   # soft line
    "#d3ddda": "#dde1ea",   # line
    "#cdd8d5": "#d6dbe6",
    "#152b2d": "#111827",   # ink
    "#5a6c6f": "#586174",   # muted
    "#526568": "#586174",
    "#637471": "#586174",
    "#33494c": "#2d3748",
    "#3f5457": "#3b4456",
    "#1f3a5f": "#1e1b4b",   # navy → deep indigo
    "#fbfcfb": "#fafbfd",   # page background
    "#f4f6f3": "#f5f6fa",
    "#f6f9f8": "#f7f8fc",
}

TEXT = [
    (re.compile(r"QControl\s*\n\s*<span>Studio</span>"), "QuantumOS"),
    (re.compile(r"QControl <span>Studio</span>"), "QuantumOS"),
    (re.compile(r'element\("b", \{\}, "QControl"\), element\("span", \{\}, "Studio"\)'), 'element("b", {}, "QuantumOS")'),
    (re.compile(r"QControl [Ss]tudio"), "QuantumOS"),
    (re.compile(r"QControl course"), "QuantumOS course"),
    (re.compile(r"QControl <span>studio</span>"), "QuantumOS"),
    (re.compile(r"(?<![\w/\\.\-])QControlSys(?![\w/\\])"), "QuantumOS"),
    # "QControl background", "QControl pages", "The QControl course": the name before a word.
    (re.compile(r"\bQControl(?= [a-z])"), "QuantumOS"),
]
FAVICON = (re.compile(r'<link rel="icon" href="data:," />'), '<link rel="icon" href="/quantumos.svg" type="image/svg+xml" />')
MARK = "url(\"/quantumos.svg\") center / cover no-repeat"


def files():
    studio = ROOT / "studio"
    for p in studio.rglob("*"):
        if p.suffix in (".html", ".css"):
            yield p, True
    yield studio / "site-nav.js", True
    for p in (studio / "course").glob("*.js"):
        yield p, True
    yield studio / "app.js", False
    for name in ("README.md", "AGENTS.md", "server.mjs", "package.json"):
        yield ROOT / name, False
    for p in (ROOT / "docs").rglob("*.md"):
        yield p, False
    yield ROOT / "docs" / "media" / "capture.mjs", False
    for p in (ROOT / "scripts").glob("*.ps1"):
        yield p, False


changed = []
for path, themed in files():
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    new = text
    for pattern, replacement in TEXT:
        new = pattern.sub(replacement, new)
    if path.suffix == ".html":
        new = FAVICON[0].sub(FAVICON[1], new)
    if themed:
        for old, value in PALETTE.items():
            new = re.sub(re.escape(old), value, new, flags=re.I)
    if path.name == "package.json":
        new = new.replace('"name": "qcontrol-studio"', '"name": "quantumos"')
    if new != text:
        changed.append(path.relative_to(ROOT))
        if not CHECK:
            path.write_bytes(new.encode("utf-8"))

# The brand mark: the logo instead of the drawn squares.
marks = [
    (ROOT / "studio" / "riscq-studio.css", re.compile(r"(\.brand i \{[^}]*?)background:[^;]*;", re.S)),
    (ROOT / "studio" / "site-nav.js", re.compile(r"(\.qn-brand i\{[^}]*?)background:[^;}]*", re.S)),
]
for path, pattern in marks:
    if not path.exists():
        continue
    text = path.read_text(encoding="utf-8")
    end = ";" if path.suffix == ".css" else ""
    new = pattern.sub(lambda m: m.group(1) + "background:" + MARK + end, text, count=1)
    if new != text:
        changed.append(path.relative_to(ROOT))
        if not CHECK:
            path.write_bytes(new.encode("utf-8"))

# The older pages' mark is a clipped octagon of stripes: replace the whole rule.
style = ROOT / "studio" / "style.css"
text = style.read_text(encoding="utf-8")
MARK_RULE = (".brand-mark {\n  display: inline-block;\n  width: 24px;\n  height: 24px;\n  margin-right: 4px;\n"
             "  border-radius: 6px;\n  background: " + MARK + ";\n}")
new = re.sub(r"\.brand-mark \{[^}]*\}", lambda m: MARK_RULE, text, count=1)
if new != text:
    changed.append(style.relative_to(ROOT))
    if not CHECK:
        style.write_bytes(new.encode("utf-8"))

print(("would change " if CHECK else "changed ") + str(len(set(changed))) + " files")
for p in sorted(set(map(str, changed))):
    print("  " + p)
