/*
 * binarizers.js — the committee of binarization methods, ported 1:1 from
 * binarizers_native.py. Each takes a grayscale Uint8/Float array + (w, h) and
 * returns a Uint8Array binary (0 = ink, 255 = background), matching the Python
 * convention `_apply`: pixels at or below the local threshold are ink.
 *
 * All local statistics flow through imageops.localStats (the same zero-padded
 * box-sum + count map as cv2.boxFilter(BORDER_CONSTANT)), so the exact-fidelity
 * methods stay exact.
 */
import {
    localStats, minFilter, maxFilter, boxSum, otsuThreshold,
    connectedComponents, gaussianBlurReplicate,
} from './imageops.js';

const apply = (gray, thr, n) => {                // ink (0) where gray ≤ thr
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = gray[i] <= thr[i] ? 0 : 255;
    return out;
};
const applyScalar = (gray, t, n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = gray[i] <= t ? 0 : 255;
    return out;
};
const f64 = g => Float64Array.from(g);
const maxOf = a => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
const minOf = a => { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; };

export function otsu(gray, w, h) {
    const n = w * h;
    return applyScalar(gray, otsuThreshold(gray, n), n);
}

export function mean_threshold(gray, w, h, window = 25) {
    const n = w * h, { mean } = localStats(gray, w, h, window);
    return apply(gray, mean, n);
}

export function niblack(gray, w, h, window = 25, k = -0.2) {
    const n = w * h, { mean, std } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = mean[i] + k * std[i];
    return apply(gray, thr, n);
}

export function sauvola(gray, w, h, window = 25, k = 0.34, R = 128) {
    const n = w * h, { mean, std } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = mean[i] * (1 + k * (std[i] / R - 1));
    return apply(gray, thr, n);
}

export function wolf(gray, w, h, window = 25, k = 0.5) {
    const n = w * h, { mean, std } = localStats(gray, w, h, window);
    const M = minOf(gray);
    const R = maxOf(std) || 1;
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = mean[i] - k * (1 - std[i] / R) * (mean[i] - M);
    return apply(gray, thr, n);
}

export function nick(gray, w, h, window = 25, k = -0.1) {
    const n = w * h, { mean, sumsq, count } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++)
        thr[i] = mean[i] + k * Math.sqrt(Math.max((sumsq[i] - mean[i] * mean[i]) / count[i], 0));
    return apply(gray, thr, n);
}

export function bradley(gray, w, h, window = null, t = 15) {
    const n = w * h, g = f64(gray);
    const win = window != null ? window : (w / 8) | 0;
    const lW = (win + 1) >> 1;
    const anchor = lW - 1;
    // box sum with kernel `win` anchored at (lW-1) → asymmetric clipped window
    const right = win - 1 - anchor;
    const s = boxAnchored(g, w, h, anchor, right);
    const area = boxAnchored(null, w, h, anchor, right);   // count map
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = (s[i] / area[i]) * (100 - t) / 100;
    return apply(gray, thr, n);
}

// asymmetric box sum: window [i-left .. i+right] per axis, zero-padded. When
// src is null it sums ones (the count map). Mirrors cv2.boxFilter(anchor=…).
function boxAnchored(src, w, h, left, right) {
    const n = w * h;
    const base = src ? Float64Array.from(src) : (() => { const a = new Float64Array(n); a.fill(1); return a; })();
    const tmp = new Float64Array(n), dst = new Float64Array(n);
    for (let y = 0; y < h; y++) {
        const b = y * w; let sum = 0;
        for (let x = -left; x <= right; x++) if (x >= 0 && x < w) sum += base[b + x];
        tmp[b] = sum;
        for (let x = 1; x < w; x++) {
            const add = x + right, rem = x - left - 1;
            if (add < w) sum += base[b + add];
            if (rem >= 0) sum -= base[b + rem];
            tmp[b + x] = sum;
        }
    }
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -left; y <= right; y++) if (y >= 0 && y < h) sum += tmp[y * w + x];
        dst[x] = sum;
        for (let y = 1; y < h; y++) {
            const add = y + right, rem = y - left - 1;
            if (add < h) sum += tmp[add * w + x];
            if (rem >= 0) sum -= tmp[rem * w + x];
            dst[y * w + x] = sum;
        }
    }
    return dst;
}

export function wellner(gray, w, h, window = 25, t = 15) {
    const n = w * h, { mean } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = mean[i] * (1 - t / 100);
    return apply(gray, thr, n);
}

export function phansalkar(gray, w, h, window = 25, k = 0.2, p = 3, q = 10) {
    const n = w * h, { mean, std } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++)
        thr[i] = mean[i] * (1 + p * Math.exp(-(q / 255) * mean[i]) + k * (std[i] / 128 - 1));
    return apply(gray, thr, n);
}

export function feng(gray, w, h, window = 21) {
    const n = w * h, g = f64(gray);
    const { mean, std } = localStats(gray, w, h, window);
    const { std: std2 } = localStats(gray, w, h, window * 2);
    const Rs = maxOf(std2) || 1;
    const M = minFilter(g, w, h, window);        // cv2.erode, square window
    const a1 = 0.12, a2 = 0.247, a3 = 0.062;
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++)
        thr[i] = (1 - a1) * mean[i] + a2 * (std[i] / Rs) * (mean[i] - M[i]) + a3 * M[i];
    return apply(gray, thr, n);
}

export function wan(gray, w, h, window = 25, k = 0.2, R = 128) {
    const n = w * h, g = f64(gray);
    const { mean, std } = localStats(gray, w, h, window);
    const lmax = maxFilter(g, w, h, window);     // cv2.dilate
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) thr[i] = ((lmax[i] + mean[i]) / 2) * (1 + k * (std[i] / R - 1));
    return apply(gray, thr, n);
}

export function bataineh(gray, w, h, window = 25) {
    const n = w * h, g = f64(gray);
    const { mean, std } = localStats(gray, w, h, window);
    let gm = 0; for (let i = 0; i < n; i++) gm += g[i]; gm /= n;
    let gv = 0; for (let i = 0; i < n; i++) gv += (g[i] - gm) * (g[i] - gm); const gs = Math.sqrt(gv / n);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++)
        thr[i] = mean[i] - ((mean[i] * mean[i] - std[i]) / ((gm + std[i]) * (gs + std[i]) + 1e-9)) * std[i];
    return apply(gray, thr, n);
}

export function bernsen(gray, w, h, window = 75, contrast_limit = 25, GT = 100) {
    const n = w * h, g = f64(gray);
    const lmax = maxFilter(g, w, h, window), lmin = minFilter(g, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++)
        thr[i] = (lmax[i] - lmin[i]) > contrast_limit ? (lmax[i] + lmin[i]) / 2 : GT;
    return apply(gray, thr, n);
}

export function trsingh(gray, w, h, window = 25, k = 0.2) {
    const n = w * h, g = f64(gray);
    const { mean } = localStats(gray, w, h, window);
    const thr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const md = Math.min(Math.abs(g[i] - mean[i]), 254);
        thr[i] = mean[i] * (1 + k * (md / (255 - md) - 1));
    }
    return apply(gray, thr, n);
}

// — high-contrast map (Su / ISauvola step 1) —
function highContrast(gray, w, h) {
    const n = w * h, g = f64(gray);
    const mx = maxFilter(g, w, h, 3), mn = minFilter(g, w, h, 3);
    const c = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        let v = 255 * (mx[i] - mn[i]) / (0.0001 + mx[i] + mn[i]);
        c[i] = Math.max(0, Math.min(255, v)) | 0;
    }
    const t = otsuThreshold(c, n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = c[i] > t ? 255 : 0;
    return out;
}

function estimateStrokeWidth(hc, w, h) {
    const hist = new Int32Array(w);
    for (let y = 0; y < h; y++) {
        const b = y * w;
        const peaks = [];
        for (let x = 1; x < w - 1; x++)
            if (hc[b + x] > hc[b + x - 1] && hc[b + x] > hc[b + x + 1]) peaks.push(x);
        for (let i = 1; i < peaks.length; i++) {
            const dd = peaks[i] - peaks[i - 1];
            if (dd < w) hist[dd]++;
        }
    }
    let sw = 3, mc = 0;
    for (let d = 2; d < w; d++) if (hist[d] > mc) { mc = hist[d]; sw = d; }
    return sw;
}

export function su(gray, w, h, window = 0, minN = 0) {
    const n = w * h, g = f64(gray);
    const hc = highContrast(gray, w, h);
    if (window === 0) { window = estimateStrokeWidth(hc, w, h) * 2; minN = window; }
    const r = window >> 1;
    const mask = new Float64Array(n), gm = new Float64Array(n), gm2 = new Float64Array(n);
    for (let i = 0; i < n; i++) { if (hc[i] === 255) { mask[i] = 1; gm[i] = g[i]; gm2[i] = g[i] * g[i]; } }
    const Ne = boxSum(mask, w, h, r), S = boxSum(gm, w, h, r), S2 = boxSum(gm2, w, h, r);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const nz = Math.max(Ne[i], 1);
        const meanE = S[i] / nz;
        const stdE = Math.sqrt(Math.max(S2[i] / nz - meanE * meanE, 0));
        out[i] = (Ne[i] >= minN && g[i] <= meanE + stdE / 2) ? 0 : 255;
    }
    return out;
}

export function isauvola(gray, w, h, window = 75, k = 0.2) {
    const n = w * h;
    const hc = highContrast(gray, w, h);
    const sv = sauvola(gray, w, h, window, k);
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) ink[i] = sv[i] === 0 ? 1 : 0;
    const { labels } = connectedComponents(ink, w, h);
    const keep = new Set();
    for (let i = 0; i < n; i++) if (hc[i] === 255 && ink[i]) keep.add(labels[i]);
    keep.delete(0);
    const out = new Uint8Array(n); out.fill(255);
    for (let i = 0; i < n; i++) if (keep.has(labels[i])) out[i] = 0;
    return out;
}

export function kapur(gray, w, h) {
    const n = w * h;
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[gray[i] | 0]++;
    const total = hist.reduce((a, b) => a + b, 0);
    const p = hist.map(v => v / total);
    const cum = new Float64Array(256); let c = 0;
    for (let i = 0; i < 256; i++) { c += p[i]; cum[i] = c; }
    let bestT = 0, bestH = -1;
    for (let t = 1; t < 255; t++) {
        const wB = cum[t], wF = 1 - wB;
        if (wB < 1e-9 || wF < 1e-9) continue;
        let HB = 0, HF = 0;
        for (let i = 0; i <= t; i++) { const v = p[i] / wB; if (v > 0) HB -= v * Math.log(v); }
        for (let i = t + 1; i < 256; i++) { const v = p[i] / wF; if (v > 0) HF -= v * Math.log(v); }
        if (HB + HF > bestH) { bestH = HB + HF; bestT = t; }
    }
    return applyScalar(gray, bestT, n);
}

export function kittler(gray, w, h) {
    const n = w * h;
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[gray[i] | 0]++;
    const total = hist.reduce((a, b) => a + b, 0);
    const p = hist.map(v => v / total);
    let bestT = 128, bestJ = 1e18;
    for (let t = 1; t < 255; t++) {
        let P1 = 0, P2 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i <= t; i++) { P1 += p[i]; s1 += i * p[i]; }
        for (let i = t + 1; i < 256; i++) { P2 += p[i]; s2 += i * p[i]; }
        if (P1 < 1e-9 || P2 < 1e-9) continue;
        const mu1 = s1 / P1, mu2 = s2 / P2;
        let v1 = 0, v2 = 0;
        for (let i = 0; i <= t; i++) v1 += (i - mu1) * (i - mu1) * p[i];
        for (let i = t + 1; i < 256; i++) v2 += (i - mu2) * (i - mu2) * p[i];
        v1 /= P1; v2 /= P2;
        if (v1 < 1e-9 || v2 < 1e-9) continue;
        const J = 1 + 2 * (P1 * Math.log(Math.sqrt(v1)) + P2 * Math.log(Math.sqrt(v2)))
            - 2 * (P1 * Math.log(P1) + P2 * Math.log(P2));
        if (J < bestJ) { bestJ = J; bestT = t; }
    }
    return applyScalar(gray, bestT, n);
}

export function adaptive_gaussian(gray, w, h, window = 51, C = 15) {
    const n = w * h, g = f64(gray);
    const bs = window % 2 ? window : window + 1;
    const mean = gaussianBlurReplicate(g, w, h, bs, 0);
    const out = new Uint8Array(n);
    // cv2 rounds the Gaussian mean to the source depth (uint8) before compare;
    // THRESH_BINARY → background where src > mean − C, ink otherwise.
    for (let i = 0; i < n; i++) out[i] = gray[i] > (Math.round(mean[i]) - C) ? 255 : 0;
    return out;
}

export const METHODS = {
    otsu, mean: mean_threshold, niblack, sauvola, wolf, nick, bradley,
    wellner, phansalkar, feng, wan, bataineh, bernsen, trsingh,
    su, isauvola, kapur, kittler, adaptive_gaussian,
};

export function binarize(name, gray, w, h) {
    return METHODS[name](gray, w, h);
}
