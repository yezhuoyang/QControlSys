// The hardware document in Node: riscq/hw/doc-core.mjs with the reference devices of machine/examples.mjs
// (whose installations /machines draws) as its templates. A page loads the same core from
// /hw/doc-core.mjs and the same templates from /api/hw/templates.
import { examples as machineExamples } from "../../machine/examples.mjs";
import { setTemplates } from "./doc-core.mjs";

/** The reference device of each kind, as /api/hw/templates serves it. */
export const TEMPLATES = Object.fromEntries(machineExamples.filter((e) => e.design.device).map((e) => [e.design.device.kind, e.design.device]));
setTemplates(TEMPLATES);
export * from "./doc-core.mjs";
