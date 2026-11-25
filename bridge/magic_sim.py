"""Noise simulations of the two magic-state experiments, with Stim (riscq/ftqvm/magic.mjs calls this).

Input: one JSON document on stdin; output: one JSON document on stdout.

  {"mode": "sample", "stim": <circuit text>, "seed": s}
      One noiseless shot: the measurement bits a twin's readout returns in its RISC-Q run.

  {"mode": "postselect", "stim": <circuit text>, "noise": {"model": "si1000", "p": 0.0023}, "shots": N, "seed": s}
      Google's circuits, as the paper links them (non-Clifford gates are tagged identities, so the
      circuit is the Clifford proxy Stim can run). Noise: SI1000 (Gidney and Fowler 2021), the
      model the paper's own simulations use. Returns how many shots fire no detector, and how
      many of those flip the observable.

  {"mode": "frames", "stim": <circuit text>, "noise": {"model": "quera", ...}, "moments_ns": [...],
   "blocks": [{"atoms": [...], "checks": [[...]], "logical": [...], "t": 1}], "shots": N, "seed": s}
      QuEra's factory: the circuit is Clifford except the injected states, so the Pauli frame of
      the noisy circuit is learned with Stim and applied to the ideal logical channel afterwards
      (the paper's "input-decoupled noise learning", Methods). For each block: the syndrome of
      its measured atoms and the flip of its logical readout, raw and decoded.
      Returns a histogram of (per-block trivial syndrome, raw logical flip, decoded flip); the
      decoder is a lookup table sampled from separate training shots (the paper's MLD).

Noise models: see `si1000` and `quera` below; every rate is stated with its source in the
JSON the caller writes (validation/ftqvm/papers/*.json).
"""
import json
import math
import sys

import numpy as np
import stim

ONE_QUBIT = {"H", "H_YZ", "H_XY", "S", "S_DAG", "SQRT_X", "SQRT_X_DAG", "SQRT_Y", "SQRT_Y_DAG", "X", "Y", "Z", "C_XYZ", "C_ZYX"}
TWO_QUBIT = {"CZ", "CX", "CY", "SQRT_ZZ", "SQRT_ZZ_DAG"}


def moments(circuit):
    """Split a flat circuit into moments at TICK."""
    out, cur = [], []
    for inst in circuit:
        if inst.name == "TICK":
            out.append(cur)
            cur = []
        else:
            cur.append(inst)
    out.append(cur)
    return out


def targets(inst):
    """The qubits an instruction acts on. A two-qubit gate controlled by a sweep bit or a
    measurement record (Stim's classically controlled Paulis, e.g. the random input bitstrings of
    Google's circuits) acts on no qubit pair: only its qubit-qubit pairs are returned for it."""
    ts = inst.targets_copy()
    if inst.name in TWO_QUBIT:
        out = []
        for a, b in zip(ts[0::2], ts[1::2]):
            if a.is_qubit_target and b.is_qubit_target:
                out += [a.value, b.value]
        return out
    return [t.value for t in ts if t.is_qubit_target]


def si1000(circuit, p):
    """SI1000 (Gidney and Fowler, arXiv:2108.10457): CZ DEPOLARIZE2(p); a one-qubit gate
    DEPOLARIZE1(p/10); reset X_ERROR(2p); measurement X_ERROR(5p) before; an idle qubit
    DEPOLARIZE1(p/10) per moment, DEPOLARIZE1(2p) in a moment that measures or resets."""
    n = circuit.num_qubits
    out = stim.Circuit()
    for k, ops in enumerate(moments(circuit)):
        if k:
            out.append("TICK")
        busy, resonator = set(), False
        for inst in ops:
            name, tag, qs = inst.name, inst.tag, targets(inst)
            if name in ("MR", "MRZ"):
                # A measurement followed by a reset of the same qubit (Stim's generated circuits).
                resonator = True
                out.append("X_ERROR", qs, 5 * p)
                out.append(inst)
                out.append("X_ERROR", qs, 2 * p)
            elif name in ("M", "MZ", "MX", "MY"):
                resonator = True
                out.append("X_ERROR" if name in ("M", "MZ") else "Z_ERROR", qs, 5 * p)
                out.append(inst)
            elif name in ("R", "RZ", "RX", "RY"):
                resonator = True
                out.append(inst)
                out.append("X_ERROR" if name in ("R", "RZ") else "Z_ERROR", qs, 2 * p)
            elif name in TWO_QUBIT:
                out.append(inst)
                if qs:
                    out.append("DEPOLARIZE2", qs, p)
            elif name in ONE_QUBIT or (name == "I" and tag in ("T_gate", "T_dagger_gate", "echo", "conjugate")):
                out.append(inst)
                out.append("DEPOLARIZE1", qs, p / 10)
            elif name == "I":
                out.append(inst)
                continue  # an explicit idle: charged below with the other idle qubits
            else:
                out.append(inst)
                continue
            busy.update(qs)
        idle = [q for q in range(n) if q not in busy]
        if idle and any(i.name not in ("DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS", "SHIFT_COORDS") for i in ops):
            out.append("DEPOLARIZE1", idle, 2 * p if resonator else p / 10)
    return out


def quera(circuit, noise, moments_ns):
    """QuEra's error model (Methods, "Error model"): local and global Raman gates and CZ as
    depolarizing channels with the paper's benchmarked infidelities; preparation and measurement
    errors splitting the stated 1% total evenly; idle dephasing exp(-t/T2) over every moment's
    duration on every atom (T2 ≈ 2 s, Methods). Move-induced errors are not given in the paper
    and are not added."""
    n = circuit.num_qubits
    out = stim.Circuit()
    for k, ops in enumerate(moments(circuit)):
        if k:
            out.append("TICK")
        dur = moments_ns[k] if k < len(moments_ns) else 0
        pz = (1 - math.exp(-dur * 1e-9 / noise["t2_s"])) / 2
        for inst in ops:
            name, qs = inst.name, targets(inst)
            if name in ("DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS"):
                out.append(inst)
                continue
            drive = inst.tag  # the drive of the operation: global, local, rydberg, pump, image
            if name == "M":
                out.append("X_ERROR", qs, noise["measure"])
                out.append(inst)
            elif name == "R":
                out.append(inst)
                out.append("X_ERROR", qs, noise["prepare"])
            elif name == "CZ":
                out.append(inst)
                out.append("DEPOLARIZE2", qs, noise["cz"])
            else:
                out.append(inst)
                out.append("DEPOLARIZE1", qs, noise["global1q"] if drive == "global" else noise["local1q"])
        if pz > 0:
            out.append("Z_ERROR", list(range(n)), pz)
    return out


def postselect(doc):
    circuit = stim.Circuit(doc["stim"])
    noisy = si1000(circuit, doc["noise"]["p"])
    sampler = noisy.compile_detector_sampler(seed=doc.get("seed", 1))
    shots, kept, flipped, done = doc["shots"], 0, 0, 0
    while done < shots:
        batch = min(200_000, shots - done)
        det, obs = sampler.sample(batch, separate_observables=True)
        ok = ~det.any(axis=1)
        kept += int(ok.sum())
        flipped += int((obs[ok].any(axis=1)).sum())
        done += batch
    return {"shots": shots, "kept": kept, "flipped": flipped, "detectors": circuit.num_detectors, "noisy_ops": len(noisy)}



def sample_blocks(noisy, blocks, shots, seed):
    """Per block: the syndrome (as an integer) and the raw logical flip of every shot."""
    synd = [np.zeros(shots, dtype=np.int64) for _ in blocks]
    raw = [np.zeros(shots, dtype=np.int64) for _ in blocks]
    done = 0
    while done < shots:
        batch = min(50_000, shots - done)
        sim = stim.FlipSimulator(batch_size=batch, disable_stabilizer_randomization=True, seed=seed + done)
        sim.do(noisy)
        flips = np.asarray(sim.get_measurement_flips(bit_packed=False)).T.astype(np.int64)  # shots × measurements
        for k, b in enumerate(blocks):
            f = flips[:, b["atoms"]]
            s = np.zeros(batch, dtype=np.int64)
            for j, c in enumerate(b["checks"]):
                s |= (f[:, c].sum(axis=1) % 2) << j
            synd[k][done:done + batch] = s
            raw[k][done:done + batch] = f[:, b["logical"]].sum(axis=1) % 2
        done += batch
    return synd, raw


def frames(doc):
    """The decoder is a lookup table built by sampling (the paper's MLD for d = 3, Methods,
    "Decoding"): for each syndrome of a block, the logical correction that the training shots
    show more often. Training shots are drawn with another seed and not evaluated."""
    circuit = stim.Circuit(doc["stim"])
    noisy = quera(circuit, doc["noise"], doc["moments_ns"])
    shots, blocks, seed = doc["shots"], doc["blocks"], doc.get("seed", 1)
    train = doc.get("train", shots)
    ts, tr = sample_blocks(noisy, blocks, train, seed + 10_000_019)
    tables = []
    for k in range(len(blocks)):
        # A block's table may be trained on the shots that the analysis keeps (`given`: blocks
        # whose syndrome must be trivial), as the paper decodes the output after postselecting
        # the four syndrome qubits: errors the transversal gates spread are correlated.
        keep = np.ones(train, dtype=bool)
        for j in blocks[k].get("given", []):
            keep &= ts[j] == 0
        size = 1 << len(blocks[k]["checks"])
        ones = np.bincount(ts[k][keep], weights=tr[k][keep], minlength=size)
        all_ = np.bincount(ts[k][keep], minlength=size)
        tables.append((ones * 2 > all_).astype(np.int64))
    es, er = sample_blocks(noisy, blocks, shots, seed)
    nb = len(blocks)
    code = np.zeros(shots, dtype=np.int64)
    for k in range(nb):
        trivial = (es[k] == 0).astype(np.int64)
        dec = er[k] ^ tables[k][es[k]]
        code |= (trivial << k) | (er[k] << (nb + k)) | (dec << (2 * nb + k))
    values, counts = np.unique(code, return_counts=True)
    bits = lambda x, off: "".join(str((int(x) >> (off + k)) & 1) for k in range(nb))
    hist = [[bits(v, 0), bits(v, nb), bits(v, 2 * nb), int(c)] for v, c in zip(values, counts)]
    return {"shots": shots, "train": train, "histogram": hist, "noisy_ops": len(noisy)}


def uniform(circuit, noise, moments_ns=None):
    """A paper's average error rates: DEPOLARIZE1(p1) after every one-qubit gate, DEPOLARIZE2(p2)
    after every two-qubit gate, X_ERROR(pm) before every measurement (the readout error), and,
    with pi, DEPOLARIZE1(pi) on every idle qubit per moment; or, with t1_s and tphi_s and the
    moments' durations, the idle Pauli channel p = 1 - exp(-t/T) with T_X = T_Y = 4 T1 and
    T_Z = T_phi on every idle qubit (as Besedin et al. simulate their device)."""
    n = circuit.num_qubits
    out = stim.Circuit()
    for k, ops in enumerate(moments(circuit)):
        if k:
            out.append("TICK")
        busy = set()
        for inst in ops:
            name, qs = inst.name, targets(inst)
            if name in ("M", "MZ") and noise.get("classical_readout"):
                # A readout error that flips the reported bit only (no reset: an X error would
                # leave the qubit flipped for every later round).
                out.append("M", qs, noise["pm"])
            elif name in ("M", "MZ"):
                out.append("X_ERROR", qs, noise["pm"]); out.append(inst)
            elif name == "MX":
                out.append("Z_ERROR", qs, noise["pm"]); out.append(inst)
            elif name in ("R", "RZ") and noise.get("pr"):
                out.append(inst); out.append("X_ERROR", qs, noise["pr"])
            elif name in TWO_QUBIT:
                out.append(inst)
                if qs:
                    out.append("DEPOLARIZE2", qs, noise["p2"])
            elif name in ONE_QUBIT:
                out.append(inst); out.append("DEPOLARIZE1", qs, noise["p1"])
            else:
                out.append(inst); continue
            busy.update(qs)
        real = any(i.name not in ("DETECTOR", "OBSERVABLE_INCLUDE", "QUBIT_COORDS") for i in ops)
        idle = [q for q in range(n) if q not in busy]
        if real and idle and noise.get("pi"):
            out.append("DEPOLARIZE1", idle, noise["pi"])
        if real and idle and noise.get("t1_s") and moments_ns and k < len(moments_ns) and moments_ns[k] > 0:
            t = moments_ns[k] * 1e-9
            if noise.get("idle") == "twirl":
                # Pauli-twirled amplitude and phase damping over the moment (T1, T2).
                pxy = (1 - math.exp(-t / noise["t1_s"])) / 4
                pz = max(0.0, (1 - math.exp(-t / noise["t2_s"])) / 2 - pxy)
            else:
                pxy = 1 - math.exp(-t / (4 * noise["t1_s"]))
                pz = 1 - math.exp(-t / noise["tphi_s"])
            out.append("PAULI_CHANNEL_1", idle, [pxy, pxy, pz])
    return out


def noisy_of(doc):
    """The circuit of a request with its noise: a Stim text with SI1000 added, or one of Stim's
    generated circuits (with SI1000 at p, or with its own uniform depolarizing noise)."""
    if "generated" in doc:
        g = doc["generated"]
        clean = stim.Circuit.generated(g["code_task"], distance=g["distance"], rounds=g["rounds"]).flattened()
    else:
        clean = stim.Circuit(doc["stim"]).flattened()
    noise = doc.get("noise", {"model": "si1000", "p": 1e-3})
    if noise["model"] == "uniform":
        return clean, uniform(clean, noise, doc.get("moments_ns"))
    if noise["model"] == "given":
        # The paper's own noisy circuit: its noise as published, and the circuit without it.
        return clean.without_noise(), clean
    return clean, (si1000(clean, noise["p"]) if noise["model"] == "si1000" else clean)


def reference_decoder(dem, hyper):
    """The reference the compiled decoder is set against: PyMatching for a graphlike model;
    Chromobius (the color-code decoder of Gidney and Jones) for a hypergraph one when its
    detectors carry color-code annotations; else none."""
    if not hyper:
        import pymatching
        m = pymatching.Matching.from_detector_error_model(dem)
        return "pymatching", lambda d: m.decode_batch(d)
    try:
        import chromobius
        dec = chromobius.compile_decoder_for_dem(dem)
    except Exception:
        return None
    nobs = dem.num_observables
    def predict(d):
        packed = np.packbits(d.astype(np.uint8), axis=1, bitorder="little")
        out = dec.predict_obs_flips_from_dets_bit_packed(packed)
        return np.unpackbits(out, axis=1, bitorder="little", count=nobs).astype(bool)
    return "chromobius", predict


def graph(doc):
    """The decoding graph of a circuit for the compiled union-find decoder (riscq/decoders/uf.mjs):
    detectors and observables as XORs of measurement bits (with the noiseless reference parity),
    the edges of its detector error model (decomposed into graphlike parts; parallel edges merged,
    keeping the observables of the likelier), and sample shots with what PyMatching decides on
    them, as the reference for the compiled decoder."""
    import pymatching
    clean, noisy = noisy_of(doc)
    flat = noisy.flattened()
    meas_count, det_meas, obs_meas = 0, [], {}
    for inst in flat:
        if inst.name in ("M", "MZ", "MX", "MY", "MR", "MRX", "MRY", "MRZ"):
            meas_count += len([t for t in inst.targets_copy() if t.is_qubit_target])
        elif inst.name == "MPP":
            meas_count += sum(1 for t in inst.targets_copy() if not t.is_combiner)
        elif inst.name == "DETECTOR":
            det_meas.append([meas_count + t.value for t in inst.targets_copy()])
        elif inst.name == "OBSERVABLE_INCLUDE":
            k = int(inst.gate_args_copy()[0])
            obs_meas.setdefault(k, []).extend(meas_count + t.value for t in inst.targets_copy())
    ref = noisy.reference_sample()
    det_ref = [int(sum(int(ref[m]) for m in ms) % 2) for ms in det_meas]
    nobs = noisy.num_observables
    obs_list = [obs_meas.get(k, []) for k in range(nobs)]
    obs_ref = [int(sum(int(ref[m]) for m in ms) % 2) for ms in obs_list]
    hyper = bool(doc.get("hyper"))
    if not hyper:
        try:
            dem = noisy.detector_error_model(decompose_errors=True, approximate_disjoint_errors=True)
        except ValueError:
            hyper = True  # not graphlike (color codes, qLDPC codes): the cluster decoder takes the hyperedges
    if hyper:
        dem = noisy.detector_error_model(decompose_errors=False, approximate_disjoint_errors=True)
    edges, errors = {}, {}
    for inst in dem.flattened():
        if inst.type != "error":
            continue
        p = inst.args_copy()[0]
        if hyper:
            dets = tuple(sorted(t.val for t in inst.targets_copy() if t.is_relative_detector_id()))
            obs = sum(1 << t.val for t in inst.targets_copy() if t.is_logical_observable_id())
            if not dets:
                continue
            if dets in errors:
                q, o = errors[dets]
                errors[dets] = (q * (1 - p) + p * (1 - q), o if q >= p else obs)
            else:
                errors[dets] = (p, obs)
            continue
        comp = [[]]
        for t in inst.targets_copy():
            if t.is_separator():
                comp.append([])
            else:
                comp[-1].append(t)
        for c in comp:
            dets = sorted(t.val for t in c if t.is_relative_detector_id())
            obs = sum(1 << t.val for t in c if t.is_logical_observable_id())
            if len(dets) == 0 or len(dets) > 2:
                continue
            key = (dets[0], dets[1] if len(dets) == 2 else -1)
            if key in edges:
                q, o = edges[key]
                edges[key] = (q * (1 - p) + p * (1 - q), o if q >= p else obs)
            else:
                edges[key] = (p, obs)
    stats = doc.get("stats_shots", 0)
    if stats:
        # Many shots, kept in Python: the observable's flip rate raw, after PyMatching, and among
        # shots where no detector fired (postselection), per observable.
        det, obs = noisy.compile_detector_sampler(seed=doc.get("seed", 1) + 1).sample(stats, separate_observables=True)
        keep = ~det.any(axis=1)
        st = {"shots": stats, "kept": int(keep.sum()), "raw": obs.sum(axis=0).tolist(), "keptFlips": obs[keep].sum(axis=0).tolist()}
        ref = reference_decoder(dem, hyper)
        if ref:
            st["pymatching"] = (ref[1](det) != obs).sum(axis=0).tolist()
            st["reference"] = ref[0]
    shots = doc.get("shots", 0)
    out = {"circuit": str(clean), "measurements": noisy.num_measurements, "detectors": det_meas, "detRef": det_ref,
           "observables": obs_list, "obsRef": obs_ref,
           "edges": [[a, b, o, p] for (a, b), (p, o) in sorted(edges.items())]}
    if stats:
        out["stats"] = st
    if hyper:
        # Error mechanisms, most likely first: the cluster decoder pivots on them in this order.
        out["errors"] = [[list(d), o, p] for d, (p, o) in sorted(errors.items(), key=lambda kv: -kv[1][0])]
    if shots:
        sampler = noisy.compile_sampler(seed=doc.get("seed", 1))
        m = sampler.sample(shots)
        dets, obs = noisy.compile_m2d_converter().convert(measurements=m, separate_observables=True)
        ref = reference_decoder(dem, hyper)
        pred = ref[1](dets) if ref else np.zeros((shots, max(1, nobs)), dtype=bool)
        out["reference"] = ref[0] if ref else None
        out["shots"] = ["".join("1" if b else "0" for b in row) for row in m]
        out["actual"] = [int(sum(int(b) << k for k, b in enumerate(row))) for row in obs]
        out["pymatching"] = [int(sum(int(b) << k for k, b in enumerate(row))) for row in pred]
        out["defects"] = [int(row.sum()) for row in dets]
    return out


def main():
    doc = json.load(sys.stdin)
    mode = doc["mode"]
    if mode == "graph":
        out = graph(doc)
    elif mode == "sample":
        # One noiseless shot of the circuit: the bits a twin's readout oracle returns.
        shot = stim.Circuit(doc["stim"]).compile_sampler(seed=doc.get("seed", 1)).sample(1)[0]
        out = {"bits": [int(b) for b in shot]}
    elif mode == "postselect":
        out = postselect(doc)
    elif mode == "frames":
        out = frames(doc)
    else:
        raise SystemExit("unknown mode " + mode)
    out["stim"] = stim.__version__
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
