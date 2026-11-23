import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = resolve(
  process.env.QCCD_STUDIO_ROOT || join(root, "..", "QCCD"),
);
const python = process.env.QCONTROL_PYTHON || "python";
const bridge = join(root, "bridge", "qccd_studio.py");
const fixture = JSON.parse(
  readFileSync(
    join(root, "bridge", "fixtures", "three-hop.studio.json"),
    "utf8",
  ),
);
const integration = {
  skip:
    !existsSync(join(upstream, "qccd", "verify", "replay.py")) &&
    "requires QCCD_STUDIO_ROOT or a sibling QCCD checkout",
};

function invoke(args, input, env = process.env) {
  const proc = spawnSync(python, ["-B", ...args], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: args.includes("--studio-html") ? 120000 : 30000,
    env,
  });
  if (proc.error) throw proc.error;
  assert.ok(proc.stdout, proc.stderr);
  return { status: proc.status, result: JSON.parse(proc.stdout) };
}

function run(request) {
  const { status, result } = invoke([bridge], request);
  assert.equal(status, 0, result.error);
  return result;
}

function rejected(request, pattern) {
  const { status, result } = invoke([bridge], request);
  assert.notEqual(status, 0);
  assert.match(result.error, pattern);
}

function openNativePage(html) {
  // Studio's test harness executes its whole emitted page. Run in a child:
  // the native DOM shim owns that process's globals for its entire lifetime.
  const harness = `
    import {loadPage} from ${JSON.stringify(pathToFileURL(join(upstream, "tests", "shim.mjs")).href)};
    globalThis.__QCCD_SYNC = true;
    loadPage(process.argv[1]);
    console.log(JSON.stringify({snapshot: EDITOR.snapshot(), pair: EDITOR.exportPair()}));`;
  const dir = mkdtempSync(join(tmpdir(), "qcontrol-page-test-"));
  const output = join(dir, "studio.html");
  writeFileSync(output, html, "utf8");
  try {
    const proc = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", harness, output],
      { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout.trim().split("\n").at(-1));
  } finally {
    unlinkSync(output);
    rmdirSync(dir);
  }
}

test(
  "the native editor restores source calls and edits, then its exported files replay in QControl",
  integration,
  () => {
    const doc = structuredClone(fixture);
    doc.saved_at_frame = 2;
    doc.edits.push({
      method: "set_site_capacity",
      args: [["S2"], 2],
      kwargs: {},
    });
    const { status, result } = invoke([bridge, "--studio-html"], {
      studio: doc,
    });
    assert.equal(status, 0, result.error);
    const data = JSON.parse(
      result.html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1],
    );
    assert.equal(data.arch.name, "rotation-preview");
    assert.equal(data.program.frames.length, 4);
    assert.match(result.html, /stage3d\.js/);
    const opened = openNativePage(result.html);
    assert.deepEqual(opened.snapshot.edits, doc.edits);
    assert.deepEqual(opened.snapshot.seed, doc.seed);
    assert.deepEqual(
      opened.snapshot.program.calls.map((r) => [r.method, r.args]),
      doc.program.calls.map((r) => [r.method, r.args || []]),
    );
    assert.equal(opened.snapshot.saved_at_frame, 2);
    const replayed = run({
      architecture: opened.pair.arch.text,
      program: opened.pair.tsir.text,
    });
    assert.deepEqual(replayed.frames, run({ studio: doc }).frames);
  },
);

test(
  "the native compiled H2 export retains all labelled instructions, gate operands and metric geometry",
  integration,
  () => {
    const { result: demo } = invoke([bridge, "--demo"]);
    const { status, result } = invoke([bridge, "--studio-html"], demo);
    assert.equal(status, 0, result.error);
    const data = JSON.parse(
      result.html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1],
    );
    assert.equal(data.tech.nm_per_unit_x, 750000);
    const { pair } = openNativePage(result.html);
    const original = run(demo);
    const returned = run({
      architecture: pair.arch.text,
      program: pair.tsir.text,
    });
    assert.deepEqual(returned.frames, original.frames);
    assert.deepEqual(returned.sourceInstructions, original.sourceInstructions);
    assert.deepEqual(returned.system, original.system);
  },
);

test("QCCD Studio reports a missing optional checkout", () => {
  const { status, result } = invoke([bridge, "--demo"], undefined, {
    ...process.env,
    QCCD_STUDIO_ROOT: join(root, "bridge", "fixtures", "absent"),
  });
  assert.notEqual(status, 0);
  assert.match(result.error, /QCCD_STUDIO_ROOT/);
});

test(
  "native Studio authored calls and edits replay, with each broadcast hop visible",
  integration,
  () => {
    const doc = structuredClone(fixture);
    doc.arch = { name: "untrusted cached representation" };
    doc.edits.push({ method: "move_site", args: ["S2", 2.25, 0] });
    const trace = run({ architecture: JSON.stringify(doc) });
    assert.equal(trace.machine.name, "rotation-preview");
    assert.deepEqual(
      trace.machine.nodes.find((n) => n.id === "S2").pos,
      [2.25, 0, 0],
    );
    assert.equal(trace.program.instructions, 4);
    assert.equal(trace.timing.unit, "model µs");
    assert.deepEqual(
      trace.frames.map((f) => f.id),
      ["tsir-0-0", "tsir-1-0", "tsir-1-1", "tsir-1-2", "tsir-2-0", "tsir-3-0"],
    );
    assert.deepEqual(
      trace.frames
        .filter((f) => f.sourceId === 1)
        .map((f) => f.positions["ion-a"]),
      ["S1", "S2", "S3"],
    );
    assert.deepEqual(trace.final.positions, { "ion-a": "S2", "ion-b": "S6" });
    assert.deepEqual(
      trace.sourceInstructions.map((row) => row.type),
      ["init", "simd", "barrier", "simd"],
    );
    assert.deepEqual(run({ studio: doc }), trace);
  },
);

test(
  "Studio distinguishes rule violations, invalid sources, stale artifacts and excessive rotations",
  integration,
  () => {
    const { result: demo } = invoke([bridge, "--demo"]);
    const init = { id: 441, type: "init", placement: { i: "AUXD0" } };
    // arch_spec can be an export alias. Only the supplied architecture is opened.
    const req = (...rest) => ({
      architecture: demo.architecture,
      program: {
        name: "debug",
        arch_spec: "../unused.arch.json",
        instructions: [init, ...rest],
      },
    });
    const trace = run(req({ id: 991, type: "gate", gate: "R", ions: ["i"] }));
    assert.deepEqual(trace.rules.failed, ["R6"]);
    assert.equal(trace.rules.details[0].sourceId, 991);
    assert.deepEqual(trace.frames[1].targets, ["AUXD0"]);
    rejected(req({ ...init }), /duplicate instruction id/);
    rejected(
      req({ id: 11, type: "unknown_operation" }),
      /11.*unknown type.*unknown_operation/,
    );
    rejected(
      req({
        id: 12,
        type: "simd",
        class: "shuttle",
        mode: "inter",
        participants: [{ ion: "i", from: "DG01", to: "AUXD0" }],
      }),
      /12.*DG01.*AUXD0/,
    );
    rejected(
      req({
        id: 13,
        type: "simd",
        class: "rotate_cw",
        mode: "inter",
        template: { kind: "loop_shift", loop: "L0", delta: 1e9 },
      }),
      /expanded cycle/,
    );
    const doc = structuredClone(fixture);
    doc.final_program = { artifact: "sha256:" + "0".repeat(64) };
    rejected({ studio: doc }, /original compiled TSIR/);
    rejected(
      { studio: doc, program: JSON.stringify(req().program) },
      /artifact digest/,
    );
    delete doc.final_program;
    doc.seed.kwargs.template = "../arch/ring144_24v.arch.json";
    rejected({ studio: doc }, /shipped template by name/);
  },
);

test(
  "GHZ32 matches Studio's independently rendered program, rail paths and gate order at every cycle",
  integration,
  () => {
    const { status, result: demo } = invoke([bridge, "--demo"]);
    assert.equal(status, 0);
    const base = join(upstream, "Reproduce", "moses2023");
    assert.equal(
      demo.architecture,
      readFileSync(join(base, "h2.arch.json"), "utf8"),
    );
    assert.equal(
      demo.program,
      readFileSync(join(base, "demo", "ghz32.tsir.json"), "utf8"),
    );
    const trace = run(demo);
    // Use Studio's own web page payload (one frame per source statement) and
    // its JS rotationPaths operator as the independent browser-side oracle.
    const reference = String.raw`
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from qccd.arch import Architecture
from qccd.cost import corrected_model
from qccd.ir.tsir import TSIR
from qccd.verify import verify
from qccd.viz import build_view_model
base = root / "Reproduce" / "moses2023"
arch = Architecture.from_json(json.loads((base / "h2.arch.json").read_bytes()))
prog = TSIR.load(base / "demo" / "ghz32.tsir.json")
model = corrected_model(table="local")
report = verify(prog, arch, model)
page = build_view_model(arch, prog, report.result, model, include_listing=False, include_control=False,
                        evaluation=False, template_stems=[], provenance="off")
print(json.dumps({"frames": page["program"]["frames"], "loops": page["arch"]["loops"],
                  "nodes": page["arch"]["nodes"], "segments": page["arch"]["segments"],
                  "cycles": [[c.instr_id,c.t0,c.t1] for c in report.result.cycles]}))
`;
    const native = invoke(["-c", reference, upstream]);
    assert.equal(native.status, 0);
    const page = native.result;
    const { rotationPaths } = createRequire(import.meta.url)(
      join(upstream, "qccd", "viz", "engine.js"),
    );
    const bends = Object.fromEntries(
      page.nodes
        .filter((n) => n.kind === "junction" && n.deg === 2)
        .map((n) => [n.id, true]),
    );
    const edge = new Map();
    for (const s of page.segments) {
      edge.set(JSON.stringify([s.a, s.b]), s.id);
      edge.set(JSON.stringify([s.b, s.a]), s.id);
    }
    const expected = {},
      actual = {};
    let cursor = 0,
      gateRounds = 0;
    for (const [index, frame] of page.frames.entries()) {
      const hops = frame.shift ? Math.max(1, Math.abs(frame.shift[1])) : 1;
      if (frame.pairs?.length) gateRounds++;
      for (let hop = 0; hop < hops; hop++) {
        const row = trace.frames[cursor];
        assert.deepEqual(
          [row.sourceIndex, row.sourceId, row.substep, row.op],
          [index, frame.id, hop, frame.type],
        );
        assert.deepEqual(
          [row.sourceId, row.start, row.end],
          page.cycles[cursor],
        );
        assert.deepEqual(
          row.parents,
          cursor ? [trace.frames[cursor - 1].id] : [],
        );
        if (frame.place) Object.assign(expected, frame.place);
        let routes = frame.moves || [];
        if (frame.shift) {
          routes = Object.entries(
            rotationPaths(
              page.loops[frame.shift[0]],
              bends,
              expected,
              Math.sign(frame.shift[1]),
            ),
          );
        }
        const paths = new Map(row.moves.map((move) => [move.ion, move]));
        assert.equal(paths.size, routes.length);
        for (const [ion, path] of routes) {
          assert.equal(expected[ion], path[0]);
          assert.deepEqual(paths.get(ion), {
            ion,
            from: path[0],
            to: path.at(-1),
            via: path
              .slice(1)
              .map((site, i) => edge.get(JSON.stringify([path[i], site]))),
          });
          expected[ion] = path.at(-1);
        }
        Object.assign(actual, row.positions);
        assert.deepEqual(actual, expected, row.id);
        if (frame.type === "gate") {
          assert.equal(row.label, frame.gate);
          assert.deepEqual(row.ions, [...new Set(frame.acts.flat())]);
          assert.deepEqual(
            row.targets,
            [...new Set(frame.acts.flat().map((i) => expected[i]))].sort(),
          );
        }
        cursor++;
      }
    }
    assert.equal(trace.machine.nodes.length, 59);
    assert.equal(page.frames.length, 674);
    assert.equal(cursor, trace.frames.length);
    assert.equal(gateRounds, 9);
    assert.deepEqual(trace.final.positions, expected);
    assert.deepEqual(trace.summary, {
      ions: 32,
      cycles: 947,
      gatePairs: 31,
      measurements: 32,
      ruleViolations: 0,
    });
    assert.equal(trace.timing.unit, "model units");
    assert.match(trace.machine.geometryNote, /750 µm/);
    const conveyor = trace.frames.find((f) =>
      f.control.banks.some((bank) => bank.channels.includes("conveyor.a")),
    );
    assert.equal(conveyor.control.driver, "transport");
    assert.equal(conveyor.control.feasible, true);
    assert.deepEqual(
      conveyor.physicalParts,
      trace.system.studioBindings.driver.transport,
    );
  },
);
