import {sampleCell, runCell} from "./cell.mjs";
import {manilaProgram, runManila} from "./manila.mjs";
import {transportProgram, runTransport, compareParity} from "./lukin.mjs";
import {linkProgram, runLink} from "./helios.mjs";

export const programs = {cell:sampleCell, manila:manilaProgram, lukin:transportProgram, helios:linkProgram};
export async function replay(name, program, loadJSON) {
  if (name === "cell") return runCell(program);
  if (name === "helios") return runLink(program,await loadJSON(new URL("./helios/netlist.json",import.meta.url)));
  if (name === "lukin") {
    const result=runTransport(program);
    result.referenceComparison=compareParity(await loadJSON(new URL("./atom-parity.json",import.meta.url)));
    return result;
  }
  if (name !== "manila") throw Error("Choose cell, manila, lukin or helios.");
  const [conf,defs,props] = await Promise.all(["conf","defs","props"].map(key =>
    loadJSON(new URL("./manila/" + key + "_manila.json", import.meta.url))));
  return runManila(program,{conf,defs,props});
}
