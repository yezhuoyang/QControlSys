import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
  new URL(
    "../.lake/build/bin/qcontrol" +
      (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
function check(trace) {
  return spawnSync(checker, ["--check-studio-placement"], {
    input: JSON.stringify(trace),
    encoding: "utf8",
  });
}
function swapTrace() {
  return {
    schema: "qcontrol.qccd-studio.v1",
    machine: {
      nodes: [{ id: "A" }, { id: "B" }],
      segments: [{ id: "rail", a: "A", b: "B" }],
    },
    initial: { positions: {} },
    final: { positions: { q0: "B", q1: "A" } },
    sourceInstructions: [
      { id: 9, type: "init", placement: { q0: "A", q1: "B" } },
      { id: 7, type: "simd" },
      { id: 31, type: "gate" },
    ],
    frames: [
      {
        id: "tsir-9-0",
        sourceId: 9,
        sourceIndex: 0,
        substep: 0,
        op: "init",
        parents: [],
        targets: ["A", "B"],
        moves: [],
        positions: { q0: "A", q1: "B" },
      },
      {
        id: "tsir-7-0",
        sourceId: 7,
        sourceIndex: 1,
        substep: 0,
        op: "simd",
        parents: ["tsir-9-0"],
        targets: ["A", "B"],
        moves: [
          { ion: "q0", from: "A", to: "B", via: ["rail"] },
          { ion: "q1", from: "B", to: "A", via: ["rail"] },
        ],
        positions: { q0: "B", q1: "A" },
      },
      {
        id: "tsir-31-0",
        sourceId: 31,
        sourceIndex: 2,
        substep: 0,
        op: "gate",
        parents: ["tsir-7-0"],
        targets: ["A"],
        moves: [],
        positions: {},
      },
    ],
  };
}

test("Lean reconstructs simultaneous rail walks against their common pre-cycle state", () => {
  const p = check(swapTrace());
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), {
    verified: true,
    cycles: 3,
    ions: 2,
  });
});

test("the placement checker detects the first divergent site, rail, source or final placement", () => {
  for (const [mutate, diagnostic] of [
    [(r) => (r.frames[0].positions.q0 = "B"), /tsir-9-0.*placement/],
    [(r) => (r.frames[1].moves[0].from = "B"), /tsir-7-0.*did not start/],
    [(r) => (r.frames[1].moves[0].via = ["missing"]), /tsir-7-0.*unknown rail/],
    [(r) => (r.frames[1].moves[0].via = []), /tsir-7-0.*route ends/],
    [(r) => r.frames[1].targets.push("X"), /tsir-7-0.*addressed site/],
    [(r) => (r.frames[1].parents = []), /tsir-7-0.*order/],
    [(r) => (r.frames[2].positions.q0 = "A"), /tsir-31-0.*placement/],
    [(r) => (r.frames[2].sourceIndex = 1), /tsir-31-0.*source instruction/],
    [(r) => (r.final.positions.q0 = "A"), /Final placement/],
  ]) {
    const r = swapTrace();
    mutate(r);
    const result = check(r);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
  }
});
