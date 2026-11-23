import { readFile } from "node:fs/promises";
import { simulate } from "../../server.mjs";
import { comparePathCapture } from "../../studio/controller.js";

try {
  const [programPath, capturePath] = process.argv.slice(2);
  if (!programPath || !capturePath)
    throw Error(
      "Supply the waveform program and common-trigger capture JSON files.",
    );
  const [program, capture] = await Promise.all(
    [programPath, capturePath].map((path) => readFile(path, "utf8")),
  );
  const result = comparePathCapture(
    await simulate(program),
    JSON.parse(capture),
  );
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.channels).some((c) => c.mismatched))
    process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
