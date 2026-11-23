import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { runMachine } from "../server.mjs";
import { pulseProvenance, boardLayout } from "./provenance.mjs";
import { wireExecution } from "./wiring.mjs";

try {
  const [mode, filename, sourceFile, ...extra] = process.argv.slice(2);
  if (
    !["--run", "--compile", "--verify", "--pulse", "--wiring"].includes(mode) ||
    extra.length ||
    (["--verify", "--wiring"].includes(mode) && sourceFile)
  )
    throw Error(
      "Usage: node machine/cli.mjs --run|--compile|--verify|--wiring [document.json], or --pulse [document.json] [arrival event number]",
    );
  const chunks = [];
  if (!filename) for await (const chunk of process.stdin) chunks.push(chunk);
  let doc = JSON.parse(
    (filename
      ? await readFile(filename, "utf8")
      : Buffer.concat(chunks).toString("utf8")
    ).replace(/^\uFEFF/, ""),
  );
  if (sourceFile && mode !== "--pulse") {
    const text = (await readFile(sourceFile, "utf8")).replace(/^\uFEFF/, "");
    doc = {
      design: doc.design ?? doc,
      source: /\.json$/i.test(sourceFile) ? JSON.parse(text) : text,
      sourceName: sourceFile.split(/[\\/]/).at(-1),
    };
  }
  const geometryVersion =
    mode === "--verify" && doc.apparatus ? (doc.apparatus.version ?? 1) : 2;
  const result = await runMachine(doc, mode === "--compile", geometryVersion);
  function inventory() {
    const design = result.design;
    const parts = new Map(design.parts.map((p) => [p.id, p]));
    const pcb = boardLayout(design);
    return {
      lengthUnit: "mm",
      timeUnit: "ps",
      parts: [
        ...design.parts,
        ...pcb.parts,
        ...(result.apparatus?.parts ?? []),
      ],
      links: [
        ...design.wires.map((w) => ({
          ...w,
          from: w.src.part,
          to: w.dst.part,
          ...wireExecution(w, parts),
        })),
        ...pcb.links,
        ...(result.apparatus?.links ?? []),
      ],
    };
  }
  if (mode === "--verify" && !isDeepStrictEqual(doc, result))
    throw Error(
      "The source mapping, compiled image, or execution trace differs on replay.",
    );
  console.log(
    JSON.stringify(
      mode === "--verify"
        ? {
            verified: true,
            stop: result.trace.stop,
            events: result.trace.frames.length,
          }
        : mode === "--wiring"
          ? inventory()
          : mode === "--pulse"
            ? pulseProvenance(
                result,
                sourceFile === undefined
                  ? result.terminalActivity?.find((s) => s.valueUv !== 0)?.event
                  : Number(sourceFile),
              )
            : result,
    ),
  );
  if (mode === "--run" && result.trace.stop !== "completed")
    process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
