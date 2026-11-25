"""Verification for papers/lacroix2025 (Lacroix et al., Nature 645, 614 (2025)).

Run from anywhere:   python -I verify.py   (writes verify.txt next to this file)

Checks
  A. every circuit: 1000 noiseless shots -> all detectors and observables 0
     (Zenodo memory circuits additionally with random sweep-bit initial bitstrings)
  B. structure counts vs statements in the paper (qubits, CZ per cycle, layers,
     measurements, cycle-time estimate from App. B durations)
  C. Zenodo circuit_noisy_si1000.stim == circuit_ideal.stim + SI1000(p=1e-3), shown by
     (i) regenerating the noisy file from the ideal one with an explicit SI1000 rule
     set and comparing instruction-by-instruction, (ii) stripping all noise from the
     noisy file and comparing to the ideal file
  D. detector error models (decompose_errors=False) sizes; Zenodo-supplied DEM vs ours
  E. decoding of simulated SI1000 data with Chromobius (Zenodo circuits + teleport)
  F. reconstructed teleportation circuit: determinism, detector completeness (GF(2)
     rank against the space of all deterministic measurement parities), teleported
     logical values, M_XX record (m1) as the paper defines it, circuit distance
     (stim search_for_undetectable_logical_errors with arguments 3, 3 -- App. C.2)
"""
import glob
import json
import os
import random
import sys
import time

import numpy as np
import stim

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_teleport as bt  # noqa: E402

OUT = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    OUT.append(s)


P = 1e-3
NOISE = {"DEPOLARIZE1", "DEPOLARIZE2", "X_ERROR", "Z_ERROR", "Y_ERROR", "PAULI_CHANNEL_1",
         "PAULI_CHANNEL_2", "E", "ELSE_CORRELATED_ERROR", "HERALDED_ERASE"}
MEAS = {"M", "MX", "MY", "MR", "MRX"}
RESETS = {"R", "RX", "RY"}
ANNOT = {"DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS", "SHIFT_COORDS"}
TWO_Q = {"CZ", "CX", "CY", "CNOT", "ISWAP", "SQRT_XX"}


def layers(circ):
    """Split a flat circuit into TICK-separated layers (lists of instructions)."""
    out, cur = [], []
    for ins in circ.flattened():
        if ins.name == "TICK":
            out.append(cur)
            cur = []
        else:
            cur.append(ins)
    out.append(cur)
    return out


def qubit_targets(ins):
    return [t.value for t in ins.targets_copy() if t.is_qubit_target]


def si1000(ideal, p=P):
    """SI1000 (Gidney et al., Quantum 5, 605 (2021)) as laid out in the paper's Zenodo files.
    Per layer: 2q gate -> DEPOLARIZE2(p); 1q gate / idle -> DEPOLARIZE1(p/10);
    reset -> X_ERROR(2p) (Z_ERROR for RX) plus DEPOLARIZE1(p/10)+(2p) on idlers;
    measurement -> flip 5p, DEPOLARIZE1(p) on measured, idlers p/10 + 2p, except qubits
    carrying an explicit 'I' (dynamical decoupling), which get p/10 only."""
    allq = sorted({q for ins in ideal.flattened() if ins.name == "QUBIT_COORDS"
                   for q in qubit_targets(ins)})
    L = layers(ideal)
    if not L[-1]:
        L = L[:-1]
    out = stim.Circuit()
    for li, lay in enumerate(L):
        if li:
            out.append("TICK")
        meas, resets, twoq, oneq, ident = [], [], [], [], []
        for ins in lay:
            name = ins.name
            tq = qubit_targets(ins)
            if name in MEAS:
                out.append(name, ins.targets_copy(), [5 * p])
                meas += tq
                continue
            out.append(ins)
            if name in ANNOT:
                continue
            if name in RESETS:
                out.append("Z_ERROR" if name == "RX" else ("X_ERROR" if name == "R" else "Y_ERROR"), tq, [2 * p])
                resets += tq
            elif name in TWO_Q:
                if any(t.is_sweep_bit_target for t in ins.targets_copy()):
                    continue  # classically controlled Pauli (initial bitstring): no noise
                out.append("DEPOLARIZE2", tq, [p])
                twoq += tq
            elif name == "I":
                out.append("DEPOLARIZE1", tq, [p / 10])
                ident += tq
            else:
                oneq += tq
        if meas:
            idle = [q for q in allq if q not in meas and q not in ident]
            out.append("DEPOLARIZE1", meas, [p])
            if idle:
                out.append("DEPOLARIZE1", idle, [p / 10])
                out.append("DEPOLARIZE1", idle, [2 * p])
        elif resets:
            idle = [q for q in allq if q not in resets]
            if idle:
                out.append("DEPOLARIZE1", idle, [p / 10])
                out.append("DEPOLARIZE1", idle, [2 * p])
        elif twoq:
            idle = [q for q in allq if q not in twoq]
            if idle:
                out.append("DEPOLARIZE1", idle, [p / 10])
        else:
            idle = [q for q in allq if q not in oneq]
            out.append("DEPOLARIZE1", oneq + idle, [p / 10])
    return out


def strip_noise(c):
    out = stim.Circuit()
    for ins in c.flattened():
        if ins.name in NOISE:
            continue
        if ins.name in MEAS:
            out.append(ins.name, ins.targets_copy())
        else:
            out.append(ins)
    return out


def drop_trailing_tick(c):
    c = c.flattened()
    while len(c) and c[-1].name == "TICK":
        c = c[:-1]
    return c


def noiseless_check(c, shots=1000, sweep_trials=0):
    det, obs = c.compile_detector_sampler().sample(shots, separate_observables=True)
    ok = (not det.any()) and (not obs.any())
    if sweep_trials and c.num_sweep_bits:
        rng = random.Random(1)
        for _ in range(sweep_trials):
            bits = [rng.randint(0, 1) for _ in range(c.num_sweep_bits)]
            c2 = stim.Circuit()
            for ins in c.flattened():
                if ins.name == "CX" and any(t.is_sweep_bit_target for t in ins.targets_copy()):
                    ts = ins.targets_copy()
                    xs = [ts[k + 1].value for k in range(0, len(ts), 2) if bits[ts[k].value]]
                    if xs:
                        c2.append("X", xs)
                else:
                    c2.append(ins)
            d2, o2 = c2.compile_detector_sampler().sample(50, separate_observables=True)
            ok = ok and (not d2.any()) and (not o2.any())
    return ok


def per_cycle_stats(c):
    """Group layers into QEC cycles (a cycle ends with a layer containing measurements)."""
    cycles, cur = [], []
    for lay in layers(c):
        cur.append(lay)
        if any(ins.name in MEAS for ins in lay):
            cycles.append(cur)
            cur = []
    stats = []
    for cyc in cycles:
        s = {"layers": len(cyc), "cz_layers": 0, "cz_gates": 0, "cx_layers": 0, "cx_gates": 0,
             "h_layers": 0, "reset_layers": 0, "empty_layers": 0, "meas": 0}
        for lay in cyc:
            names = {i.name for i in lay if i.name not in ANNOT}
            if not names:
                s["empty_layers"] += 1
            for ins in lay:
                n = len(qubit_targets(ins))
                if ins.name == "CZ":
                    s["cz_gates"] += n // 2
                if ins.name == "CX" and not any(t.is_sweep_bit_target for t in ins.targets_copy()):
                    s["cx_gates"] += n // 2
                if ins.name in MEAS:
                    s["meas"] += n
            if "CZ" in names:
                s["cz_layers"] += 1
            if any(i.name == "CX" and not any(t.is_sweep_bit_target for t in i.targets_copy()) for i in lay):
                s["cx_layers"] += 1
            if "H" in names:
                s["h_layers"] += 1
            if names & RESETS:
                s["reset_layers"] += 1
        stats.append(s)
    return stats


def used_qubits(c):
    used = set()
    for ins in c.flattened():
        if ins.name in ANNOT or ins.name in NOISE or ins.name == "TICK":
            continue
        if ins.name in RESETS and ins.name == "R":
            pass
        used |= set(qubit_targets(ins))
    return used


def roles(c):
    """data = measured only at the end; aux = measured mid-circuit; reset-only qubits."""
    ms = []
    for ins in c.flattened():
        if ins.name in MEAS:
            ms.append(set(qubit_targets(ins)))
    final = ms[-1] if ms else set()
    mid = set().union(*ms[:-1]) if len(ms) > 1 else set()
    data = final - mid
    aux = mid
    gates = set()
    for ins in c.flattened():
        if ins.name in TWO_Q | {"H", "X"} and not any(t.is_sweep_bit_target for t in ins.targets_copy()):
            gates |= set(qubit_targets(ins))
    reset_only = used_qubits(c) - data - aux - gates
    return data, aux, reset_only


def gf2_rank(rows):
    rows = [r for r in rows if r]
    rank = 0
    pivots = {}
    for r in rows:
        while r:
            h = r.bit_length() - 1
            if h in pivots:
                r ^= pivots[h]
            else:
                pivots[h] = r
                rank += 1
                break
    return rank


def to_int(bits):
    v = 0
    for i, b in enumerate(bits):
        if b:
            v |= 1 << i
    return v


def deterministic_space_dim(c, shots=3000):
    """dim of the space of measurement parities that are deterministic in the noiseless
    circuit = num_measurements - rank(sample - reference)."""
    s = c.compile_sampler(seed=7).sample(shots)
    ref = c.reference_sample()
    rows = [to_int(np.logical_xor(r, ref)) for r in s]
    # rank of the row space of outcomes = number of random bits
    return c.num_measurements - gf2_rank(rows)


def detector_span_rank(c):
    """Rank of detector (+ observable) measurement sets as GF(2) vectors."""
    c = c.flattened()
    n = 0
    dets, obs = [], {}
    for ins in c:
        if ins.name in MEAS:
            n += len(qubit_targets(ins))
        elif ins.name == "DETECTOR":
            dets.append(sum(1 << (n + t.value) for t in ins.targets_copy()))
        elif ins.name == "OBSERVABLE_INCLUDE":
            k = int(ins.gate_args_copy()[0])
            for t in ins.targets_copy():
                obs[k] = obs.get(k, 0) ^ (1 << (n + t.value))
    return gf2_rank(list(dets)), gf2_rank(list(dets) + list(obs.values())), len(dets)


def chromobius_rate(noisy, shots, seed=5):
    import chromobius
    dem = noisy.detector_error_model(decompose_errors=False)
    dec = chromobius.compile_decoder_for_dem(dem)
    sampler = noisy.compile_detector_sampler(seed=seed)
    det, obs = sampler.sample(shots, separate_observables=True, bit_packed=True)
    pred = dec.predict_obs_flips_from_dets_bit_packed(det)
    errs = int(np.any(pred != obs, axis=1).sum())
    return errs, shots


def main():
    t0 = time.time()
    log("# verify.py -- Lacroix et al. 2025 color code circuits")
    log(f"stim {stim.__version__}")
    mem = sorted(glob.glob(os.path.join(HERE, "memory-*.stim")))
    tel = sorted(glob.glob(os.path.join(HERE, "circuit-teleport*.stim")))
    summary = {"memory": {}, "teleport": {}}

    # ---------------------------------------------------------------- A
    log("\n## A. noiseless determinism (1000 shots; memory circuits also 20 random sweep bitstrings x 50 shots)")
    allok = True
    for f in mem + tel:
        c = stim.Circuit.from_file(f)
        ok = noiseless_check(c, 1000, sweep_trials=20)
        allok &= ok
        log(f"{os.path.basename(f):34s} qubits={c.num_qubits:2d} meas={c.num_measurements:4d} "
            f"dets={c.num_detectors:4d} obs={c.num_observables} sweep={c.num_sweep_bits} all-zero={ok}")
    log(f"ALL NOISELESS DETECTORS/OBSERVABLES ZERO: {allok}")

    # ---------------------------------------------------------------- B
    log("\n## B. structure vs paper statements")
    B = {"pi_ns": 35, "pi2_ns": 18, "cz_ns": 37, "readout_ns": 600, "reset_ns": 160, "dqlr_ns": 53}
    for f in mem:
        c = stim.Circuit.from_file(f)
        data, aux, ro = roles(c)
        st = per_cycle_stats(c)
        bulk = st[1] if len(st) > 2 else st[0]
        est = bulk["h_layers"] * B["pi2_ns"] + bulk["cz_layers"] * B["cz_ns"] + B["readout_ns"] + B["reset_ns"] + B["dqlr_ns"]
        name = os.path.basename(f)
        summary["memory"][name] = {"data": len(data), "aux": len(aux), "reset_only": len(ro),
                                   "cz_per_cycle": bulk["cz_gates"], "cz_layers_per_cycle": bulk["cz_layers"],
                                   "h_layers_per_cycle": bulk["h_layers"], "meas_per_cycle": bulk["meas"],
                                   "cycles": len(st), "cycle_estimate_ns": est}
        log(f"{name:28s} data={len(data):2d} aux={len(aux):2d} (+{len(ro)} reset-only) cycles={len(st):2d} "
            f"bulk cycle: CZ={bulk['cz_gates']} in {bulk['cz_layers']} layers, H layers={bulk['h_layers']}, "
            f"reset layers={bulk['reset_layers']}, meas={bulk['meas']}; "
            f"est. cycle = {bulk['h_layers']}x18+{bulk['cz_layers']}x37+600+160+53 = {est} ns")
    log("paper: d=3 subsets use 13 qubits (7 data + 6 aux), d=5 uses 37 (19 data + 18 aux) [App. D.2, Sec. II];")
    log("       8 CNOT layers + 'only two layers of two-qubit gates' from the readout-line transformation = 10 CZ layers [App. C.3];")
    log("       'total error correction cycle duration ... approximately 1.3 us' [App. C.3]")

    # ---------------------------------------------------------------- C
    log("\n## C. Zenodo noisy circuits = ideal + SI1000(p=0.001)")
    exact_all, strip_all = True, True
    for f in mem:
        nf = os.path.join(HERE, "data", "zenodo", os.path.basename(f).replace(".stim", ".noisy_si1000.stim"))
        ideal = stim.Circuit.from_file(f)
        noisy = stim.Circuit.from_file(nf)
        regen = si1000(ideal)
        exact = regen == noisy.flattened()
        stripped = strip_noise(noisy) == drop_trailing_tick(ideal)
        probs = sorted({round(a, 6) for ins in noisy.flattened() if ins.name in NOISE | MEAS for a in ins.gate_args_copy()})
        exact_all &= exact
        strip_all &= stripped
        log(f"{os.path.basename(nf):44s} regenerated==file: {exact}  stripped==ideal: {stripped}  noise strengths: {probs}")
    log(f"ALL NOISY == SI1000(IDEAL) EXACTLY: {exact_all};  ALL STRIPPED == IDEAL: {strip_all}")

    # ---------------------------------------------------------------- D
    log("\n## D. detector error models (decompose_errors=False)")
    for f in mem:
        nf = os.path.join(HERE, "data", "zenodo", os.path.basename(f).replace(".stim", ".noisy_si1000.stim"))
        dem = stim.Circuit.from_file(nf).detector_error_model(decompose_errors=False)
        summary["memory"][os.path.basename(f)]["dem_errors"] = dem.num_errors
        log(f"{os.path.basename(nf):44s} detectors={dem.num_detectors:4d} error mechanisms={dem.num_errors}")
    zdem_f = os.path.join(HERE, "data", "zenodo", "memory-d5-Z-r05.chromobius_si1000_prior.dem")
    if os.path.exists(zdem_f):
        zdem = stim.DetectorErrorModel.from_file(zdem_f)
        ours = stim.Circuit.from_file(os.path.join(HERE, "data", "zenodo", "memory-d5-Z-r05.noisy_si1000.stim")).detector_error_model(decompose_errors=False)

        def hyperedges(d):
            out = {}
            for ins in d.flattened():
                if ins.type == "error":
                    key = tuple(sorted(str(t) for t in ins.targets_copy() if not t.is_separator()))
                    out[key] = out.get(key, 0) + ins.args_copy()[0]
            return out
        zh, oh = hyperedges(zdem), hyperedges(ours)
        common = set(zh) & set(oh)
        maxrel = max(abs(zh[k] - oh[k]) / max(zh[k], 1e-12) for k in common) if common else None
        log(f"Zenodo chromobius_decoder_with_si1000_prior/error_model.dem (d5 Z r05): {len(zh)} hyperedges "
            f"(after merging decomposition suggestions); ours: {len(oh)}; common {len(common)}; "
            f"max relative prob. difference on common = {maxrel:.2e}")

    # ---------------------------------------------------------------- E
    log("\n## E. Chromobius decoding of SIMULATED SI1000 p=1e-3 data (not the experimental data)")
    try:
        import chromobius  # noqa: F401
        for f in mem:
            nf = os.path.join(HERE, "data", "zenodo", os.path.basename(f).replace(".stim", ".noisy_si1000.stim"))
            e, n = chromobius_rate(stim.Circuit.from_file(nf), 20000)
            summary["memory"][os.path.basename(f)]["chromobius_sim_logical_error"] = e / n
            log(f"{os.path.basename(nf):44s} logical errors {e}/{n} = {e / n:.4f}")
    except ImportError:
        log("chromobius not installed; skipped")

    # ---------------------------------------------------------------- F
    log("\n## F. reconstructed lattice-surgery teleportation")
    recs = json.load(open(os.path.join(HERE, "teleport-records.json")))
    expected_bit = {"0": 0, "1": 1, "+": 0, "-": 1}
    for f in tel:
        name = os.path.basename(f)
        c = stim.Circuit.from_file(f)
        info = recs[name]
        st = per_cycle_stats(c)
        # raw (not reference-relative) value of the observable's measurement parity
        ms = c.compile_sampler(seed=3).sample(1000)
        val = np.logical_xor.reduce(ms[:, info["observable_measurements"]], axis=1)
        m1 = np.logical_xor.reduce(ms[:, info["m1_MXX_measurements"]], axis=1)
        detdim = deterministic_space_dim(c)
        r_det, r_all, ndet = detector_span_rank(c)
        noisy = si1000(c)
        dem = noisy.detector_error_model(decompose_errors=False)
        t1 = time.time()
        errs = noisy.search_for_undetectable_logical_errors(
            dont_explore_detection_event_sets_with_size_above=3,
            dont_explore_edges_with_degree_above=3,
            dont_explore_edges_increasing_symptom_degree=False,
            canonicalize_circuit_errors=True)
        dist = len(errs)
        try:
            e, n = chromobius_rate(noisy, 20000)
            chrom = f"{e}/{n} = {e / n:.4f}"
        except Exception as ex:  # noqa: BLE001
            chrom = f"chromobius failed: {str(ex).splitlines()[0][:160]}"
        summary["teleport"][name] = {
            "qubits": c.num_qubits, "measurements": c.num_measurements, "detectors": ndet,
            "cycles": len(st) - 1, "cnot_per_cycle": [s["cx_gates"] for s in st],
            "cnot_layers_per_cycle": [s["cx_layers"] for s in st],
            "observable_value": sorted(set(int(v) for v in val)), "m1_values_seen": sorted(set(int(v) for v in m1)),
            "deterministic_parity_dim": detdim, "detector_rank": r_det, "detector_plus_obs_rank": r_all,
            "dem_detectors": dem.num_detectors, "dem_errors": dem.num_errors,
            "circuit_distance_upper_bound": dist, "chromobius_sim": chrom}
        log(f"{name}: input |{info['input_state']}>, L2 read in {info['l2_readout_basis']}")
        log(f"  qubits={c.num_qubits} measurements={c.num_measurements} detectors={ndet} "
            f"(rank {r_det}; +observable rank {r_all}); deterministic parity space dim = {detdim} "
            f"-> detectors complete: {r_all == detdim}")
        log(f"  cycles (init, merge x3, split) + final readout: CNOTs per cycle {[s['cx_gates'] for s in st]}, "
            f"CNOT layers {[s['cx_layers'] for s in st]}, measurements {[s['meas'] for s in st]}")
        log(f"  noiseless raw value of OBSERVABLE 0 parity over 1000 shots: {sorted(set(int(v) for v in val))} "
            f"(expected logical bit {expected_bit[info['input_state']]}); m1 (M_XX) outcomes seen: "
            f"{sorted(set(int(v) for v in m1))} (random, as it must be)")
        log(f"  SI1000 p=1e-3 DEM: {dem.num_detectors} detectors, {dem.num_errors} error mechanisms; "
            f"shortest undetectable logical error found (args 3,3): {dist}; chromobius (sim): {chrom}  "
            f"[{time.time() - t1:.1f}s]")
    # stabilizer weights in the merged code (Fig. 5d statements)
    w = {t: len(bt.TILES[t][3]) for t in bt.TILES}
    log(f"tile weights: {w}")
    log("paper: 'the green (red) boundary stabilizers of L1 (L2) are expanded from weight-four to weight-six'"
        f" -> green1 {w['green1']} -> green1x {w['green1x']}, red2 {w['red2']} -> red2x {w['red2x']}; "
        f"'two new X-basis stabilizers' -> hatL (weight {w['hatL']}), hatR (weight {w['hatR']}), X only")
    m1keys = [recs["circuit-teleport-plus.stim"]["measurement_keys"][m] for m in recs["circuit-teleport-plus.stim"]["m1_MXX_measurements"]]
    log(f"m1 measurement set derived by stim flow solving (merge cycle 3, X_L1 -> X_L2): {m1keys}")
    log("paper: 'the parity measurement outcome m1 is determined from the product of the X-basis merge stabilizers"
        " and the Bell measurement outcome' -> hatL(4,4) and hatR(4,8) M_X plus interface (4,5) M_X")

    log(f"\n(total time {time.time() - t0:.0f}s)")
    with open(os.path.join(HERE, "verify.txt"), "w", newline="\n") as fh:
        fh.write("\n".join(OUT) + "\n")
    with open(os.path.join(HERE, "verify-summary.json"), "w", newline="\n") as fh:
        json.dump(summary, fh, indent=1)


if __name__ == "__main__":
    main()
