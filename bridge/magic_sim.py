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
TWO_QUBIT = {"CZ", "CX", "CY"}


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
    return [t.value for t in inst.targets_copy() if t.is_qubit_target]


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
            if name in ("M", "MZ", "MX", "MY"):
                resonator = True
                out.append("X_ERROR" if name in ("M", "MZ") else "Z_ERROR", qs, 5 * p)
                out.append(inst)
            elif name in ("R", "RZ", "RX", "RY"):
                resonator = True
                out.append(inst)
                out.append("X_ERROR" if name in ("R", "RZ") else "Z_ERROR", qs, 2 * p)
            elif name in TWO_QUBIT:
                out.append(inst)
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


def main():
    doc = json.load(sys.stdin)
    mode = doc["mode"]
    if mode == "sample":
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
