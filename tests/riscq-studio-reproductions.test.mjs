// Reproduced papers open in the RISC-Q studio (/riscq-studio?example=reproduction:<id>:<row>): the
// studio's example list names them, and each is a fresh Lean run returned as the studio's run bundle,
// whose trace frames name the hardware instructions they execute (riscq/ftqvm/studio-runs.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../riscq/examples.mjs";
import { studioExamples } from "../riscq/ftqvm/studio-runs.mjs";

const isBundle = (b) => b.kind === "riscq-run" && Array.isArray(b.frames) && Array.isArray(b.system?.parts) &&
  Array.isArray(b.machine?.cores) && Array.isArray(b.hardware?.segments) && b.summary?.cores && b.initial;

test("every reproduction is in the studio's example list", async () => {
  const ids = (await studioExamples()).map((e) => e.id);
  const { REPRODUCTIONS } = await import("../riscq/ftqvm/reproductions.mjs");
  for (const r of REPRODUCTIONS) assert.ok(ids.some((id) => id.startsWith("reproduction:" + r.id + ":")), r.id);
});

for (const id of ["reproduction:google-2025:d3", "reproduction:bluvstein-2024:d3Z", "reproduction:google-cultivation-2025:circuit=fig2-cultivation", "reproduction:caune-2024:circuit=circuit-stability-r5.stim"])
  test(id + " opens in the studio as a fresh run", { timeout: 300_000 }, async () => {
    const b = await run({ example: id });
    assert.ok(isBundle(b));
    assert.equal(b.example.id, id);
    assert.equal(b.summary.status, "quiescent");
    assert.deepEqual(b.summary.faults, []);
    // The trace's frames name the hardware instructions they play.
    const ops = new Set(b.hardware.segments.flatMap((s) => s.ops.map((o) => o.id)));
    const linked = b.frames.filter((f) => ops.has(f.source)).length;
    assert.ok(linked > b.frames.length / 2, linked + " of " + b.frames.length);
    assert.equal(b.firmware.length, b.machine.cores.length);
  });
