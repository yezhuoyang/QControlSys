import { readFileSync } from "node:fs";

const fixture = (path) =>
  JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const h2 = fixture("physical/h2-register.json");
const gate = fixture("physical/h2-gate-register.json");
const trap = fixture("physical/qccd-installation.json").chipModel;
const metal = fixture("validation/superconducting/metal-layout.json");
const zac = fixture("validation/neutral/zac/full_architecture_2aod.json");
const zacProgram = fixture(
  "validation/neutral/zac/bv_n14_transpiled_code.json",
);
const refs = fixture("validation/neutral/design.json");
const drives = [
  { probe: "driveA", targets: ["q[0]"] },
  { probe: "driveB", targets: ["q[1]"] },
  { probe: "pair-drive", targets: ["q[0]", "q[1]"] },
];
const qubit = (i, site, positionMm) => ({
  id: "q[" + i + "]",
  site,
  positionMm,
});

function ionRegister() {
  const [ox, oz] = trap.h2OriginPitch;
  const sites = h2.sites.map(([id, x, z, zone]) => ({
    id,
    x: (x - ox) * trap.h2PitchMm,
    z: (z - oz) * trap.h2PitchMm,
    zone,
  }));
  const byId = new Map(sites.map((s) => [s.id, s]));
  return {
    kind: "ion",
    label: "H2 ion trap",
    centerMm: [0, 220, 0],
    qubits: Object.entries(gate.placement)
      .map(([id, site]) => {
        const { x, z } = byId.get(site);
        const axial =
          id === gate.pair[0] ? -0.0025 : id === gate.pair[1] ? 0.0025 : 0;
        return qubit(Number(id.slice(1)), site, [
          x + axial,
          trap.ionHeightMm,
          z,
        ]);
      })
      .sort((a, b) => Number(a.id.slice(2, -1)) - Number(b.id.slice(2, -1))),
    layout: {
      sites,
      edges: h2.edges,
      spanMm: trap.electrodeSpanMm,
      widthMm: trap.isthmusWidthMm,
    },
    basis:
      "32 ions use the QCCD Studio placement at H2 theta1 step tsir-6-0. Ions q[0] and q[1] share gate well DG01. Their 5 µm axial separation is illustrative. The chip faces down and ions sit 70 µm below its electrodes. Electrode artwork adapted from Moses et al., Fig. 2d (CC BY 4.0). The warm shelf and cable bends are design choices.",
    reference: gate.source,
  };
}

function atomRegister() {
  const slms = zac.storage_zones
    .concat(zac.entanglement_zones)
    .flatMap((z) => z.slms);
  // At the boundary after pickup/transport/deposit job 2 and before gate 3,
  // q0 and q13 are neighbours in the illuminated entangling zone.
  const job = zacProgram.instructions.find((i) => i.id === 2);
  const locations = new Map(
    zacProgram.instructions[0].init_locs.map((loc) => [loc[0], loc]),
  );
  for (const loc of job.end_locs) locations.set(loc[0], loc);
  const qubits = [...locations.values()]
    .map(([i, slm, row, col]) => {
      const s = slms.find((s) => s.id === slm);
      return qubit(i, `SLM ${slm} · row ${row}, column ${col}`, [
        (s.location[0] + col * s.site_seperation[0]) / 1000,
        0,
        (s.location[1] + row * s.site_seperation[1]) / 1000,
      ]);
    })
    .sort((a, b) => a.positionMm[0] - b.positionMm[0]);
  return {
    kind: "atom",
    label: "ZAC tweezer array",
    centerMm: [0, 220, 0],
    qubits,
    layout: {
      slms: slms.map((s) => ({
        id: s.id,
        zone: zac.storage_zones.some((z) =>
          z.slms.some((grid) => grid.id === s.id),
        )
          ? "storage"
          : "entanglement",
        originMm: s.location.map((x) => x / 1000),
        pitchMm: s.site_seperation.map((x) => x / 1000),
        rows: s.r,
        cols: s.c,
      })),
    },
    basis:
      "14 ZAC atoms at the boundary after transport job 2. Logical q[0] and q[1] drive physical atoms q[0] and q[13], separated by 2 µm for ZAC Rydberg instruction 3. Trapping, Raman and Rydberg optics follow the Lukin group’s topology. Shelf positions and optical path lengths are example design choices.",
    reference: refs.source,
  };
}

function transmonRegister() {
  return {
    kind: "transmon",
    label: "Two-transmon chip",
    centerMm: [0, 220, 0],
    qubits: [
      qubit(0, "Left transmon", [-0.65, 0, 0]),
      qubit(1, "Right transmon", [0.65, 0, 0]),
    ],
    layout: {
      chip: metal.chip,
      drivePinMm: metal.pins.find((p) => p.name === "drive").middle,
      metalPolygons: metal.metalPolygons,
      junctions: metal.junctions,
    },
    basis:
      "Two Quantum Metal TransmonPocket layouts share a 9 × 6 mm silicon die on a cold package. Coax enters at the warm flange and passes down the refrigerator stages. The package, 1.30 mm center spacing and external FPGA shelf below the cold assembly are design choices.",
    reference: metal.source,
  };
}

export function referenceDevice(platform) {
  const device = {
    QCCD: ionRegister,
    "Neutral atom": atomRegister,
    Superconducting: transmonRegister,
  }[platform]();
  return {
    ...device,
    mounting: {
      layout: "published-topology-v1",
      faceDown: device.kind === "ion",
    },
    drives:
      device.kind === "atom"
        ? [
            { probe: "driveA", targets: ["q[0]"] },
            { probe: "driveB", targets: ["q[13]"] },
            { probe: "pair-drive", targets: ["q[0]", "q[13]"] },
          ]
        : structuredClone(drives),
    propagation: {
      electricalMmPerNs: 200,
      opticalMmPerNs: 299.792458,
      ...(device.kind === "ion" ? { fiberMmPerNs: 200 } : {}),
      stageDelayPs: {},
    },
  };
}
