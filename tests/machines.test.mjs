import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runMachine, simulate } from "../server.mjs";
import { compile } from "../machine/compiler.mjs";
import { parseQasm } from "../machine/qasm.mjs";
import { examples } from "../machine/examples.mjs";
import {defineInterconnect} from "../machine/interconnect.mjs";

const copy = (e) => structuredClone(e);
const nodes = (run, id) => run.trace.frames.filter((f) => f.part === id);
const ir = (...tracks) => ({ language: "control-ir", version: 1, tracks });
const word = (value) => ({ write: { port: "tx", value } });
const part = (id, model) => ({
  id,
  label: id,
  model,
  centerMm: [0, 0, 0],
  sizeMm: [2, 2, 2],
});
const link = (id, a, out, b, input, delayPs) => ({
  id,
  src: { part: a, port: out },
  dst: { part: b, port: input },
  delayPs,
});
const design = (parts, wires, roles) => ({
  kind: "machine-design",
  version: 1,
  parts,
  wires,
  roles,
  calibrations: [],
  maxEvents: 100,
});
function checkTrace(run) {
  const drawnParts = new Set(run.design.parts.map((p) => p.id));
  const drawnWires = new Set(run.design.wires.map((w) => w.id));
  for (const stage of run.delivery?.stages ?? []) {
    assert.ok(run.apparatus.parts.some((p) => p.id === stage.hardware));
    assert.ok(run.apparatus.links.some((l) => l.id === stage.link));
    if (stage.target)
      assert.ok(run.design.device.qubits.some((q) => q.id === stage.target));
    drawnParts.add(stage.id);
    drawnWires.add(stage.wire);
  }
  for (const [i, f] of run.trace.frames.entries()) {
    assert.equal(f.id, i);
    assert.ok(f.parents.every((p) => Number.isInteger(p) && p >= 0 && p < i));
    assert.ok(!i || run.trace.frames[i - 1].atPs <= f.atPs);
    assert.ok(drawnParts.has(f.part));
    assert.ok(!f.wire || drawnWires.has(f.wire));
  }
}

test("a serial transmitter queues overlapping words and its receiver reconstructs their exact arrival times",async()=>{
  const original={...link("link","tx","out","rx","in",200),interconnect:defineInterconnect("link","differential",{
    fromPort:"out",toPort:"in",lengthMm:100,speedMmPerNs:200,bitRateGbps:1,frameOverheadBits:2})};
  const sample={design:design([part("tx",{stimulus:{signal:"word",samples:[{atPs:0,value:11},{atPs:1000,value:-9}]}}),
    part("rx",{probe:{signal:"word"}})],[original],{}),source:ir()};
  const run=await runMachine(sample);
  const hits=nodes(run,"rx");
  assert.deepEqual(hits.map(f=>[f.transport.startPs,f.transport.releasePs,f.atPs,f.received[1]]),
    [[0,18000,18700,11],[18000,36000,36700,-9]]);
  assert.ok(hits[1].parents.includes(hits[1].transport.priorEvent));
  const different=copy(sample);different.design.wires[0].interconnect.bitRateGbps=2;
  assert.deepEqual(nodes(await runMachine(different),"rx").map(f=>f.atPs),[9700,18700]);
  const invalid=copy(sample);invalid.design.wires[0].interconnect.toPort="unwired";
  await assert.rejects(runMachine(invalid),/endpoints differ/);
});

test("moving two physical wires to different pins changes the received sample and clock skew delays latching",async()=>{
  const w=link("data","sender","out","sink","in",100);
  w.interconnect=defineInterconnect(w.id,"parallel",{fromPort:"out",toPort:"in",lengthMm:50,speedMmPerNs:200,beatNs:2});
  const doc={design:design([part("sender",{stimulus:{signal:"word",samples:[{atPs:10,value:1},{atPs:5010,value:-2}]}}),
    part("sink",{probe:{signal:"word"}})],[w],{}),source:ir()};
  const pristine=nodes(await runMachine(doc),"sink");
  assert.deepEqual(pristine.map(f=>f.received[1]),[1,-2]);
  const [a,b]=["D0","D7"].map(id=>w.interconnect.conductors.find(c=>c.id===id));
  [a.destinationBitIndex,b.destinationBitIndex]=[7,0];
  [a.toPin,b.toPin]=[b.toPin,a.toPin]; b.skewPs=80;
  const crossed=nodes(await runMachine(doc),"sink");
  assert.deepEqual(crossed.map(f=>[f.transmittedValue,f.received[1]]),[[1,128],[-2,-129]]);
  assert.deepEqual(crossed.map((f,i)=>f.atPs-pristine[i].atPs),[80,80]);
  doc.design.parts[0].model.stimulus = {signal:"bit",samples:[{atPs:10,value:1}]};
  doc.design.parts[1].model.probe.signal = "bit";
  const [flag] = nodes(await runMachine(doc),"sink");
  assert.deepEqual([flag.transmittedValue,flag.received[1]],[1,0]);
});

test("scheduled FPGA instructions wait for exact edges and expose conflicts and grid errors", async () => {
  const e = copy(examples[0]);
  e.source = ir({
    role: "control",
    body: [
      { at: { ps: 16000, body: [{ write: { port: "flag", value: 1 } }] } },
    ],
  });
  const right = await runMachine(e);
  const issue = nodes(right, "sequencer").find((f) => f.op === "write flag");
  assert.equal(issue.atPs, 16000);
  assert.equal(
    right.trace.frames[issue.parents[0]].op,
    "await scheduled issue",
  );
  e.source.tracks[0].body.unshift({ wait: 4 });
  const missed = await runMachine(e);
  assert.equal(missed.trace.stop, "fault");
  assert.match(
    missed.trace.frames.at(-1).detail,
    /missed issue at 16000 ps.*20000 ps/,
  );
  e.source.tracks[0].body[1].at.ps++;
  await assert.rejects(runMachine(e, true), /clock grid/);
});

test("Qiskit-style angles specialize signed waveform RAM with declared bounds and rounding", async () => {
  const e = copy(examples[0]);
  e.source =
    'OPENQASM 3.0; include "stdgates.inc"; qubit[2] q; rx(-(pi/2)) q[0]; x q[1];';
  const r = await runMachine(e);
  assert.equal(r.trace.stop, "completed");
  const words = r.trace.program.parts.find((p) => p.id === "memory").model.ram
    .words;
  assert.deepEqual(
    words.slice(1, 8),
    [0, -1200, -4600, -9000, -4600, -1200, 0],
  );
  assert.equal(
    Math.min(...nodes(r, "driveA").map((f) => f.state.value)),
    -274658,
  );
  e.source = e.source.replace("-(pi/2)", "2*pi");
  await assert.rejects(runMachine(e), /missing calibration/);
  e.design.calibrations.push(
    copy(e.design.calibrations.find((c) => c.call === "rx")),
  );
  await assert.rejects(runMachine(e), /overlapping parameter/);
});

test("a two-qubit call reaches the joint actuator on each modality through the native board", async () => {
  for (const example of examples.slice(0, 3)) {
    const e = copy(example);
    e.source =
      'OPENQASM 3.0; include "stdgates.inc"; qubit[2] q; rx(pi/2) q[0]; cz q[0], q[1];';
    const r = await runMachine(e);
    assert.equal(r.trace.stop, "completed");
    assert.equal(nodes(r, "pair-drive").length, 16);
    assert.ok(nodes(r, "pair-drive").some((f) => f.state.value > 0));
    assert.ok(nodes(r, "pair-drive").every((f) => f.source.includes("/cz/")));
    assert.ok(nodes(r, "driveA").at(-1).atPs < nodes(r, "pair-drive")[0].atPs);
  }
});

test("a passive wiring design translates a timestamped frequency capture to position at two probes", async () => {
  const d = design(
    [
      part("recording", {
        stimulus: {
          signal: "frequencyHz",
          samples: [
            { atPs: 1200, value: 80000000 },
            { atPs: 1700, value: 80000500 },
          ],
        },
      }),
      part("calibration", {
        affine: {
          input: "frequencyHz",
          output: "positionNm",
          numerator: 1,
          denominator: 2,
          offset: -40000000,
        },
      }),
      part("near", { probe: { signal: "positionNm" } }),
      part("far", { probe: { signal: "positionNm" } }),
    ],
    [
      link("rf", "recording", "out", "calibration", "in", 50),
      link("short", "calibration", "out", "near", "in", 200),
      link("long", "calibration", "out", "far", "in", 750),
    ],
    {},
  );
  const run = await runMachine({ design: d, source: ir() });
  assert.deepEqual(run.trace.program.images, []);
  assert.equal(run.trace.stop, "completed");
  assert.deepEqual(
    nodes(run, "near").map((f) => [f.atPs, f.state.value]),
    [
      [1450, 0],
      [1950, 250],
    ],
  );
  assert.deepEqual(
    nodes(run, "far").map((f) => [f.atPs, f.state.value]),
    [
      [2000, 0],
      [2500, 250],
    ],
  );
  assert.equal(
    (await simulate(JSON.stringify(run.trace), { checkTrace: true })).verified,
    true,
  );
  checkTrace(run);
  d.parts[0].model.stimulus.samples.reverse();
  await assert.rejects(runMachine({ design: d, source: ir() }), /increasing/);
});

test("one hierarchical source targets three machine descriptions and produces physical drive samples", async () => {
  for (const e of examples.slice(0, 3)) {
    const run = await runMachine(e);
    assert.equal(run.trace.stop, "completed");
    assert.equal(run.source, examples[0].source);
    const peak = e.design.calibrations[0].body[1].stream.words.reduce(
      (a, b) => Math.max(a, b),
      0,
    );
    const uv = Math.trunc((Math.floor(peak / 4) * 1e6) / 8192);
    for (const id of ["driveA", "driveB"])
      assert.equal(Math.max(...nodes(run, id).map((f) => f.state.value)), uv);
    const a = nodes(run, "driveA").filter((f) => f.state.value > 0),
      b = nodes(run, "driveB").filter((f) => f.state.value > 0);
    assert.ok(a.at(-1).atPs < b[0].atPs);
    assert.equal(
      run.trace.program.parts.find((p) => p.id === "memory").model.ram.words
        .length,
      e.design.calibrations[0].body[1].stream.words.length + 1,
    );
    assert.equal(
      e.design.parts.find((p) => p.id === "memory").model.ram.words.length,
      1,
    );
    assert.ok(run.sourceMap.some((s) => s.origin?.includes("flip_pair")));
    checkTrace(run);
    assert.equal(
      (await simulate(JSON.stringify(run.trace), { checkTrace: true }))
        .verified,
      true,
    );
  }
});

test("electrical feedback reads the arriving detector bit and emits only the taken source branch", async () => {
  for (const [level, want] of [
    [200000, 1],
    [800000, 0],
  ]) {
    const e = copy(examples[3]);
    e.design.parts.find((p) => p.id === "rfMonitor").model.threshold.levelUv =
      level;
    const run = await runMachine(e);
    const branch = nodes(run, "sequencer").find(
      (f) => f.op === "branch if zero",
    );
    assert.equal(branch.state.acc, want);
    assert.equal(
      nodes(run, "sequencer").filter((f) => f.op === "write flag").length,
      want,
    );
    const read = nodes(run, "sequencer").find((f) => f.op === "read sense");
    assert.ok(
      read.parents.some(
        (id) => run.trace.frames[id].wire === "detector-return",
      ),
    );
    assert.equal(run.trace.stop, "completed");
    checkTrace(run);
  }
});

test("two independently clocked FPGA images arbitrate through a custom shared physical bus", async () => {
  const d = design(
    [
      part("west", { fpga: { clockPs: 3000 } }),
      part("east", { fpga: { clockPs: 7000 } }),
      part("arbiter", { bus: { widthBits: 8, beatPs: 500 } }),
      part("terminal", { probe: { signal: "word" } }),
    ],
    [
      link("left", "west", "tx", "arbiter", "a", 100),
      link("right", "east", "tx", "arbiter", "b", 100),
      link("out", "arbiter", "out", "terminal", "in", 50),
    ],
    { one: "west", two: "east" },
  );
  const source = ir(
    { role: "one", body: [word(17)] },
    { role: "two", body: [word(-31)] },
  );
  const run = await runMachine({ design: d, source });
  assert.deepEqual(
    nodes(run, "terminal").map((f) => [f.atPs, f.state.value]),
    [
      [1150, 17],
      [2150, -31],
    ],
  );
  d.parts[2].model.bus.widthBits = 16;
  const wider = await runMachine({ design: d, source });
  assert.deepEqual(
    nodes(wider, "terminal").map((f) => f.atPs),
    [650, 1150],
  );
  assert.deepEqual(await runMachine({ design: d, source }), wider);
  checkTrace(run);
});

test("arrival on the sampling edge is visible, later feedback remains pending, and steps re-execute", async () => {
  const e = {
    design: design(
      [
        part("driver", { fpga: { clockPs: 1000 } }),
        part("reader", { fpga: { clockPs: 1000 } }),
      ],
      [link("bit", "driver", "flag", "reader", "sense", 1000)],
      { emit: "driver", read: "reader" },
    ),
    source: ir(
      { role: "emit", body: [{ write: { port: "flag", value: 1 } }] },
      {
        role: "read",
        body: [
          { wait: 0 },
          { capture: "m" },
          { whileBit: { bit: "m", body: [] } },
        ],
      },
    ),
  };
  const a = await runMachine(e);
  assert.equal(a.trace.stop, "event limit");
  const incoming = nodes(a, "reader").find((f) => f.wire === "bit");
  const read = nodes(a, "reader").find((f) => f.op === "read sense");
  assert.equal(incoming.atPs, read.atPs);
  assert.ok(read.parents.includes(incoming.id));
  e.design.wires[0].delayPs++;
  const late = await runMachine(e);
  assert.equal(late.trace.stop, "completed");
  assert.deepEqual(nodes(late, "reader").at(-1).state.bits, [[0, false]]);
  checkTrace(a);
});

test("composing the native waveform board preserves all controller events and analog samples", async () => {
  const e = copy(examples[4]),
    reference = e.design.parts[1].model.waveformBoard.profile;
  const baseline = await simulate(JSON.stringify(reference));
  const run = await runMachine(e);
  assert.equal(run.trace.stop, "completed");
  const board = nodes(run, "awg").filter((f) => f.native);
  assert.deepEqual(
    board.map((f) => f.native),
    baseline.frames,
  );
  assert.deepEqual(
    nodes(run, "scope").map((f) => [f.atPs, f.state.value]),
    baseline.frames
      .filter((f) => f.op === "convert")
      .map((f) => [f.atNs * 1000 + 4000, f.state.outputUv]),
  );
  for (const f of board) {
    const byId = new Map(board.map((v) => [v.native.id, v.id]));
    for (const parent of f.native.parents)
      assert.ok(f.parents.includes(byId.get(parent)));
  }
  e.source.tracks[0].body.push(copy(e.source.tracks[0].body[0]));
  const collided = await runMachine(e);
  assert.equal(collided.trace.stop, "fault");
  assert.match(collided.trace.frames.at(-1).detail, /busy/);
  checkTrace(run);
});

test("wiring, roles, resource limits and unsupported source statements fail explicitly", async () => {
  // Exercise the original logical-netlist checks without a separate physical pin declaration.
  const base = copy(examples[0]);
  for(const w of base.design.wires)delete w.interconnect;
  for (const [edit, re] of [
    [
      (e) => {
        e.design.wires[0].dst.port = "in";
      },
      /RAM memory needs an address connection/,
    ],
    [
      (e) => {
        e.design.wires[1].dst = e.design.wires[0].dst;
      },
      /incompatible|one driver/,
    ],
    [
      (e) => {
        e.design.wires.push({ ...e.design.wires[0], id: "again" });
      },
      /one driver/,
    ],
    [
      (e) => {
        e.design.wires[0].delayPs = 0;
      },
      /positive delay/,
    ],
    [
      (e) => {
        e.design.parts[0].sizeMm[1] = 0;
      },
      /dimensions/,
    ],
    [
      (e) => {
        e.design.calibrations = e.design.calibrations.filter(
          (c) => c.call !== "x" || c.targets[0] !== "q[1]",
        );
      },
      /missing calibration/,
    ],
    [
      (e) => {
        e.source += "\nreset q[0];";
      },
      /unsupported gate or statement/,
    ],
    [
      (e) => {
        e.source += "\nx q[3];";
      },
      /in-range/,
    ],
    [
      (e) => {
        e.source += "\nrx(unknown) q[0];";
      },
      /unsupported constant angle/,
    ],
    [
      (e) => {
        e.source += "\nqubit xyz";
      },
      /semicolon/,
    ],
    [
      (e) => {
        e.source = ir(
          { role: "control", body: [] },
          { role: "control", body: [] },
        );
      },
      /concurrent/,
    ],
  ]) {
    const e = copy(base);
    edit(e);
    await assert.rejects(runMachine(e), re);
  }
  assert.throws(
    () => parseQasm("OPENQASM 3; qubit a; gate bad q { bad q; }"),
    /unsupported/,
  );
  assert.throws(
    () =>
      parseQasm(
        'OPENQASM 3; include "stdgates.inc"; bit m; qubit a; if (m) x a;',
      ),
    /no preceding/,
  );
  const bad = copy(base);
  bad.source = ir({
    role: "control",
    body: [{ write: { port: "address", value: 100 } }],
  });
  const fault = await runMachine(bad);
  assert.equal(fault.trace.stop, "fault");
  assert.match(fault.trace.frames.at(-1).detail, /RAM address 100/);
  assert.equal(fault.trace.frames.at(-1).wire, "addr");
});

test("nested source calls, zero-based ordered operands and sample memory survive exported-file replay", async () => {
  const e = copy(examples[0]);
  const one = e.design.calibrations[0];
  e.design.calibrations.push({
    role: "control",
    call: "pair",
    targets: ["q[1]", "q[0]"],
    body: [{ call: { name: "x", targets: one.targets } }],
  });
  e.source = ir({
    role: "control",
    body: [
      {
        repeat: {
          count: 2,
          body: [{ call: { name: "pair", targets: ["q[1]", "q[0]"] } }],
        },
      },
    ],
  });
  const compiled = await runMachine(e, true);
  assert.ok(
    compiled.program.images[0].code.some((i) =>
      i.source.includes("iteration1"),
    ),
  );
  assert.deepEqual(compiled, compile(e.design, e.source));
  const run = await runMachine(e);
  const verify = (doc) =>
    spawnSync(process.execPath, ["machine/cli.mjs", "--verify"], {
      input: JSON.stringify(doc),
      encoding: "utf8",
    });
  assert.equal(verify(run).status, 0);
  run.sourceMap[0].operation = "edited";
  assert.equal(verify(run).status, 1);
  run.trace.frames[0].atPs = 5;
  await assert.rejects(
    simulate(JSON.stringify(run.trace), { checkTrace: true }),
    /mismatch at step 1/,
  );
  e.source.tracks[0].body[0].repeat.body[0].call.targets.reverse();
  await assert.rejects(runMachine(e), /missing calibration/);
});
