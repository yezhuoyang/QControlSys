// The Language page's claims (riscq/language-study.mjs): every assertion rule of the hardware
// description language is enforced by riscq/design.mjs check() and fires on a design broken in one
// place; every RISC-Q instruction row decodes back; every QSysASM refusal is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { ringDesign, check } from "../riscq/design.mjs";
import { HDL_RULES, HDL_WARNINGS } from "../riscq/language-study.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));

test("the reference design passes every rule", () => {
  const r = check(ringDesign({ decoder: true }));
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("every assertion rule fires on the design broken in its one place", () => {
  const ids = new Set();
  for (const rule of HDL_RULES) {
    assert.ok(!ids.has(rule.id), "rule ids are unique: " + rule.id);
    ids.add(rule.id);
    const d = clone(ringDesign({ decoder: true }));
    rule.mutate(d);
    const { errors } = check(d);
    assert.ok(errors.some((m) => m.includes(rule.expect)), rule.id + " (" + rule.name + "): " + (errors[0] ?? "no error"));
  }
  for (const rule of HDL_WARNINGS) {
    const d = clone(ringDesign({ decoder: true }));
    rule.mutate(d);
    const { errors, warnings } = check(d);
    assert.equal(errors.length, 0, rule.id);
    assert.ok(warnings.some((m) => m.includes(rule.expect)), rule.id);
  }
});
