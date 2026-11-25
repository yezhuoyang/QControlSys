"""Verify the Stim circuits of Besedin et al. (arXiv:2501.04612).

python -I verify.py > verify.txt
Checks: (a) DEM with decompose_errors under a paper-like noise model,
(b) noiseless determinism of detectors and observables (1000 shots) plus the
logical action on the injected cardinal states, (c) structural counts against
every number the paper states, (d) circuit distance and a pymatching sanity
estimate compared with the paper's reported Bell-state observables.
"""
import json
import math
import os
import sys

import numpy as np
import pymatching
import stim

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G  # noqa: E402

OK = True


def check(cond, msg):
    global OK
    print(("  PASS " if cond else "  FAIL ") + msg)
    OK = OK and bool(cond)


def layers(c):
    """Split a flattened circuit into TICK layers (list of instruction lists)."""
    out, cur = [], []
    for ins in c.flattened():
        if ins.name == "TICK":
            out.append(cur)
            cur = []
        else:
            cur.append(ins)
    out.append(cur)
    return out


# ------------------------------------------------------------------ noise model
# Paper (App. Simulation): depolarizing channels after 1q/2q gates from RB/IRB,
# readout as an X flip before a perfect measurement, idle Pauli channel
# p_i = 1 - exp(-t/T_i) with T_X = T_Y = 4 T1 and T_Z = T_phi.
# Device-average values (main text / Methods); per-qubit values are not published.
P1 = 0.0009        # "(0.09 +- 0.05)%" average single-qubit gate error
P2 = 0.022         # "(2.2 +- 1.7)%" average two-qubit gate error
PM = 1 - 0.985     # "two-state readout assignment fidelity is 98.5%"
T1 = 51e-6         # midpoint of "T1 between 24 and 78 us"
T2E = 50e-6        # representative of "T2E ranging from 12.4 to 138.9 us" (not stated per qubit)
TPHI = 1 / (1 / T2E - 1 / (2 * T1))

# Layer durations [s]. Stated: 48 ns single-qubit pulse, 101.5 ns CZ + 2 x 20 ns
# buffers, readout 175-300 ns, 1.66 us between same-type cycles.  The split of the
# 1.66 us budget across pipelined layers is DERIVED (see meta.json, derived_schedule).
T_1Q = 48e-9
T_CZ = 101.5e-9 + 40e-9
T_GATES = 3 * T_1Q + 4 * T_CZ                 # one stabilizer-type block, 710 ns
T_PIPE = (1.66e-6 - 2 * T_GATES) / 2          # readout tail per half cycle, 120 ns


def layer_duration(idx, lay, kinds):
    k = kinds[idx]
    return {"1q": T_1Q, "cz": T_CZ, "pipe": T_1Q + T_PIPE, "split": T_PIPE,
            "zro": 1.66e-6 - T_GATES, "final": 300e-9, "pre": 300e-9, "init": 0.0,
            "prep": T_1Q}[k]


def classify(c):
    lays = layers(c)
    nlay = len(lays)
    kinds = []
    for i, lay in enumerate(lays):
        names = {ins.name for ins in lay} - {"DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS", "SHIFT_COORDS"}
        meas = names & {"M", "MX", "MY"}
        if i == 0:
            kinds.append("init")
        elif i == 1:
            kinds.append("pre")
        elif i == 2:
            kinds.append("prep")
        elif "CZ" in names:
            kinds.append("cz")
        elif meas and (names - {"M", "MX", "MY"}):
            kinds.append("pipe")
        elif meas and i == nlay - 1:
            kinds.append("final")
        elif meas:
            nm = sum(len(ins.targets_copy()) for ins in lay if ins.name in ("M", "MX", "MY"))
            kinds.append("split" if nm == 7 else "zro")
        else:
            kinds.append("1q")
    return lays, kinds


def noisy(c, scale=1.0):
    lays, kinds = classify(c)
    out = stim.Circuit()
    nq = c.num_qubits
    for i, lay in enumerate(lays):
        if i:
            out.append("TICK")
        busy = set()
        for ins in lay:
            n = ins.name
            qs = [t.value for t in ins.targets_copy() if t.is_qubit_target]
            if n in ("DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS", "SHIFT_COORDS"):
                out.append(ins)
                continue
            busy.update(qs)
            if n in ("M", "MY"):
                out.append("X_ERROR", qs, PM * scale)
            elif n == "MX":
                out.append("Z_ERROR", qs, PM * scale)
            out.append(ins)
            if n == "CZ":
                out.append("DEPOLARIZE2", qs, P2 * scale)
            elif n in ("SQRT_Y", "SQRT_Y_DAG", "Y", "SQRT_X", "SQRT_X_DAG", "H", "X"):
                out.append("DEPOLARIZE1", qs, P1 * scale)
        t = layer_duration(i, lay, kinds)
        idle = [q for q in range(nq) if q not in busy]
        if t > 0 and idle and i >= 2:
            px = (1 - math.exp(-t / (4 * T1))) * scale
            pz = (1 - math.exp(-t / TPHI)) * scale
            out.append("PAULI_CHANNEL_1", idle, [px, px, pz])
    return out


# ------------------------------------------------------------------ helpers
def physical_records(c, shots=200):
    ms = []
    for k in range(shots):
        sim = stim.TableauSimulator(seed=k)
        sim.do(c)
        ms.append(sim.current_measurement_record())
    ms = np.array(ms, dtype=bool)
    conv = c.compile_m2d_converter(skip_reference_sample=True)
    d, o = conv.convert(measurements=ms, separate_observables=True)
    return ms, d, o


def main():
    results = {}
    files = list(G.VARIANTS)

    print("=" * 78)
    print("(a) detector error model with decompose_errors=True (paper-like noise)")
    print("    p1=%.4g p2=%.4g p_meas=%.4g T1=%.0fus T2E=%.0fus Tphi=%.1fus" %
          (P1, P2, PM, T1 * 1e6, T2E * 1e6, TPHI * 1e6))
    for f in files:
        c = stim.Circuit.from_file(os.path.join(HERE, f))
        c.detector_error_model()  # raises on non-deterministic detectors/observables
        dem = noisy(c).detector_error_model(decompose_errors=True)
        check(dem.num_errors > 0, "%-32s DEM ok: %d detectors, %d error mechanisms" %
              (f, dem.num_detectors, dem.num_errors))
        results.setdefault(f, {})["dem_errors"] = dem.num_errors

    print("=" * 78)
    print("(b) noiseless determinism (1000-shot detector sampler; 200 tableau shots for raw values)")
    ideal = {  # ideal values in the paper's frame (Eq. 1 fanout; Fig. 3 text)
        "circuit.stim": ["Z_L1 Z_L2 = +1"],
        "circuit-bell-XX.stim": ["X_L1 X_L2 = +1"],
        "circuit-bell-YY.stim": ["Y_L1 Y_L2 = -1"],
        "circuit-inject-0-ZZ.stim": ["Z_L1 Z_L2 = +1"],
        "circuit-inject-1-ZZ.stim": ["Z_L1 Z_L2 = -1"],
        "circuit-inject-plus-XX.stim": ["X_L1 = +1", "X_L2 = +1"],
        "circuit-inject-minus-XX.stim": ["X_L1 = -1", "X_L2 = -1"],
        "circuit-inject-plusi-YZ.stim": ["Y_L1 Z_L2 = +1"],
        "circuit-inject-minusi-YZ.stim": ["Y_L1 Z_L2 = -1"],
    }
    raw = {}
    for f in files:
        c = stim.Circuit.from_file(os.path.join(HERE, f))
        det, obs = c.compile_detector_sampler(seed=1).sample(1000, separate_observables=True)
        check(not det.any() and not obs.any(),
              "%-32s %d detectors all 0, %d observable(s) deterministic over 1000 shots"
              % (f, c.num_detectors, c.num_observables))
        ms, d, o = physical_records(c)
        const_d = all(len(np.unique(d[:, k])) == 1 for k in range(d.shape[1]))
        const_o = [np.unique(o[:, k]).tolist() for k in range(o.shape[1])]
        check(const_d and all(len(v) == 1 for v in const_o) and not ms[:, :17].any(),
              "%-32s physical records: detector parities constant, preselection all 0, "
              "raw observable parity %s; paper-frame ideal %s"
              % (f, [int(v[0]) for v in const_o], ideal[f]))
        raw[f] = [int(v[0]) for v in const_o]
        results[f]["raw_observable_parity"] = raw[f]
        results[f]["ideal_paper_frame"] = ideal[f]
        results[f]["random_measurements"] = int((ms.std(0) > 0).sum())

    print("  Logical action (fanout alpha|+>+beta|-> -> alpha|++>+beta|-->) up to one constant frame:")
    check(raw["circuit-inject-0-ZZ.stim"][0] != raw["circuit-inject-1-ZZ.stim"][0],
          "Z_L1Z_L2 flips between injected |0> and |1>")
    check(raw["circuit-inject-0-ZZ.stim"] == raw["circuit.stim"],
          "injected |0> and all-|0> preparation give the same Z_L1Z_L2 record")
    check(all(a != b for a, b in zip(raw["circuit-inject-plus-XX.stim"], raw["circuit-inject-minus-XX.stim"])),
          "X_L1 and X_L2 each flip between injected |+> and |->")
    check(raw["circuit-inject-plusi-YZ.stim"][0] != raw["circuit-inject-minusi-YZ.stim"][0],
          "Y_L1Z_L2 flips between injected |+i> and |-i>")
    check((raw["circuit-inject-plus-XX.stim"][0] ^ raw["circuit-inject-plus-XX.stim"][1])
          == raw["circuit-bell-XX.stim"][0], "X_L1X_L2 record identical for |+> input and |0>_L input (= +1 for every input)")
    print("  Constant known frame (Ry(pi) echoes on data: 5 on D1 D3 D4 D6 D7 D9, 3 on D5; no-reset")
    print("  ancilla readout mapping): record parity -> paper value: ZZ %d->+1, XX %d->+1, YY %d->-1, "
          "X_L %d->+1, Y_L1Z_L2 %d->+1" % (raw["circuit.stim"][0], raw["circuit-bell-XX.stim"][0],
                                            raw["circuit-bell-YY.stim"][0], raw["circuit-inject-plus-XX.stim"][0],
                                            raw["circuit-inject-plusi-YZ.stim"][0]))

    print("=" * 78)
    print("(c) structural counts vs. the paper")
    c = stim.Circuit.from_file(os.path.join(HERE, "circuit.stim"))
    lays, kinds = classify(c)
    Z = [G.Q[n] for n in G.ZANC]
    X = [G.Q[n] for n in G.XANC]
    cycles = []
    for i, lay in enumerate(lays):
        for ins in lay:
            if ins.name == "SQRT_Y":
                qs = {t.value for t in ins.targets_copy()}
                if qs == set(X):
                    cycles.append(["X", i, 0, []])
                elif qs == set(Z):
                    cycles.append(["Z", i, 0, []])
    for k, cyc in enumerate(cycles):
        end = cycles[k + 1][1] if k + 1 < len(cycles) else len(lays)
        for i in range(cyc[1], end):
            for ins in lays[i]:
                if ins.name == "CZ":
                    n = len(ins.targets_copy()) // 2
                    cyc[2] += n
                    cyc[3].append(n)
    seq = "".join(cy[0] for cy in cycles)
    print("  cycle sequence:", seq)
    for cy in cycles:
        print("   %s-cycle at layer %3d: %2d CZ (per CZ step %s)" % (cy[0], cy[1], cy[2], cy[3]))
    nCZ = sum(cy[2] for cy in cycles)
    nm = c.num_measurements
    check(c.num_qubits == 17, "17 qubits ('17 flux-tunable transmon qubits')")
    check(seq == "XZXZXZXZZ", "X first, m+1 = 4 X cycles interleaved with m = 3 Z cycles, then n = 2 Z cycles")
    check([cy[2] for cy in cycles if cy[0] == "X"] == [12] * 4, "12 CZ per X cycle (2 weight-4 + 2 weight-2 checks)")
    check([cy[2] for cy in cycles if cy[0] == "Z"] == [12, 12, 12, 8, 8],
          "12 CZ per surface-code Z cycle, 8 per repetition-code Z cycle (CZs with D2 D5 D8 'not executed')")
    check(all(len(cy[3]) == 4 for cy in cycles)
          and all(n == 3 for cy in cycles[:7] for n in cy[3])
          and all(n == 2 for cy in cycles[7:] for n in cy[3]),
          "4 CZ steps per cycle (steps 2,3,5,6 of the 8-step sequence); 3 parallel CZs per step "
          "before the split, 2 after")
    check(nm == 17 + 16 + 20 + 3 + 6,
          "measurements: 17 preselection + 16 X-ancilla + 20 Z-ancilla + 3 mid-circuit (D2 D5 D8) + 6 final = %d" % nm)
    zdet = sum(1 for k, v in c.get_detector_coordinates().items() if v[3] == 0)
    xdet = sum(1 for k, v in c.get_detector_coordinates().items() if v[3] == 1)
    check(zdet == 24, "Z detectors = 24 ('four times six nodes' of the Z matching graph; source data sigma_0..sigma_5)")
    check(xdet == 12, "X detectors = 12 (App. Fig. F1: X1..X4 x cycles N = 1..3)")
    resets = sum(len(ins.targets_copy()) for ins in c.flattened() if ins.name.startswith("R"))
    check(resets == 17, "only the initial ground state; no reset after any readout")
    tot = sum(layer_duration(i, l, kinds) for i, l in enumerate(lays))
    print("  derived duration from first pulse to end of final readout: %.2f us "
          "(4 X + 5 Z cycles on the 1.66 us grid; derived, not stated)" %
          ((tot - 300e-9) * 1e6))
    results["counts"] = dict(qubits=c.num_qubits, cycles=seq, cz_total=nCZ, measurements=nm,
                             detectors_z=zdet, detectors_x=xdet,
                             cz_per_cycle=[[cy[0], cy[2]] for cy in cycles],
                             ticks=c.num_ticks, derived_duration_us=round((tot - 300e-9) * 1e6, 3))
    print("  totals: %d CZ, %d measurements, %d TICK layers" % (nCZ, nm, c.num_ticks))

    print("=" * 78)
    print("(d) fault distance and pymatching sanity estimate")
    for f in ("circuit.stim", "circuit-bell-XX.stim", "circuit-bell-YY.stim"):
        cn = noisy(stim.Circuit.from_file(os.path.join(HERE, f)))
        errs = cn.search_for_undetectable_logical_errors(
            dont_explore_detection_event_sets_with_size_above=4,
            dont_explore_edges_with_degree_above=4,
            dont_explore_edges_increasing_symptom_degree=False,
            canonicalize_circuit_errors=True)
        gl = len(cn.detector_error_model(decompose_errors=True).shortest_graphlike_error())
        print("  %-24s min undetectable logical fault weight = %d (graphlike %d)" % (f, len(errs), gl))
        results[f]["circuit_distance"] = len(errs)
    check(results["circuit.stim"]["circuit_distance"] == 3,
          "Z_L1Z_L2 distance 3 ('smallest undetectable fault weight causing a logical error is three')")
    check(results["circuit-bell-XX.stim"]["circuit_distance"] == 1,
          "X_L1X_L2 unprotected after the split (no X stabilizers measured), distance 1")

    cn = noisy(stim.Circuit.from_file(os.path.join(HERE, "circuit.stim")))
    dem = cn.detector_error_model(decompose_errors=True)
    coords = dem.get_detector_coordinates()
    code1 = {(1, 0), (1, 2)}   # Z1, Z2 chip coordinates -> repetition code L1
    code2 = {(3, 2), (3, 4)}   # Z3, Z4 -> repetition code L2
    cross = {"split round": 0, "later": 0}
    split_l2 = []
    for inst in dem.flattened():
        if inst.type != "error":
            continue
        comp = []
        for t in inst.targets_copy() + [stim.DemTarget.separator()]:
            if t.is_separator():
                ds = [coords[k] for k in comp if True]
                post = [c for c in ds if c[3] == 0 and c[2] >= 7]
                if len(post) == 2:
                    a, b_ = ((int(c[0]), int(c[1])) for c in post)
                    if (a in code1 and b_ in code2) or (a in code2 and b_ in code1):
                        cross["split round" if max(c[2] for c in post) == 7 else "later"] += 1
                comp = []
            elif t.is_relative_detector_id():
                comp.append(t.val)
    print("  Z-graph edges joining repetition code 1 (Z1,Z2) and code 2 (Z3,Z4): "
          "split round %d, later rounds %d" % (cross["split round"], cross["later"]))
    check(cross["later"] == 0,
          "no edges between the two repetition codes after the split round (paper: no correlations "
          "between sigma^Z1,Z2 and sigma^Z3,Z4; source data has infinite weights there)")
    results["cross_code_edges"] = cross

    paper = {"circuit.stim": dict(raw=0.189, dec=0.730, post=0.998, keep=0.055, sim_raw=0.2426, sim_dec=0.6258, sim_post=1.0),
             "circuit-bell-XX.stim": dict(raw=0.255, dec=None, post=0.56, keep=0.063, sim_raw=0.3218, sim_dec=None, sim_post=0.5744),
             "circuit-bell-YY.stim": dict(raw=-0.082, dec=-0.199, post=-0.55, keep=0.063, sim_raw=-0.1256, sim_dec=-0.2282, sim_post=-0.6156)}
    SHOTS = 200_000
    print("  %d shots, noise as in (a); paper values are leakage-rejected experiment (sim = paper's own stim model)" % SHOTS)
    for f, sign in (("circuit.stim", +1), ("circuit-bell-XX.stim", +1), ("circuit-bell-YY.stim", -1)):
        cn = noisy(stim.Circuit.from_file(os.path.join(HERE, f)))
        dem = cn.detector_error_model(decompose_errors=True)
        m = pymatching.Matching.from_detector_error_model(dem)
        det, obs = cn.compile_detector_sampler(seed=7).sample(SHOTS, separate_observables=True)
        o = obs[:, 0]
        pred = m.decode_batch(det)[:, 0]
        raw_v = sign * (1 - 2 * o.mean())
        dec_v = sign * (1 - 2 * (o ^ pred).mean())
        clean = ~det.any(axis=1)
        post_v = sign * (1 - 2 * o[clean].mean()) if clean.any() else float("nan")
        p = paper[f]
        print("  %-22s raw %+.3f (paper %+.3f, paper-sim %+.3f) | decoded %+.3f (paper %s, paper-sim %s) | "
              "postselected %+.3f keep %.1f%% (paper %+.3f keep %.1f%%)" %
              (f, raw_v, p["raw"], p["sim_raw"], dec_v,
               "%+.3f" % p["dec"] if p["dec"] is not None else "n/a",
               "%+.3f" % p["sim_dec"] if p["sim_dec"] is not None else "n/a",
               post_v, 100 * clean.mean(), p["post"], 100 * p["keep"]))
        results[f]["estimate"] = dict(shots=SHOTS, raw=round(raw_v, 4), decoded=round(dec_v, 4),
                                      postselected=round(post_v, 4), kept_fraction=round(float(clean.mean()), 4))
    fz = results["circuit.stim"]["estimate"]
    fx = results["circuit-bell-XX.stim"]["estimate"]
    fy = results["circuit-bell-YY.stim"]["estimate"]
    F_raw = (1 + fx["raw"] - fy["raw"] + fz["raw"]) / 4
    F_dec = (1 + fx["raw"] - fy["decoded"] + fz["decoded"]) / 4
    print("  Bell fidelity (1+<XX>-<YY>+<ZZ>)/4: raw %.3f (paper 0.382), decoded %.3f (paper 0.546)" % (F_raw, F_dec))
    results["bell_fidelity_estimate"] = dict(raw=round(F_raw, 4), decoded=round(F_dec, 4))

    with open(os.path.join(HERE, "verify-results.json"), "w") as fh:
        json.dump(results, fh, indent=1)
    print("=" * 78)
    print("ALL CHECKS PASSED" if OK else "SOME CHECKS FAILED")
    sys.exit(0 if OK else 1)


if __name__ == "__main__":
    main()
