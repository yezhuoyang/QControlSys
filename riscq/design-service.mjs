// What the hardware design editor (studio/riscq-design.html) asks of the server, as one function
// a script can call too. Every answer comes from riscq/design.mjs, so the editor, the command
// line (riscq/cli.mjs --design) and a headless agent apply the same rules and the same timing.
import * as design from "./design.mjs";
import { examples } from "./examples.mjs";

const program = () => examples.find((e) => e.id === "superconducting-design").source.text;

/**
 * route "/"       GET  { design, qasm }: a design to start from and the program the editor runs on it.
 *                      query.template: "ring" (default), "ring-decoder".
 * route "/rules"  GET  { components, media, toleranceMm }: the allowed part types with what each
 *                      is, and the wire media with their signal speeds in mm/ns.
 * route "/check"  POST design → { errors, warnings, wires, pulses }. `wires` holds every wire's
 *                      routed length in mm and delay in ps. When the design breaks no rule,
 *                      `pulses` holds every calibrated pulse with the part it ends at and its
 *                      wire delay in ps, as the run binds them, and `build` the cores and channels.
 */
export function designService(route, query = {}, body) {
  if (route === "/") return { design: design.ringDesign({ decoder: query.template === "ring-decoder" }), qasm: program() };
  if (route === "/rules") return { components: design.COMPONENTS, media: design.MEDIA, toleranceMm: 0.5 };
  if (route === "/check") {
    const verdict = design.check(body);
    const wires = Array.isArray(body?.wires) ? body.wires.map((wire) => {
      try {
        return { id: wire.id, ...design.wireTiming(wire) };
      } catch {
        return { id: wire.id };
      }
    }) : [];
    if (verdict.errors.length) return { ...verdict, wires, pulses: [] };
    const m = design.machine(body);
    return {
      ...verdict, wires,
      pulses: m.bindings.map((b) => ({ id: b.id, part: b.part, core: m.spec.cores[b.core].name, channel: m.spec.cores[b.core].channels[b.channel].name, delayPs: b.delayPs, kind: b.detail.kind })),
      build: { dspPeriodPs: m.period, cores: m.spec.cores.map((c) => ({ name: c.name, channels: c.channels.map((ch) => ({ name: ch.name, kind: ch.kind, dac: ch.dac, adc: ch.adc })) })) },
    };
  }
  throw Object.assign(Error("Unknown design route " + route + "."), { status: 404 });
}
