/*
 * A union-find decoder with peeling (Delfosse and Nickerson, "Almost-linear time decoding
 * algorithm for topological codes", Quantum 5, 595 (2021)) for a RISC-Q decoder core.
 *
 * It decodes a circuit, not a code: the graph is the circuit's detector error model (from Stim,
 * decomposed into edges), compiled in as tables by riscq/decoders/uf.mjs:
 *
 *   UF_MEAS            measurement bits of one shot
 *   UF_DET             detectors; detector i fires when the XOR of the bits det_meas[det_start[i] ..]
 *                      differs from its noiseless value det_ref[i]
 *   UF_EDGES           edges (a, b) between detectors, b == UF_DET for the boundary,
 *                      edge_obs[e] the observables the edge's error flips
 *   UF_OBS             observables; obs_meas lists the bits whose XOR is observable k
 *
 * One decode: detectors from the bits; clusters grow by half an edge per round around every
 * odd cluster that does not touch the boundary, and merge where an edge is fully grown; then
 * every cluster is peeled along a spanning forest of its grown edges (rooted at the boundary
 * where it touches it). The result is the observables the correction flips. The decoder is
 * unweighted: every edge has the same length.
 *
 * Two mains share this file (UF_MODE):
 *   UF_BENCH    cases in RAM; for each case, stores to the host window: the case id, the time
 *               before and after the decode (core time, batches), the correction mask, the
 *               number of defects and of growth rounds. riscq/decoders/uf.mjs reads them.
 *   UF_INRUN    a decoder core of a control system: it joins every segment's barrier, and in
 *               its decode segment reads the measured bits from the board's shared groups,
 *               decodes, and publishes the corrected observables (and the "any detector fired"
 *               flag) to shared slots that other cores condition pulses on.
 */
#include <stdint.h>
#include "riscq.h"
#include "uf_graph.h"   /* generated: sizes, tables, and for UF_INRUN the segment and slot map */

#define BOUNDARY UF_DET
#define NODES (UF_DET + 1)

static uint8_t meas[UF_MEAS];

#ifndef UF_HYPER
static uint16_t parent[NODES];
static uint16_t csize[NODES];
static uint8_t parity[NODES];      /* defects in the cluster, mod 2 (at the root) */
static uint8_t touches[NODES];     /* the cluster contains the boundary (at the root) */
static uint8_t grown[UF_EDGES];    /* half-edges grown: 0, 1 or 2 */
static uint8_t syn[NODES];
static uint8_t visited[NODES];
static uint16_t order[NODES];
static uint16_t pedge[NODES];
static uint16_t root[NODES];     /* the root of every node, refreshed once per growth round */
static uint8_t act[NODES];       /* the cluster of a root is odd and away from the boundary */
static uint16_t finished[UF_EDGES]; /* edges that finished growing in this round */

static uint32_t find(uint32_t x) {
    while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
}

static void unite(uint32_t a, uint32_t b) {
    a = find(a); b = find(b);
    if (a == b) return;
    if (csize[a] < csize[b]) { uint32_t t = a; a = b; b = t; }
    parent[b] = (uint16_t)a;
    csize[a] = (uint16_t)(csize[a] + csize[b]);
    parity[a] ^= parity[b];
    touches[a] |= touches[b];
}

/* Decode the bits in meas[]. Returns the correction's observable mask; *defects and *rounds
 * report the work done. */
static uint32_t decode(uint32_t *defects, uint32_t *rounds) {
    uint32_t i, e, d = 0, r = 0, any;
    for (i = 0; i < UF_DET; i++) {
        uint32_t v = 0, k;
        for (k = det_start[i]; k < det_start[i + 1]; k++) v ^= meas[det_meas[k]];
        v ^= det_ref[i]; /* a detector's noiseless parity is det_ref: it fires when the parity differs */
        syn[i] = (uint8_t)v;
        d += v;
    }
    syn[BOUNDARY] = 0;
    /* No detector fired: nothing to correct (the common case, and the cheapest). */
    if (!d) { *defects = 0; *rounds = 0; return 0; }
    for (i = 0; i < NODES; i++) { parent[i] = (uint16_t)i; csize[i] = 1; parity[i] = syn[i]; touches[i] = (i == BOUNDARY); visited[i] = 0; }
    for (e = 0; e < UF_EDGES; e++) grown[e] = 0;
    /* Growth: every edge at an active cluster grows by half from each active end. Only the
     * nodes of active clusters are visited; edges that finish growing are merged after. */
    do {
        uint32_t done = 0;
        any = 0;
        for (i = 0; i < NODES; i++) { uint32_t q = find(i); root[i] = (uint16_t)q; act[i] = 0; }
        for (i = 0; i < NODES; i++) if (root[i] == i) act[i] = (uint8_t)(parity[i] && !touches[i]);
        for (i = 0; i < NODES; i++) {
            uint32_t k;
            if (!act[root[i]]) continue;
            for (k = adj_start[i]; k < adj_start[i + 1]; k++) {
                uint32_t ed = adj_edge[k];
                if (grown[ed] >= 2) continue;
                any = 1;
                if (++grown[ed] == 2) finished[done++] = (uint16_t)ed;
            }
        }
        for (e = 0; e < done; e++) unite(edge_a[finished[e]], edge_b[finished[e]]);
        r += any;
    } while (any && r < 4 * NODES);
    /* Peeling: a spanning forest of the grown edges, by breadth-first search from the boundary
     * first, then from every node not reached; leaves are peeled back towards each root. */
    {
        uint32_t head = 0, tail = 0, n, mask = 0;
        /* Roots: the boundary first (every cluster that touches it hangs from it), then every
         * defect not yet reached (a cluster away from the boundary contains a defect). */
        for (n = 0; n <= UF_DET; n++) {
            uint32_t start = (n == 0) ? BOUNDARY : n - 1;
            if (visited[start] || (start != BOUNDARY && !syn[start])) continue;
            visited[start] = 1; pedge[start] = 0xFFFF; order[tail++] = (uint16_t)start;
            while (head < tail) {
                uint32_t v = order[head++], k;
                for (k = adj_start[v]; k < adj_start[v + 1]; k++) {
                    uint32_t ed = adj_edge[k], w;
                    if (grown[ed] != 2) continue;
                    w = (edge_a[ed] == v) ? edge_b[ed] : edge_a[ed];
                    if (visited[w]) continue;
                    visited[w] = 1; pedge[w] = (uint16_t)ed; order[tail++] = (uint16_t)w;
                }
            }
        }
        while (tail-- > 0) {
            uint32_t v = order[tail], ed, p;
            if (pedge[v] == 0xFFFF || !syn[v]) continue;
            ed = pedge[v];
            p = (edge_a[ed] == v) ? edge_b[ed] : edge_a[ed];
            mask ^= edge_obs[ed];
            syn[v] = 0;
            syn[p] ^= 1;
        }
        *defects = d; *rounds = r;
        return mask;
    }
}

#else /* UF_HYPER */
/*
 * The cluster decoder for any detector error model (hyperedges: color codes, qLDPC codes), after
 * Delfosse, Londe and Beverland, "Toward a union-find decoder for quantum LDPC codes", IEEE TIT
 * 68, 3187 (2022). Error mechanisms err_det[err_start[e] ..] flip detectors and err_obs[e]
 * observables; they are listed most likely first. A cluster is a set of detectors and of the
 * errors it has grown over. Clusters start at the fired detectors, with no errors, and grow by
 * one step of the Tanner graph (every error at one of their detectors, and that error's
 * detectors) until each cluster's fired detectors are explained by its errors: the linear system
 * H_C x = s_C over GF(2) has a solution. Each cluster is then solved by Gaussian elimination and
 * the likeliest solution kept (exhaustively over the null space up to UF_HEXACT free columns,
 * by greedy descent beyond).
 */
#define HW ((UF_HMAXC + 32) / 32)      /* words of one matrix row: columns and the syndrome bit */
static uint16_t parent[UF_DET];
static uint8_t syn[UF_DET];
static uint8_t incl[UF_DET];
static uint8_t added[UF_DET];
static uint16_t rowdet[UF_HMAXR];
static int16_t rowof[UF_DET];
static uint16_t cols[UF_HMAXC];
static uint32_t mat[UF_HMAXR][HW];
static uint8_t seen_err[UF_ERRS];
static uint8_t incle[UF_ERRS];   /* the error belongs to a cluster: it was grown over */
static uint32_t overflow;

static uint32_t find(uint32_t x) {
    while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
}
static void unite(uint32_t a, uint32_t b) {
    a = find(a); b = find(b);
    if (a != b) parent[b] = (uint16_t)a;
}

/* Build and eliminate the system of the cluster rooted at r. Returns 1 when it is solvable;
 * then, with `apply`, XORs the observables of the solution into *mask. */
static uint32_t solve(uint32_t r, uint32_t apply, uint32_t *mask) {
    uint32_t nr = 0, nc = 0, i, j, k, rank = 0;
    for (i = 0; i < UF_DET; i++) {
        rowof[i] = -1;
        if (!incl[i] || find(i) != r) continue;
        if (nr >= UF_HMAXR) { overflow = 1; return 0; }
        rowof[i] = (int16_t)nr; rowdet[nr++] = (uint16_t)i;
    }
    /* Interior errors, in likelihood order (the tables list them so). */
    for (k = 0; k < nr; k++) {
        uint32_t d = rowdet[k];
        for (j = dadj_start[d]; j < dadj_start[d + 1]; j++) {
            uint32_t e = dadj_err[j];
            if (seen_err[e] || !incle[e]) continue;
            seen_err[e] = 1;
            if (nc >= UF_HMAXC) { overflow = 1; break; }
            cols[nc++] = (uint16_t)e;
        }
    }
    /* Columns sorted by error index = likelihood order (insertion sort; clusters are small). */
    for (i = 1; i < nc; i++) { uint16_t x = cols[i]; j = i; while (j > 0 && cols[j - 1] > x) { cols[j] = cols[j - 1]; j--; } cols[j] = x; }
    for (i = 0; i < nc; i++) seen_err[cols[i]] = 0;
    for (k = 0; k < nr; k++) {
        for (j = 0; j < HW; j++) mat[k][j] = 0;
        if (syn[rowdet[k]]) mat[k][UF_HMAXC / 32] |= 1u << (UF_HMAXC % 32);
    }
    for (i = 0; i < nc; i++) {
        uint32_t e = cols[i], q;
        for (q = err_start[e]; q < err_start[e + 1]; q++) { int32_t row = rowof[err_det[q]]; mat[row][i >> 5] ^= 1u << (i & 31); }
    }
    {
        static uint16_t pivcol[UF_HMAXR];
        for (i = 0; i < nc && rank < nr; i++) {
            uint32_t w = i >> 5, b = 1u << (i & 31), p = rank;
            while (p < nr && !(mat[p][w] & b)) p++;
            if (p == nr) continue;
            if (p != rank) for (j = 0; j < HW; j++) { uint32_t t = mat[p][j]; mat[p][j] = mat[rank][j]; mat[rank][j] = t; }
            for (k = 0; k < nr; k++) if (k != rank && (mat[k][w] & b)) for (j = 0; j < HW; j++) mat[k][j] ^= mat[rank][j];
            pivcol[rank++] = (uint16_t)i;
        }
        for (k = rank; k < nr; k++) if (mat[k][UF_HMAXC / 32] & (1u << (UF_HMAXC % 32))) return 0;
        if (apply) {
            /* The likeliest solution: the particular solution x (free variables 0), improved over
             * the null space. A null vector of free column f flips f and every pivot column whose
             * reduced row has f. Weights are err_w (−log-likelihood, scaled); the search is
             * exhaustive for up to UF_HEXACT free columns, greedy descent beyond. */
            static uint16_t freec[UF_HMAXC];
            static uint8_t x[UF_HMAXC], ispiv[UF_HMAXC];
            uint32_t nf = 0, t, best, cur, improved, pass;
            for (i = 0; i < nc; i++) { x[i] = 0; ispiv[i] = 0; }
            for (k = 0; k < rank; k++) { ispiv[pivcol[k]] = 1; x[pivcol[k]] = (mat[k][UF_HMAXC / 32] >> (UF_HMAXC % 32)) & 1u; }
            for (i = 0; i < nc; i++) if (!ispiv[i]) freec[nf++] = (uint16_t)i;
            cur = 0;
            for (i = 0; i < nc; i++) if (x[i]) cur += err_w[cols[i]];
            /* flipping null vector t changes the weight by delta(t) */
            #define DELTA(tt, out) do { uint32_t f_ = freec[tt], kk_; int32_t dl_ = x[f_] ? -(int32_t)err_w[cols[f_]] : (int32_t)err_w[cols[f_]]; \
                for (kk_ = 0; kk_ < rank; kk_++) if (mat[kk_][f_ >> 5] & (1u << (f_ & 31))) { uint32_t c_ = pivcol[kk_]; dl_ += x[c_] ? -(int32_t)err_w[cols[c_]] : (int32_t)err_w[cols[c_]]; } \
                (out) = dl_; } while (0)
            #define FLIP(tt) do { uint32_t f_ = freec[tt], kk_; x[f_] ^= 1u; \
                for (kk_ = 0; kk_ < rank; kk_++) if (mat[kk_][f_ >> 5] & (1u << (f_ & 31))) x[pivcol[kk_]] ^= 1u; } while (0)
            if (nf && nf <= UF_HEXACT) {
                static uint8_t bestx[UF_HMAXC];
                uint32_t g, n = 1u << nf;
                best = cur;
                for (i = 0; i < nc; i++) bestx[i] = x[i];
                for (g = 1; g < n; g++) {
                    int32_t dl;
                    t = 0; while (!((g >> t) & 1u)) t++;   /* Gray code: flip vector t */
                    DELTA(t, dl); FLIP(t); cur = (uint32_t)((int32_t)cur + dl);
                    if (cur < best) { best = cur; for (i = 0; i < nc; i++) bestx[i] = x[i]; }
                }
                for (i = 0; i < nc; i++) x[i] = bestx[i];
            } else {
                for (pass = 0, improved = 1; improved && pass < 8; pass++) {
                    improved = 0;
                    for (t = 0; t < nf; t++) { int32_t dl; DELTA(t, dl); if (dl < 0) { FLIP(t); improved = 1; } }
                }
            }
            for (i = 0; i < nc; i++) if (x[i]) *mask ^= err_obs[cols[i]];
        }
    }
    return 1;
}

static uint32_t decode(uint32_t *defects, uint32_t *rounds) {
    uint32_t i, j, d = 0, r = 0, mask = 0, valid;
    for (i = 0; i < UF_DET; i++) {
        uint32_t v = 0, k;
        for (k = det_start[i]; k < det_start[i + 1]; k++) v ^= meas[det_meas[k]];
        v ^= det_ref[i];
        syn[i] = (uint8_t)v; incl[i] = (uint8_t)v; parent[i] = (uint16_t)i;
        d += v;
    }
    if (!d) { *defects = 0; *rounds = 0; return 0; }
    for (i = 0; i < UF_ERRS; i++) { seen_err[i] = 0; incle[i] = 0; }
    overflow = 0;
    do {
        valid = 1;
        for (i = 0; i < UF_DET; i++) added[i] = 0;
        for (i = 0; i < UF_DET; i++) {
            uint32_t root, k;
            if (!incl[i] || added[i] || find(i) != i) continue;
            if (solve(i, 0, &mask)) continue;
            valid = 0;
            /* Grow this cluster: every detector of every error at one of its detectors. */
            root = i;
            for (k = 0; k < UF_DET; k++) {
                uint32_t q;
                if (!incl[k] || added[k] || find(k) != root) continue;
                for (j = dadj_start[k]; j < dadj_start[k + 1]; j++) {
                    uint32_t e = dadj_err[j];
                    if (incle[e]) continue;
                    incle[e] = 1;
                    for (q = err_start[e]; q < err_start[e + 1]; q++) {
                        uint32_t x = err_det[q];
                        if (!incl[x]) { incl[x] = 1; added[x] = 1; parent[x] = (uint16_t)find(k); }
                        else unite(k, x);
                    }
                }
            }
        }
        r++;
    } while (!valid && !overflow && r < UF_DET);
    for (i = 0; i < UF_DET; i++) if (incl[i] && find(i) == i) solve(i, 1, &mask);
    *defects = d; *rounds = r | (overflow << 16);
    return mask;
}
#endif /* UF_HYPER */

/* The observables as measured (before correction): bit k is the XOR of obs_meas[obs_start[k] ..]. */
static uint32_t measured_obs(void) {
    uint32_t k, out = 0;
    for (k = 0; k < UF_OBS; k++) {
        uint32_t v = 0, j;
        for (j = obs_start[k]; j < obs_start[k + 1]; j++) v ^= meas[obs_meas[j]];
        out |= v << k;
    }
    return out;
}

#if defined(UF_BENCH)
/* Cases: bit j of case c is bit (j % 8) of uf_cases[c * UF_CASE_BYTES + j / 8]. */
int main(void) {
    uint32_t c, j, defects, rounds;
    volatile uint32_t *host = (volatile uint32_t *)RQ_HOSTWIN;
    uint32_t w = 0;
    for (c = 0; c < UF_CASES; c++) {
        uint32_t t0, t1, mask;
        for (j = 0; j < UF_MEAS; j++) meas[j] = (uint8_t)((uf_cases[c * UF_CASE_BYTES + (j >> 3)] >> (j & 7)) & 1u);
        t0 = now();
        mask = decode(&defects, &rounds);
        t1 = now();
        host[w++] = c;
        host[w++] = t0;
        host[w++] = t1;
        host[w++] = mask;
        host[w++] = measured_obs();
        host[w++] = defects;
        host[w++] = rounds;
    }
    return 0;
}
#elif defined(UF_INRUN)
/* The segments of the control program: in segment s every active core meets at barrier s % 16.
 * In UF_DECODE_SEGMENT the decoder reads the shared bits (in_group/in_slot of each measurement),
 * decodes, and publishes the corrected observables and the detection flag. */
int main(void) {
    uint32_t s, j, defects, rounds;
    volatile uint32_t *host = (volatile uint32_t *)RQ_HOSTWIN;
    for (s = 0; s < UF_SEGMENTS; s++) {
        uint32_t t0, t1, mask, obs, words[4];
        barrier(s % 16, UF_MEMBERS);
        if (s != UF_DECODE_SEGMENT) continue;
        t0 = now();
        for (j = 0; j < 4; j++) words[j] = RQ_MMIO(RQ_INBOX_BOARD + 4 * j);
        for (j = 0; j < UF_MEAS; j++) meas[j] = (uint8_t)((words[in_group[j]] >> in_slot[j]) & 1u);
        mask = decode(&defects, &rounds);
        obs = measured_obs() ^ mask;
#ifdef UF_PUBLISH_MASK
        obs = mask;   /* publish the correction (the logical-flip bits), not the corrected values */
#endif
        /* Publish what other cores condition on (a slot past the hub's 4 words is not shared). */
        for (j = 0; j < UF_OBS; j++) if (out_group[j] < 4) publish(out_group[j], out_slot[j], (obs >> j) & 1u);
        if (flag_group < 4) publish(flag_group, flag_slot, defects ? 1u : 0u);
        t1 = now();
        host[0] = t0;
        host[1] = t1;
        host[2] = mask;
        host[3] = obs;
        host[4] = defects;
        host[5] = rounds;
        host[6] = defects ? 1u : 0u;
        for (j = 0; j < UF_OBS; j++) host[7 + j] = (obs >> j) & 1u;
    }
    return 0;
}
#endif
