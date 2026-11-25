// A reproduced paper in the RISC-Q studio (/riscq-studio?example=reproduction:<id>:<row>): the row's
// stored twin (validation/ftqvm/twins/<id>/<row>.json, written by riscq/ftqvm/papers.mjs) is placed,
// built and run in the Lean SoC model exactly as the reproduction ran it, and returned as the same
// run bundle the studio's examples are (riscq/examples.mjs `run`): the machine with its cores, the
// FormalRV listing as the source, the native instructions as the hardware program, every core's
// firmware, and the trace. Nothing in it is replayed from a file: the trace is a fresh run.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { geometry } from "../geometry.mjs";
import * as hardwareDesign from "../design.mjs";
import { measuredBits } from "../compile.mjs";

const twinsDir = new URL("../../validation/ftqvm/twins/", import.meta.url);
const PREFIX = "reproduction:";

function rowsOf(id) {
  const dir = new URL(id + "/", twinsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
}

/**
 * The reproductions that run a paper's own circuit (riscq/ftqvm/magic.mjs MAGIC_DESIGNS, logical.mjs
 * LOGICAL_DESIGNS): their design pages' registries, whose first parameter chooses the circuit.
 */
async function registryOf(id) {
  const { MAGIC_DESIGNS } = await import("./magic.mjs");
  if (MAGIC_DESIGNS[id]) return MAGIC_DESIGNS[id];
  const { LOGICAL_DESIGNS } = await import("./logical.mjs");
  return LOGICAL_DESIGNS[id];
}
const PLATFORM = { "Superconducting transmons": "superconducting", "Neutral atoms": "neutral", "Trapped ions": "qccd" };

/** The studio's example list entries: one per stored row or circuit of every reproduction. */
export async function studioExamples() {
  const { REPRODUCTIONS } = await import("./reproductions.mjs");
  const out = [];
  for (const r of REPRODUCTIONS) {
    const rows = rowsOf(r.id);
    for (const row of rows)
      out.push({ id: PREFIX + r.id + ":" + row.key, platform: platformOf(row), title: "Reproduction · " + r.title + " · " + row.label,
        description: r.summary, source: { language: "FormalRV listing" } });
    if (rows.length) continue;
    const registry = await registryOf(r.id);
    const choice = registry && (await registry.params())[0];
    for (const option of choice?.options ?? [])
      out.push({ id: PREFIX + r.id + ":" + choice.key + "=" + option.value, platform: PLATFORM[r.platform] ?? "superconducting",
        title: "Reproduction · " + r.title + " · " + option.label, description: r.summary, source: { language: "Circuit schedule" } });
  }
  return out;
}

/** A circuit reproduction: its design page's run with the paper's values, captured for the studio. */
async function circuitRun(exampleId, paper, choice, value) {
  const { captureRuns } = await import("./studio-capture.mjs");
  const registry = await registryOf(paper.id);
  if (!registry) throw Error("no design registry for " + paper.id);
  const { pieces } = await captureRuns(() => registry.run({ [choice]: value }));
  const piece = pieces.at(-1);
  if (!piece) throw Error(exampleId + ": the run captured nothing for the studio");
  const label = (await registry.params())[0].options?.find((o) => String(o.value) === String(value))?.label ?? value;
  const lines = (piece.listing?.ops ?? []).map((o) => o.text ?? o.kind ?? "");
  return bundle({
    exampleId, paper, label, platform: PLATFORM[paper.platform] ?? "superconducting", spec: piece.spec, period: piece.period,
    hardware: { kind: "hardware-program", version: 1, platform: PLATFORM[paper.platform], machine: paper.id, timeUnit: "ps", segments: piece.segments },
    built: piece.built, result: piece.result, design: piece.design,
    source: { language: "Circuit schedule", text: ["# " + paper.title + " · " + label + ": the paper's circuit as this twin schedules it, one operation per line.", ...lines].join("\n") },
    program: "the paper's circuit as the reproduction schedules it (riscq/ftqvm/" + (paper.id.includes("cultivation") || paper.id.includes("distillation") ? "magic" : "logical") + ".mjs)",
  });
}

export const isReproduction = (id) => typeof id === "string" && id.startsWith(PREFIX);

function platformOf(row) {
  if (row.platform.kind === "transmonTwin") return "superconducting";
  return /h2|ion|qccd/i.test(row.platform.id) ? "qccd" : "neutral";
}

/** The listing as text, each operation on the line FormalRV's sysprog gave it. */
function listingText(listing, title) {
  const lines = ["# " + title + ": the listing FormalRV compiled for this twin. Each operation is on its line of the",
    "# compiled sysprog, which the hardware instructions name; the program's declarations are not stored with the twin."];
  for (const op of listing.ops) lines[op.line - 1] = op.text;
  return Array.from(lines, (l) => l ?? "").join("\n");
}

/** Run one stored row and return a studio run bundle. */
export async function studioRun(exampleId, { trace = "io" } = {}) {
  const [, id, key] = exampleId.split(":");
  const { REPRODUCTIONS } = await import("./reproductions.mjs");
  const paper = REPRODUCTIONS.find((r) => r.id === id);
  if (paper && key?.includes("=")) return circuitRun(exampleId, paper, key.slice(0, key.indexOf("=")), key.slice(key.indexOf("=") + 1));
  const src = rowsOf(id).find((r) => r.key === key);
  if (!paper || !src) throw Error("Unknown reproduction run " + exampleId + ".");
  const platform = platformOf(src);
  let m, hardware, built, result, spec, period, design, report;
  if (src.platform.kind === "transmonTwin") {
    const { willow } = await import("./twins.mjs");
    const { transmonTwin } = await import("./platforms.mjs");
    const { runListing } = await import("./sc-run.mjs");
    if (src.platform.device !== "willow") throw Error("no twin device " + src.platform.device);
    const twin = transmonTwin(willow(), src.platform.options);
    const placement = twin.place(src.listing, { distance: src.distance });
    design = twin.design(src.listing, placement);
    ({ m, hardware, built, result, report } = await runListing(src.listing, placement, design, { distance: src.distance, trace }));
    spec = m.spec;
    period = m.period;
  } else {
    const { optical } = await import("./platforms.mjs");
    const twin = optical(src.platform.id, src.platform.overrides ?? {});
    const placement = twin.place(src.listing, { distance: src.distance });
    const d = twin.design(src.listing, placement);
    ({ report, result, built, spec, hardware } = await twin.run(src.listing, placement, d, { outcomes: {}, distance: src.distance }));
    period = spec.dspPeriodPs;
  }
  return bundle({ exampleId, paper, label: src.label, platform, spec, period, hardware, built, result, design, m,
    source: { language: "FormalRV listing", text: listingText(src.listing, paper.title + " · " + src.label) },
    program: "the listing FormalRV compiled for this twin (validation/ftqvm/twins/" + id + "/" + key + ".json)", conforms: report?.conforms });
}

/** The studio's run bundle (riscq/examples.mjs `run`'s shape). */
function bundle({ exampleId, paper, label, platform, spec, period, hardware, built, result, design, m, source, program, conforms }) {
  return {
    kind: "riscq-run", version: 1,
    example: { id: exampleId, title: "Reproduction · " + paper.title + " · " + label, description: paper.summary },
    platform,
    machine: {
      name: paper.title + " · digital twin", dspPeriodPs: period,
      provenance: { twin: paper.twin, program, run: "a fresh run of the Lean model of the RISC-Q board(s), not a replay: times can differ from the page's stored tables",
        boards: new Set(spec.cores.map((c) => c.board ?? 0)).size + " RISC-Q board(s), AMD ZCU216 (riscq/board.mjs)",
        ...(conforms === undefined ? {} : { conforms: conforms ? "every operation ran inside its FormalRV window" : "not every operation ran inside its window: see the reproduction page" }) },
      cores: spec.cores.map((c) => ({ name: c.name, board: c.board ?? 0, channels: c.channels.map((ch) => ({ name: ch.name, kind: ch.kind, dac: ch.dac, adc: ch.adc })) })),
      ...(m ? { geometry: geometry(platform, m, hardware) } : {}),
      ...(design ? { design, layout: hardwareDesign.layout(design) } : {}),
    },
    source,
    hardware,
    firmware: built.images,
    preroll: (built.plans?.find((plan) => plan.segments.length)?.segments ?? []).map((segment) => segment.preroll),
    derived: { bits: measuredBits(result, built), reproduction: { id: paper.id, label, conforms } },
    ...result,
  };
}
