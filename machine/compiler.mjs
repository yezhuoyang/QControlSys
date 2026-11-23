import { parseQasm } from "./qasm.mjs";
import { validateDevice } from "./device.mjs";
import { lowerDelivery } from "./delivery.mjs";
import {wireExecution} from "./wiring.mjs";

function fail(where, message) {
  throw Error(where + " — " + message);
}
function record(value, allowed, where) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(where, "expected an object.");
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(where, "unexpected field " + key + ".");
}
function list(value, where) {
  if (!Array.isArray(value)) fail(where, "expected a list.");
  return value;
}
function integer(value, low, high, where) {
  if (!Number.isSafeInteger(value) || value < low || value > high)
    fail(where, "expected an integer between " + low + " and " + high + ".");
  return value;
}
function name(value, where) {
  if (typeof value !== "string" || !value.length || value.length > 100)
    fail(where, "expected a nonempty name of at most 100 characters.");
  return value;
}
function bindingKey(role, call, targets, params, where) {
  name(role, where);
  name(call, where);
  for (const target of list(targets, where)) name(target, where);
  if (!list(params, where).every(Number.isFinite))
    fail(where, "invalid gate parameters.");
  return JSON.stringify([role, call, targets, params]);
}

function specialize(value, parameters, where) {
  if (Array.isArray(value))
    return value.map((v) => specialize(v, parameters, where));
  if (!value || typeof value !== "object") return value;
  if (!Object.hasOwn(value, "parameter"))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        specialize(v, parameters, where),
      ]),
    );
  record(value, ["parameter", "scale", "offset", "round"], where);
  const index = integer(value.parameter, 0, parameters.length - 1, where);
  const scale = value.scale ?? 1,
    offset = value.offset ?? 0;
  if (
    !Number.isFinite(scale) ||
    !Number.isFinite(offset) ||
    (value.round !== undefined && typeof value.round !== "boolean")
  )
    fail(where, "invalid affine parameter expression.");
  const result = parameters[index] * scale + offset;
  if (!Number.isFinite(result)) fail(where, "parameter expression overflow.");
  return value.round
    ? Math.sign(result) * Math.round(Math.abs(result))
    : result;
}

/** Lower a portable source program to independently executable FPGA images and RAM words. */
export function compile(design, source) {
  record(
    design,
    ["kind", "version", "parts", "wires", "roles", "calibrations", "maxEvents", "device"],
    "machine",
  );
  if (design.kind !== "machine-design" || design.version !== 1)
    fail("machine", "unknown design version.");
  const { parts, wires:declaredWires } = structuredClone(design);
  list(parts, "parts");
  validateDevice(design.device, parts);
  list(declaredWires, "wires");
  const byId = new Map(parts.map((p) => [p.id, p]));
  const wires=declaredWires.map(w=>{
    if(!w.interconnect)return w;
    if(w.interconnect.strobeLink){
      const strobe=declaredWires.find(l=>l.id===w.interconnect.strobeLink);
      if(strobe?.interconnect?.encoding!=="logic-level" || strobe.src.part!==w.src.part ||
        strobe.dst.part!==w.dst.part || strobe.dst.port!=="strobe")
        fail(w.id,"missing physical strobe between the declared components");
    }
    const {delayPs,servicePs,wordPinMap}=wireExecution(w,byId);
    return {id:w.id,src:w.src,dst:w.dst,delayPs,...(servicePs?{servicePs}:{}),...(wordPinMap?{wordPinMap}:{})};
  });
  const cpus = parts.filter((p) => p.model?.fpga);
  const roles = new Map(Object.entries(design.roles ?? {}));
  for (const [role, cpu] of roles) {
    name(role, "role");
    if (!byId.get(cpu)?.model?.fpga)
      fail(role, "role requires an FPGA instance.");
  }
  const recipes = new Map(),
    families = new Map();
  for (const recipe of list(design.calibrations, "calibrations")) {
    record(
      recipe,
      ["role", "call", "targets", "params", "paramRanges", "body"],
      "calibration",
    );
    const key = bindingKey(
      recipe.role,
      recipe.call,
      recipe.targets,
      recipe.params ?? [],
      "calibration",
    );
    if (!roles.has(recipe.role)) fail(key, "unknown calibration role.");
    list(recipe.body, key);
    if (recipe.paramRanges !== undefined) {
      const ranges = list(recipe.paramRanges, key);
      if (
        recipe.params !== undefined ||
        !ranges.length ||
        ranges.some(
          (r) =>
            !Array.isArray(r) ||
            r.length !== 2 ||
            !r.every(Number.isFinite) ||
            r[0] > r[1],
        )
      )
        fail(key, "invalid calibration parameter bounds.");
      const bucket = families.get(key) ?? [];
      if (
        bucket.some(
          (other) =>
            other.paramRanges.length === ranges.length &&
            ranges.every(
              ([a, b], i) =>
                a <= other.paramRanges[i][1] && other.paramRanges[i][0] <= b,
            ),
        )
      )
        fail(key, "overlapping parameter calibrations.");
      bucket.push(recipe);
      families.set(key, bucket);
    } else {
      if (recipes.has(key)) fail(key, "duplicate calibration.");
      recipes.set(key, recipe);
    }
  }
  if (typeof source === "string") source = parseQasm(source);
  record(source, ["language", "version", "tracks"], "source");
  if (source.language !== "control-ir" || source.version !== 1)
    fail("source", "unknown language or version.");
  const images = new Map(),
    sourceMap = [],
    banks = new Map();
  const tracks = list(source.tracks, "tracks");
  let expansions = 0;
  for (const [trackNo, track] of tracks.entries()) {
    record(track, ["role", "body"], "track");
    const role = track.role,
      controller = roles.get(role);
    if (!controller) fail("track " + trackNo, "unbound role " + role + ".");
    if (images.has(controller))
      fail(role, "two concurrent tracks would own " + controller + ".");
    const code = [],
      slots = new Map();
    images.set(controller, { controller, code });
    function slot(bit, where) {
      name(bit, where);
      if (!slots.has(bit)) slots.set(bit, integer(slots.size, 0, 255, where));
      return slots.get(bit);
    }
    function emit(op, sourceId) {
      if (code.length >= 16384) fail(sourceId, "instruction memory exhausted.");
      code.push({ source: sourceId, op });
      return code.length - 1;
    }
    function block(body, path, stack = []) {
      if (path.length > 1400 || stack.length > 48)
        fail(path, "program nesting exceeds the compiler limit.");
      for (const [index, node] of list(body, path).entries()) {
        const id = path + "/" + index;
        if (++expansions > 50000)
          fail(id, "program expansion budget exceeded.");
        const step = (op) => emit(op, id);
        if (!node || typeof node !== "object")
          fail(id, "expected an operation.");
        const keys = Object.keys(node).filter((k) => k !== "origin");
        if (keys.length !== 1) fail(id, "supply one operation per step.");
        const type = keys[0],
          arg = node[type];
        if (node.origin !== undefined) name(node.origin, id);
        sourceMap.push({
          id,
          controller,
          operation: type,
          ...(node.origin ? { origin: node.origin } : {}),
        });
        switch (type) {
          case "call": {
            record(arg, ["name", "targets", "params"], id);
            const key = bindingKey(
              role,
              arg.name,
              arg.targets,
              arg.params ?? [],
              id,
            );
            const params = arg.params ?? [];
            const familyKey = bindingKey(role, arg.name, arg.targets, [], id);
            const recipe =
              recipes.get(key) ??
              families
                .get(familyKey)
                ?.find(
                  (r) =>
                    r.paramRanges.length === params.length &&
                    r.paramRanges.every(
                      ([lo, hi], i) => lo <= params[i] && params[i] <= hi,
                    ),
                );
            if (!recipe) fail(id, "missing calibration for " + key + ".");
            if (stack.includes(recipe))
              fail(id, "recursive calibration " + arg.name + ".");
            sourceMap.at(-1).binding = key;
            block(
              params.length ? specialize(recipe.body, params, id) : recipe.body,
              id + "/" + arg.name,
              [...stack, recipe],
            );
            break;
          }
          case "stream": {
            record(arg, ["ram", "words", "periodTicks"], id);
            const ram = byId.get(arg.ram)?.model?.ram;
            if (
              !ram ||
              !wires.some(
                (w) =>
                  w.src.part === controller &&
                  w.src.port === "address" &&
                  w.dst.part === arg.ram &&
                  w.dst.port === "address",
              )
            )
              fail(
                id,
                "RAM " +
                  arg.ram +
                  " needs an address connection from " +
                  controller +
                  ".",
              );
            const words = list(arg.words, id);
            if (!words.length) fail(id, "a stream needs waveform samples.");
            for (const word of words) integer(word, -32768, 32767, id);
            const period = integer(arg.periodTicks, 1, 1000000000, id);
            const key = JSON.stringify([arg.ram, words]);
            if (!banks.has(key)) {
              const base = ram.words.length;
              if (base + words.length > 65536)
                fail(id, "waveform exceeds the RAM address space.");
              banks.set(key, base);
              for (const word of words) ram.words.push(word);
            }
            for (let i = 0; i < words.length; i++) {
              step({ write: { port: "address", value: banks.get(key) + i } });
              if (period > 1) step({ wait: { ticks: period - 2 } });
            }
            break;
          }
          case "at": {
            record(arg, ["ps", "body"], id);
            const time = integer(arg.ps, 0, Number.MAX_SAFE_INTEGER, id);
            const first = code.length;
            block(arg.body, id + "/scheduled", stack);
            if (code.length === first)
              fail(id, "scheduled operation has no instructions.");
            if (code[first].atPs !== undefined && code[first].atPs !== time)
              fail(id, "nested issue times disagree.");
            code[first].atPs = time;
            break;
          }
          case "repeat": {
            record(arg, ["count", "body"], id);
            const count = integer(arg.count, 0, 4096, id);
            list(arg.body, id);
            for (let i = 0; i < count; i++)
              block(arg.body, id + "/iteration" + i, stack);
            break;
          }
          case "ifBit": {
            record(arg, ["bit", "then", "else"], id);
            step({ loadBit: { slot: slot(arg.bit, id) } });
            const branch = step({ jz: { target: 0 } });
            block(arg.then, id + "/then", stack);
            if (arg.else?.length) {
              const jump = step({ jump: { target: 0 } });
              code[branch].op.jz.target = code.length;
              block(arg.else, id + "/else", stack);
              code[jump].op.jump.target = code.length;
            } else {
              if (arg.else !== undefined) list(arg.else, id);
              code[branch].op.jz.target = code.length;
            }
            break;
          }
          case "whileBit": {
            record(arg, ["bit", "body"], id);
            const head = step({ loadBit: { slot: slot(arg.bit, id) } });
            const branch = step({ jz: { target: 0 } });
            block(arg.body, id + "/body", stack);
            step({ jump: { target: head } });
            code[branch].op.jz.target = code.length;
            break;
          }
          case "capture":
            step({ read: { port: "sense" } });
            step({ saveBit: { slot: slot(arg, id) } });
            break;
          case "wait":
            step({ wait: { ticks: integer(arg, 0, 1000000000, id) } });
            break;
          case "write":
            record(arg, ["port", "value"], id);
            step({
              write: {
                port: name(arg.port, id),
                value: integer(arg.value, -32768, 65535, id),
              },
            });
            break;
          case "writeBus":
            record(arg, ["address","word"], id);
            step({writeBus:{address:integer(arg.address,0,65535,id),word:integer(arg.word,-32768,32767,id)}});
            break;
          case "spiWrite24": {
            record(arg, ["command", "data"], id);
            const command = integer(arg.command, 0, 255, id);
            const data = integer(arg.data, 0, 65535, id);
            const frame = command * 65536 + data;
            const pin = (port, value, origin) => ({ origin, write: { port, value } });
            const pins = [pin("csN", 0, "SPI select")];
            for (let i = 23; i >= 0; i--)
              pins.push(pin("sclk", 1, "Clock high for bit " + i),
                pin("sdi", (frame >>> i) & 1, "Present bit " + i),
                pin("sclk", 0, "Sample bit " + i));
            pins.push(pin("csN", 1, "SPI commit"));
            block(pins, id + "/spi", stack);
            break;
          }
          case "read":
            step({ read: { port: name(arg, id) } });
            break;
          case "writeAcc":
            step({ writeAcc: { port: name(arg, id) } });
            break;
          case "add":
            step({ add: { value: integer(arg, -32768, 32767, id) } });
            break;
          default:
            fail(id, "unsupported operation " + type + ".");
        }
      }
    }
    block(track.body, "track" + trackNo);
    emit("halt", "track" + trackNo + "/end");
  }
  for (const p of cpus)
    if (!images.has(p.id))
      images.set(p.id, {
        controller: p.id,
        code: [{ source: "idle/" + p.id, op: "halt" }],
      });
  const delivery=lowerDelivery(design.device,parts,wires);
  const program = {
    kind: "component-machine",
    version: 1,
    parts,
    wires,
    images: [...images.values()],
    maxEvents: integer(design.maxEvents, 1, 20000, "maxEvents"),
  };
  return { program, sourceMap, ...(delivery?{delivery}:{}) };
}
