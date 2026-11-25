// What a reproduction's run hands the RISC-Q studio (riscq/ftqvm/studio-runs.mjs). A runner that
// builds and executes a program on a twin calls `captured` with its pieces right after the Lean run;
// outside `captureRuns` the call does nothing, so the reproduction pages run exactly as before.
//
// A piece: { platform, spec (riscq/soc.mjs socSpec), period (ps per batch), built (compile.mjs assemble),
//   result (the Lean run), design? (a riscq/design.mjs document), listing? ({ ops: [{ text, line? }] }),
//   segments: [{ ops: [{ id, op, qubits, t (ps), dur (ps), source }], span (ps)?, classical? }] }
// where every op id is the `source` the trace's frames name.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

/**
 * Run `fn` and collect every piece its runners capture. Returns { value, pieces }. `design`: a hardware
 * design (riscq/design.mjs) edited in /riscq-design, which a transmon runner uses in place of the chip it
 * would build (`designOverride`), so the paper's own program runs on the edited chip.
 */
export async function captureRuns(fn, { design } = {}) {
  const pieces = [];
  const value = await store.run({ pieces, design }, fn);
  return { value, pieces };
}

/** Called by a runner after its Lean run. */
export function captured(piece) {
  store.getStore()?.pieces.push(piece);
}

/** The edited chip a studio run was given, if any. */
export const designOverride = () => store.getStore()?.design;

/** A native op in the studio's shape, from the fields the runners use. */
export const nativeOp = (n, extra = {}) => ({
  id: n.id, op: n.op ?? n.kind ?? n.channel ?? "pulse", qubits: n.qubits ?? n.sites ?? [],
  t: n.t ?? Math.round((n.at ?? 0) * 1000), dur: n.t !== undefined ? n.dur ?? 0 : Math.round((n.dur ?? 0) * 1000),
  source: n.source ?? n.text ?? n.op ?? n.channel, ...extra,
});
