import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { simulate } from "../server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const report = JSON.parse(
  await readFile(new URL("../validation/results.json", import.meta.url)),
);
function runPython(args, input = "") {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      process.env.QCONTROL_PYTHON || "python",
      ["-B", "-X", "utf8", ...args],
      { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 16000000 },
      (err, stdout, stderr) =>
        err ? reject(Error(stderr.trim() || err.message)) : resolve(stdout),
    );
    proc.stdin.end(input);
  });
}
async function replay(platform, experiment, id, program) {
  return JSON.parse(
    await runPython(
      ["validation/run.py", "--replay"],
      JSON.stringify({ platform, experiment, case: id, program }),
    ),
  );
}

test("the archived instrument report reproduces offline from native waveforms and held-out experimental observations", async () => {
  const next = JSON.parse(await runPython(["validation/run.py"]));
  assert.deepEqual(
    Object.keys(next.experiments),
    Object.keys(report.experiments),
  );
  for (const [id, r] of Object.entries(next.experiments)) {
    const expected = report.experiments[id];
    assert.equal(r.independentScore.passed, r.metrics.passed);
    assert.equal(r.metrics.passed, expected.metrics.passed);
    assert.equal(r.independentScore.holdoutCount, r.holdoutCount);
    assert.equal(r.calibrationCount + r.holdoutCount, r.rows.length);
    assert.equal(r.calibrationCount, expected.calibrationCount);
    assert.ok(Math.abs(r.rmse - expected.rmse) < 1e-8, "Held-out RMSE: " + id);
    for (const [i, row] of r.rows.entries()) {
      const saved = expected.rows[i];
      assert.equal(row.id, saved.id);
      assert.equal(row.observed, saved.observed);
      assert.equal(row.split, saved.split);
      assert.equal(row.programHash, saved.programHash);
      assert.ok(
        Math.abs(row.predicted - saved.predicted) < 1e-8,
        "Replay prediction: " + row.id,
      );
    }
  }
});

test("each case binds controller and offline analysis to real scene parts and captured sample IDs", async () => {
  for (const [id, r] of Object.entries(report.experiments)) {
    const row = r.rows.find((x) => x.split === "holdout");
    const capture = await replay(r.platform, id, row.id);
    assert.equal(capture.referenceProgram, true);
    assert.equal(capture.observed, row.observed);
    assert.equal(capture.trace.summary.underruns, 0);
    assert.ok(Math.abs(capture.residual - row.residual) < 1e-9);
    const parts = new Set(
        [...capture.system.parts, ...capture.system.links].map((p) => p.id),
      ),
      seen = new Set();
    for (const f of [...capture.trace.frames, ...capture.analysisSteps]) {
      assert.ok(!seen.has(f.id));
      assert.ok(f.parents.every((p) => seen.has(p)));
      assert.ok(
        [f.part, ...f.targets].every((p) => parts.has(p)),
        f.id,
      );
      seen.add(f.id);
    }
    assert.equal(capture.analysisSteps.at(-1).atNs, null);
  }
});

test("edits change predictions and cannot inherit a reference measurement or a passing verdict", async () => {
  const id = report.experiments.superconducting.rows.find(
    (c) => c.split === "holdout",
  ).id;
  const original = await replay("superconducting", "superconducting", id);
  const altered = await replay("superconducting", "superconducting", id, {
    ...original.trace.program,
    gainPermille: 0,
  });
  assert.equal(altered.referenceProgram, false);
  assert.notEqual(altered.predicted, original.predicted);
  assert.equal(altered.observed, null);
  assert.equal(altered.residual, null);
  assert.ok(!altered.analysisSteps.some((f) => f.op === "Compare measurement"));
  const checked = await runPython(
    ["validation/run.py", "--verify-case"],
    JSON.stringify(altered),
  );
  assert.equal(JSON.parse(checked).verified, true);
  altered.analysisSteps[0].state.maximumUv = 42;
  await assert.rejects(
    runPython(["validation/run.py", "--verify-case"], JSON.stringify(altered)),
    /drive-observable/,
  );
  const failed = await replay("superconducting", "superconducting", id, {
    ...original.trace.program,
    code: [{ jump: { target: 0 } }],
  });
  assert.equal(failed.predicted, null);
  assert.ok(failed.diagnostic);
  await assert.rejects(
    replay("neutral", "superconducting", id),
    /Wrong platform/,
  );
});

test("native design fixtures are reproducible and each H2 phase selects its verified Studio program", async () => {
  await runPython(["validation/neutral/test_zac.py"]);
  await runPython(["validation/test_witness.py"]);
  const base = await readFile(
    new URL("../validation/qccd/h2-theta1.tsir.json", import.meta.url),
    "utf8",
  );
  const design = JSON.parse(
    await readFile(
      new URL("../validation/qccd/h2-design.json", import.meta.url),
    ),
  );
  const scan = report.experiments["qccd-h2"].rows;
  assert.equal(scan.length, 32);
  for (const row of scan) {
    const phase = design.phases[row.phaseIndex];
    let native = base;
    for (const [before, after] of phase.replacements)
      native = native.replaceAll(before, after);
    assert.equal(
      createHash("sha256").update(native, "utf8").digest("hex"),
      phase.programSha256,
    );
    assert.equal(phase.qasmSha256, row.qasmSha256);
  }
});

test("the native controller preserves exact picoseconds and phase-triggered bank timing", async () => {
  const n = report.experiments.neutral.rows[0];
  const a = await replay("neutral", "neutral", n.id);
  const dac = a.trace.frames.filter((f) => f.op === "convert");
  assert.equal(a.trace.program.clockSubNsPs, 600);
  assert.equal(dac[1].atPs - dac[0].atPs, 1600);
  assert.equal(dac[1].atNs, dac[1].atPs / 1000);
  const p = report.experiments["qccd-pair"].rows.find(
    (r) => r.executedDwellNs % 400 !== 0,
  );
  const b = await replay("qccd", "qccd-pair", p.id);
  const s = b.trace.frames.filter((f) => f.op === "convert");
  assert.equal(s.length, 56);
  assert.equal(s[28].atNs - s[27].atNs, 400 + p.executedDwellNs);
  assert.equal(s[29].atNs - s[28].atNs, 400);
  const looping = await simulate(
    JSON.stringify({
      ...b.trace.program,
      code: [{ jump: { target: 0 } }],
      maxCycles: 4096,
    }),
  );
  assert.equal(looping.summary.stop, "event limit");
});
