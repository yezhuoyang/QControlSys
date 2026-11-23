// A deliberately explicit OpenQASM 3 front end. Every accepted statement either declares
// an operand or emits control IR; unsupported syntax always reports its source location.
const ident = "[A-Za-z_][A-Za-z_0-9]*";
const ref = new RegExp("^(" + ident + ")(?:\\s*\\[\\s*(\\d+)\\s*\\])?$");
const gate = new RegExp("^(" + ident + ")(?:\\s*\\((.*)\\))?\\s+(.+)$", "s");
const standard = new Map([
  ...["id", "x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx"].map((g) => [
    g,
    [1, 0],
  ]),
  ...["rx", "ry", "rz", "p"].map((g) => [g, [1, 1]]),
  ...["cx", "cy", "cz", "ch", "swap"].map((g) => [g, [2, 0]]),
  ["ccx", [3, 0]],
  ["U", [1, 3]],
]);

// Constant arithmetic only. A token budget bounds nested and unary expressions.
function angle(source, error) {
  const tokens =
    source.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_]\w*|[^\s]/g,
    ) ?? [];
  if (tokens.length > 128) error("angle expression exceeds token budget.");
  let i = 0;
  function atom() {
    const token = tokens[i++];
    if (token === "-") return -atom();
    if (token === "+") return atom();
    if (token === "(") {
      const result = expr(0);
      if (tokens[i++] !== ")") error("unbalanced angle expression.");
      return result;
    }
    if (token === "pi" || token === "π") return Math.PI;
    if (token === "tau" || token === "τ") return 2 * Math.PI;
    if (token === "euler") return Math.E;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token ?? ""))
      error("unsupported constant angle expression.");
    return Number(token);
  }
  function expr(min) {
    let left = atom();
    while (i < tokens.length) {
      const op = tokens[i],
        precedence = ["+", "-"].includes(op)
          ? 1
          : ["*", "/"].includes(op)
            ? 2
            : 0;
      if (!precedence || precedence < min) break;
      i++;
      const right = expr(precedence + 1);
      left =
        op === "+"
          ? left + right
          : op === "-"
            ? left - right
            : op === "*"
              ? left * right
              : left / right;
    }
    return left;
  }
  const value = expr(0);
  if (i !== tokens.length || !Number.isFinite(value))
    error("invalid constant angle expression.");
  return value;
}

function* statements(text) {
  let begin = 0,
    inGate = false,
    line = 1;
  for (const token of text.matchAll(/[;{}]/g)) {
    const end = token.index,
      mark = token[0];
    if (mark === "{") {
      if (inGate || !/^\s*gate\s/.test(text.slice(begin, end)))
        throw Error("Unsupported OpenQASM block at line " + line);
      inGate = true;
    } else if (mark === ";" && inGate) continue;
    else {
      if (mark === "}" && !inGate)
        throw Error("Unexpected closing brace at line " + line);
      const raw = text.slice(begin, end + (mark === "}" ? 1 : 0));
      const prefix = raw.match(/^\s*/)[0];
      yield {
        value: raw.trim(),
        line: line + (prefix.match(/\n/g) ?? []).length,
      };
      line += (raw.match(/\n/g) ?? []).length;
      begin = end + 1;
      inGate = false;
    }
  }
  if (inGate || text.slice(begin).trim())
    throw Error(
      "Expected a complete semicolon-terminated OpenQASM statement or gate definition.",
    );
}

export function parseQasm(text) {
  if (typeof text !== "string" || text.length > 262144)
    throw Error("Invalid OpenQASM input size.");
  const source = text.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  const qubits = new Map(),
    bits = new Map(),
    assigned = new Set(),
    body = [];
  const definitions = new Map();
  let count = 0,
    included = false,
    expanded = 0;
  for (const { value: statement, line } of statements(source)) {
    const loc = "OpenQASM line " + line;
    const error = (msg) => {
      throw Error(loc + " — " + msg);
    };
    if (count++ === 0) {
      if (!/^OPENQASM\s+3(?:\.0)?$/.test(statement))
        error("expected OPENQASM 3.0;");
      continue;
    }
    if (/^include\s+"stdgates\.inc"$/.test(statement)) {
      included = true;
      continue;
    }
    const decl =
      /^(qubit|bit)(?:\s*\[\s*(\d+)\s*\])?\s+([A-Za-z_][A-Za-z_0-9]*)$/.exec(
        statement,
      );
    if (decl) {
      const [, type, size, id] = decl;
      if (qubits.has(id) || bits.has(id)) error("duplicate declaration " + id);
      if (size !== undefined && !(Number(size) >= 1 && Number(size) <= 65536))
        error("register width outside supported range.");
      (type === "qubit" ? qubits : bits).set(
        id,
        size === undefined ? null : Number(size),
      );
      continue;
    }
    function operand(value, table) {
      if (table === qubits && /^\$\d+$/.test(value.trim()))
        return "$" + BigInt(value.trim().slice(1)).toString();
      const m = ref.exec(value.trim());
      if (!m || !table.has(m[1]))
        error("undeclared or unsupported operand " + value);
      const width = table.get(m[1]),
        idx = m[2] === undefined ? null : Number(m[2]);
      if (width === null && idx === null) return m[1];
      if (idx === null || width === null || idx >= width)
        error("use a single in-range indexed operand for " + value);
      return m[1] + "[" + idx + "]";
    }
    function lowerGate(value, local) {
      const m = gate.exec(value);
      const definition = m && definitions.get(m[1]);
      if (
        !m ||
        (!definition && (!standard.has(m[1]) || (m[1] !== "U" && !included)))
      )
        error("unsupported gate or statement " + value);
      const [, name, angles, operands] = m;
      const params =
        angles === undefined
          ? []
          : angles.split(",").map((x) => angle(x, error));
      const targets = operands.split(",").map((x) => {
        if (!local) return operand(x, qubits);
        if (!local.includes(x.trim())) error("unknown formal qubit " + x);
        return x.trim();
      });
      const [arity, nAngles] = definition
        ? [definition.args.length, 0]
        : standard.get(name);
      if (
        params.length !== nAngles ||
        targets.length !== arity ||
        new Set(targets).size !== arity
      )
        error("incorrect operands for " + name);
      const size = definition ? definition.body.length : 1;
      if ((expanded += size) > 50000)
        error("gate expansion exceeds compiler budget.");
      if (!definition)
        return [{ call: { name, targets, params }, origin: loc }];
      return definition.body.map(({ call }) => ({
        call: {
          ...call,
          targets: call.targets.map((q) => targets[definition.args.indexOf(q)]),
        },
        origin: loc + " · " + name,
      }));
    }
    if (/^gate\s/.test(statement)) {
      const m =
        /^gate\s+([A-Za-z_][A-Za-z_0-9]*)\s+([^{}]+?)\s*\{([^{}]*)\}$/s.exec(
          statement,
        );
      if (!m || standard.has(m[1]) || definitions.has(m[1]))
        error("invalid or duplicate gate definition.");
      const args = m[2].split(",").map((x) => x.trim());
      if (
        args.some((x) => !new RegExp("^" + ident + "$").test(x)) ||
        new Set(args).size !== args.length
      )
        error("expected distinct formal qubits.");
      const inner = m[3].trim();
      if (inner && !inner.endsWith(";"))
        error("missing semicolon in gate body.");
      const commands = inner
        ? inner
            .slice(0, -1)
            .split(";")
            .flatMap((s) => lowerGate(s.trim(), args))
        : [];
      definitions.set(m[1], { args, body: commands });
      continue;
    }
    const measure = /^(.+?)\s*=\s*measure\s+(.+)$/s.exec(statement);
    if (measure) {
      const bit = operand(measure[1], bits),
        target = operand(measure[2], qubits);
      body.push(
        { call: { name: "measure", targets: [target] }, origin: loc },
        { capture: bit, origin: loc },
      );
      assigned.add(bit);
      continue;
    }
    const conditional = /^if\s*\(([^()]+)\)\s*(.+)$/s.exec(statement);
    if (conditional) {
      const bit = operand(conditional[1], bits);
      if (!assigned.has(bit))
        error("classical bit has no preceding measurement: " + bit);
      body.push({
        ifBit: { bit, then: lowerGate(conditional[2]) },
        origin: loc,
      });
    } else body.push(...lowerGate(statement));
  }
  if (!count) throw Error("Expected OPENQASM 3.0;");
  return {
    language: "control-ir",
    version: 1,
    tracks: [{ role: "control", body }],
  };
}
