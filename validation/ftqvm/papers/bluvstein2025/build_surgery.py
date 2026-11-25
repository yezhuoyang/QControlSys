"""Write the reconstructed lattice-surgery circuits (Bluvstein et al., arXiv:2506.20661, Fig. 3):
two d=5 surface codes side by side, both prepared in |+_L>, two rounds of stabilizer measurement on
the merged 5x10 lattice (code checks + seam checks), then transversal readout.

  circuit-surgery.stim        final Z-basis readout; OBSERVABLE 0 = (Z_L1 Z_L2 from data) XOR
                              (product of the three round-1 seam Z checks)  -> deterministic 0.
                              As in the paper ("the seam checks from the final data qubit measurement
                              are not included"), the 3 final-data seam detectors are omitted; with
                              them the observable would be a product of detectors (verify.py, sec. 7).
  circuit-surgery-xx.stim     final X-basis readout; OBSERVABLE 0 = X_L1 X_L2 (row 2, all 10 columns)
  circuit-surgery-noisy.stim  circuit-surgery.stim + the paper's Pauli error model (anc/Error_model.docx),
                              placed exactly as in the authors' published QEC circuit
  circuit-surgery-xx-noisy.stim

Run: python -I build_surgery.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_surface as G  # noqa: E402

R, C, ROUNDS = 5, 10, 2
ORDERS = G.PAPER_ORDERS[:ROUNDS]   # assumption: first two rounds of the N Z Z_r N_r pattern

HEADER = """# Reconstructed lattice surgery Z_L1 Z_L2 between two d=5 rotated surface codes
# Bluvstein et al., "Architectural mechanisms of a universal fault-tolerant quantum computer",
# arXiv:2506.20661 (Nature 649, 39-46 (2025)), Fig. 3 / Methods "MLE decoder - lattice surgery".
# NOT published by the authors. Built by gen_surface.py, whose template reproduces the authors'
# published d=5 QEC Stim circuit instruction-for-instruction (see verify.txt).
# Lattice: data (r,c), r=0..4, c=0..9; code 1 = columns 0-4, code 2 = columns 5-9 (mirror image of code 1).
# QUBIT_COORDS(x=c, y=r); ancillas at plaquette centres (half-integers). Seam checks: x = 4.5.
# DETECTOR(x, y, round). Rounds use CZ orders {orders}; data prepared with R + SQRT_Y_DAG on (r+c) even.
# {basis_line}
"""


def seam(P, typ=None):
    return [(ra, ca) for (ra, ca, t) in P.anc if ca == 4.5 and (typ is None or t == typ)]


def build(meas, noise):
    P = G.Patch(R, C)
    if meas == 'Z':
        obs = [[(r, c) for r in range(R) for c in (4, 5)]]
        seam_obs = (0, seam(P, 'Z'))
    else:
        obs = [[(2, c) for c in range(C)]]
        seam_obs = None
    circ = G.build(P, ROUNDS, prep='X', meas=meas, orders=ORDERS, noise=noise, coords=True,
                   observables=obs, surgery_seam_obs=seam_obs,
                   skip_final_detectors=seam(P, 'Z') if meas == 'Z' else ())
    return P, circ


def main():
    out = {}
    for meas, name in (('Z', 'circuit-surgery'), ('X', 'circuit-surgery-xx')):
        for noise in (False, True):
            P, circ = build(meas, noise)
            basis_line = ('Final data readout in Z (SQRT_Y_DAG on (r+c) odd, then M). OBSERVABLE 0 = parity of data columns 4,5 '
                          'XOR round-1 seam Z checks at (x=4.5, y=-0.5, 1.5, 3.5).\n# Final-data detectors of these 3 seam checks are omitted, '
                          'as in the paper\'s decoding (Methods: "the seam checks from the final data qubit measurement are not included").' if meas == 'Z' else
                          'Final data readout in X (SQRT_Y_DAG on (r+c) even, then M). OBSERVABLE 0 = X_L1 X_L2 = parity of data row 2.')
            if noise:
                basis_line += ' NOISY: Pauli part of anc/Error_model.docx (no loss).'
            text = HEADER.format(orders=','.join(ORDERS), basis_line=basis_line) + str(circ) + '\n'
            fn = name + ('-noisy' if noise else '') + '.stim'
            with open(os.path.join(HERE, fn), 'w', newline='\n') as f:
                f.write(text)
            out[fn] = circ
    return out


if __name__ == '__main__':
    for fn, c in main().items():
        print(fn, 'qubits', c.num_qubits, 'detectors', c.num_detectors, 'observables', c.num_observables,
              'measurements', c.num_measurements, 'ticks', c.num_ticks)
