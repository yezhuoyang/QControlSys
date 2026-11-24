// node studio/course/labs/run.mjs manila [program.json]
import {readFile} from "node:fs/promises";
import {programs, replay} from "./replay.mjs";
const [name, file] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path,"utf8"));
try {
  const program = file ? await json(file) : programs[name];
  console.log(JSON.stringify({program,...await replay(name,program,json)},null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
