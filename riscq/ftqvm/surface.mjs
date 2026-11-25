// The rotated surface code of distance d on a lattice, in the compiler's orientation.
//
// Data qubit j sits at row ⌊j/d⌋, column j mod d. An interior plaquette at (r + ½, c + ½) checks
// the four qubits around it and is an X check when r + c is even. A weight-2 check on the top or
// bottom edge is an X check beside a Z plaquette; one on the left or right edge is a Z check
// beside an X plaquette. For d = 3 this is exactly the compiler's `Surface [[9,1,3]]` declaration:
// X[1]X[2], X[0]X[1]X[3]X[4], X[4]X[5]X[7]X[8], X[6]X[7], Z[0]Z[3], Z[1]Z[2]Z[4]Z[5],
// Z[3]Z[4]Z[6]Z[7], Z[5]Z[8] (tests/ftqvm-surface.test.mjs checks the correspondence).

/** Checks of the distance-d code: [{ type: "X" | "Z", data: [j], rc: [row, col] }], d² − 1 of them. */
export function checks(d) {
  const at = (r, c) => r * d + c;
  const out = [];
  const plaquette = (r, c) => ((r + c) % 2 === 0 ? "X" : "Z");
  for (let r = 0; r < d - 1; r++)
    for (let c = 0; c < d - 1; c++)
      out.push({ type: plaquette(r, c), data: [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)], rc: [r + 0.5, c + 0.5] });
  for (let c = 0; c < d - 1; c++) {
    if (plaquette(0, c) === "Z") out.push({ type: "X", data: [at(0, c), at(0, c + 1)], rc: [-0.5, c + 0.5] });
    if (plaquette(d - 2, c) === "Z") out.push({ type: "X", data: [at(d - 1, c), at(d - 1, c + 1)], rc: [d - 0.5, c + 0.5] });
  }
  for (let r = 0; r < d - 1; r++) {
    if (plaquette(r, 0) === "X") out.push({ type: "Z", data: [at(r, 0), at(r + 1, 0)], rc: [r + 0.5, -0.5] });
    if (plaquette(r, d - 2) === "X") out.push({ type: "Z", data: [at(r, d - 1), at(r + 1, d - 1)], rc: [r + 0.5, d - 0.5] });
  }
  return out;
}

/**
 * The order in which a check meets its data qubits, so that no qubit is in two checks of one
 * layer: X checks go N-shaped (NW, NE, SW, SE), Z checks Z-shaped (NW, SW, NE, SE) (Tomita and
 * Svore, PRA 90, 062320 (2014)). Returns, per check, its data qubits by layer 0..3 (undefined
 * where a weight-2 check has no qubit in that corner).
 */
export function layers(d) {
  return checks(d).map((ch) => {
    const [r, c] = ch.rc;
    const corner = (dr, dc) => {
      const rr = r + dr, cc = c + dc;
      return rr >= 0 && rr < d && cc >= 0 && cc < d ? rr * d + cc : undefined;
    };
    const nw = corner(-0.5, -0.5), ne = corner(-0.5, 0.5), sw = corner(0.5, -0.5), se = corner(0.5, 0.5);
    return { ...ch, order: ch.type === "X" ? [nw, ne, sw, se] : [nw, sw, ne, se] };
  });
}
