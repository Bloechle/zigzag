/*
 * zqs.js — blind binarization quality, ported from eval.py:quality_metrics
 * (the lab path, compute_cpo=False — CPO is diagnostic and not in the scalar).
 *
 *   ZQS = 100 · √(q_clean · f_adh) · q_cov · q_solid
 *         └──── validated core ──┘   └─ validity gates ─┘
 *
 * Inputs: gray (Uint8/Float, the SOURCE photo) and binary (Uint8, 0=ink) with
 * (w, h). Returns the scalar plus the full diagnostic profile, the same object
 * the Python emits per method.
 */
import {
    boxMeanReflect, sobel3, percentile, minFilter, maxFilter,
    connectedComponents, distanceTransform,
} from './imageops.js';

const CFG = {
    speck_scale: 200, cov_tile: 64, cov_min_edges: 25, cov_worst_frac: 0.20,
    cov_lo: 0.05, cov_hi: 0.40, flood_dead: 0.08, flood_span: 0.50,
};
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function median(arr) {
    if (!arr.length) return 0;
    const a = Float64Array.from(arr).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function meanStd(arr) {
    const n = arr.length; if (!n) return [0, 0];
    let s = 0; for (let i = 0; i < n; i++) s += arr[i]; const mu = s / n;
    let v = 0; for (let i = 0; i < n; i++) v += (arr[i] - mu) * (arr[i] - mu);
    return [mu, Math.sqrt(v / n)];
}

// run lengths of truthy runs along rows and columns of a w×h mask
function runLengths(mask, w, h) {
    const out = [];
    for (let y = 0; y < h; y++) {                // rows
        let run = 0;
        for (let x = 0; x < w; x++) {
            if (mask[y * w + x]) run++;
            else { if (run) out.push(run); run = 0; }
        }
        if (run) out.push(run);
    }
    for (let x = 0; x < w; x++) {                // cols
        let run = 0;
        for (let y = 0; y < h; y++) {
            if (mask[y * w + x]) run++;
            else { if (run) out.push(run); run = 0; }
        }
        if (run) out.push(run);
    }
    return out;
}

export function sourceStrokeWidth(gray, w, h) {
    const mean = boxMeanReflect(Float64Array.from(gray), w, h, 15);   // 31×31 → r=15
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) dark[i] = gray[i] < 0.9 * mean[i] ? 1 : 0;
    const r = runLengths(dark, w, h).filter(v => v >= 1 && v <= 60);
    return r.length ? median(r) : 0;
}

function worstRegionCoverage(strong, near, w, h, tile, minEdges, frac) {
    const covs = [];
    for (let yy = 0; yy < h; yy += tile) {
        for (let xx = 0; xx < w; xx += tile) {
            let ss = 0, cov = 0;
            const ye = Math.min(h, yy + tile), xe = Math.min(w, xx + tile);
            for (let y = yy; y < ye; y++) for (let x = xx; x < xe; x++) {
                const i = y * w + x;
                if (strong[i]) { ss++; if (near[i]) cov++; }
            }
            if (ss < minEdges) continue;
            covs.push(cov / ss);
        }
    }
    if (!covs.length) return 1;
    covs.sort((a, b) => a - b);
    const k = Math.max(1, Math.floor(covs.length * frac));
    let s = 0; for (let i = 0; i < k; i++) s += covs[i];
    return s / k;
}

export function qualityMetrics(gray, binary, w, h, swSrc = null) {
    const n = w * h, mpx = n / 1e6;
    const ink = new Uint8Array(n);
    let inkCount = 0;
    for (let i = 0; i < n; i++) { if (binary[i] < 128) { ink[i] = 1; inkCount++; } }
    const out = { ink_pct: round(100 * inkCount / n, 2) };

    if (inkCount === 0 || inkCount === n) {
        return Object.assign(out, {
            speckles_mpx: 0, sw_px: 0, sw_src_px: 0, q_stroke: 0, q_swm: 0,
            q_edge: 0, q_recall: 0, f_adh: 0, cc_per_mpx: 0, edge_strong: 0,
            flood_pct: inkCount === n ? 100 : 0, cov_worst: 0,
            q_clean: 0, q_cov: 0, q_solid: 0, cpo_px: null, zqs: 0,
        });
    }

    // — connected components: speckles + fragmentation density —
    const { count, areas } = connectedComponents(ink, w, h);
    let speckN = 0; for (let l = 1; l < areas.length; l++) if (areas[l] <= 8) speckN++;
    const speck = speckN / mpx;
    const cc_per_mpx = (count - 1) / Math.max(mpx, 1e-6);

    // — distance transform: stroke ridge (width + regularity) + interior —
    const dt = distanceTransform(ink, w, h);
    const dtMax = maxFilter(dt, w, h, 3);
    const rr = [];
    for (let i = 0; i < n; i++) if (dt[i] >= 1.0 && dtMax[i] <= dt[i] + 1e-6) rr.push(dt[i]);
    const sw = rr.length ? 2 * median(rr) : 0;
    const [rmu, rsd] = meanStd(rr);
    const cv = rr.length ? rsd / Math.max(rmu, 1e-6) : 9.9;
    const q_stroke = Math.exp(-cv);

    // — source gradient field (normalised) → contour precision & recall —
    const gf = Float64Array.from(gray);
    const gx = sobel3(gf, w, h, 1, 0), gy = sobel3(gf, w, h, 0, 1);
    const mag = new Float64Array(n);
    for (let i = 0; i < n; i++) mag[i] = Math.hypot(gx[i], gy[i]);
    const p99 = Math.max(percentile(mag, 99), 1e-6);
    for (let i = 0; i < n; i++) mag[i] /= p99;
    let magSum = 0; for (let i = 0; i < n; i++) magSum += mag[i]; const magMean = magSum / n;

    // boundary = ink XOR erode(ink, 3×3)
    const inkEro = minFilter(Float64Array.from(ink), w, h, 3);
    const boundary = new Uint8Array(n);
    let bSum = 0, bN = 0;
    for (let i = 0; i < n; i++) {
        const b = (ink[i] ? 1 : 0) ^ (inkEro[i] >= 0.5 ? 1 : 0);
        boundary[i] = b; if (b) { bN++; bSum += mag[i]; }
    }
    const cr = bN ? (bSum / bN) / Math.max(magMean, 1e-6) : 0;
    const q_edge = clip((cr - 1) / 4, 0, 1);

    const strong = new Uint8Array(n);
    let strongN = 0; for (let i = 0; i < n; i++) if (mag[i] > 0.5) { strong[i] = 1; strongN++; }
    const nearF = maxFilter(Float64Array.from(boundary), w, h, 5);
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) near[i] = nearF[i] >= 0.5 ? 1 : 0;
    let covN = 0; for (let i = 0; i < n; i++) if (strong[i] && near[i]) covN++;
    const q_recall = strongN ? covN / Math.max(strongN, 1) : 0;
    const f_adh = (q_edge + q_recall > 0) ? 2 * q_edge * q_recall / (q_edge + q_recall) : 0;

    const p90 = percentile(mag, 90);
    let esN = 0; for (let i = 0; i < n; i++) if (boundary[i] && mag[i] > p90) esN++;
    const edge_strong = bN ? esN / bN : 0;

    // — stroke-width coherence vs the source estimate (diagnostic) —
    if (swSrc == null) swSrc = sourceStrokeWidth(gray, w, h);
    const q_swm = swSrc > 0 ? Math.exp(-Math.abs(Math.log(Math.max(sw, 0.5) / Math.max(swSrc, 0.5)))) : 0;

    // ── core × gates ─────────────────────────────────────────────────────────
    const q_clean = 1 / (1 + speck / CFG.speck_scale);
    const cov_worst = worstRegionCoverage(strong, near, w, h, CFG.cov_tile, CFG.cov_min_edges, CFG.cov_worst_frac);
    const q_cov = clip((cov_worst - CFG.cov_lo) / (CFG.cov_hi - CFG.cov_lo), 0, 1);
    const tau = Math.min(Math.max(3, 1.5 * swSrc), 12);
    let deepN = 0; for (let i = 0; i < n; i++) if (ink[i] && dt[i] > tau) deepN++;
    const flood_frac = deepN / inkCount;
    const q_solid = clip(1 - Math.max(0, flood_frac - CFG.flood_dead) / CFG.flood_span, 0, 1);

    const zqs = 100 * Math.sqrt(Math.max(q_clean, 1e-9) * Math.max(f_adh, 1e-9)) * q_cov * q_solid;

    return Object.assign(out, {
        cpo_px: null,
        speckles_mpx: round(speck, 1), sw_px: round(sw, 2), sw_src_px: round(swSrc, 2),
        q_stroke: round(q_stroke, 3), q_edge: round(q_edge, 3), q_recall: round(q_recall, 3),
        f_adh: round(f_adh, 3), q_swm: round(q_swm, 3), cc_per_mpx: round(cc_per_mpx, 1),
        edge_strong: round(edge_strong, 3), flood_pct: round(100 * flood_frac, 1),
        cov_worst: round(cov_worst, 3), q_clean: round(q_clean, 3), q_cov: round(q_cov, 3),
        q_solid: round(q_solid, 3), zqs: round(zqs, 2),
    });
}

function round(v, d) { const m = 10 ** d; return Math.round(v * m) / m; }
