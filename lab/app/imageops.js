/*
 * imageops.js — the numeric primitives shared by binarizers.js and zqs.js.
 *
 * Pure ES module, float64, no dependencies. Each routine matches the exact
 * OpenCV / NumPy convention used by the Python reference (binarizers_native.py
 * and eval.py:quality_metrics), so the JS port is numerically faithful:
 *
 *   boxSum / localStats   cv2.boxFilter(BORDER_CONSTANT) + count map  (clipped window)
 *   boxMeanReflect        cv2.boxFilter(normalize=True, BORDER_REFLECT_101)
 *   minFilter/maxFilter   cv2.erode / cv2.dilate, square SE, border ignored
 *   sobel3                cv2.Sobel(ksize=3, BORDER_REFLECT_101)
 *   percentile            np.percentile (linear interpolation)
 *   otsu                  cv2.threshold(THRESH_OTSU) threshold value
 *   connectedComponents   cv2.connectedComponentsWithStats(…, 8) (labels + areas)
 *   distanceTransform     cv2.distanceTransform(DIST_L2, 3) (Borgefors chamfer)
 *
 * Images are plain typed arrays in row-major order with explicit (w, h).
 */

// ── separable box sum: sum over the centred (2r+1)² window, zero-padded ──────
// Identical to cv2.boxFilter(CV_64F, normalize=False, BORDER_CONSTANT): the
// border window is clipped (only in-image samples contribute).
function hsum(src, dst, w, h, r) {
    for (let y = 0; y < h; y++) {
        const base = y * w;
        let sum = 0;
        const initR = Math.min(r, w - 1);
        for (let x = 0; x <= initR; x++) sum += src[base + x];
        dst[base] = sum;
        for (let x = 1; x < w; x++) {
            const add = x + r, rem = x - r - 1;
            if (add < w) sum += src[base + add];
            if (rem >= 0) sum -= src[base + rem];
            dst[base + x] = sum;
        }
    }
}

function vsum(src, dst, w, h, r) {
    for (let x = 0; x < w; x++) {
        let sum = 0;
        const initB = Math.min(r, h - 1);
        for (let y = 0; y <= initB; y++) sum += src[y * w + x];
        dst[x] = sum;
        for (let y = 1; y < h; y++) {
            const add = y + r, rem = y - r - 1;
            if (add < h) sum += src[add * w + x];
            if (rem >= 0) sum -= src[rem * w + x];
            dst[y * w + x] = sum;
        }
    }
}

export function boxSum(src, w, h, r) {
    const tmp = new Float64Array(w * h);
    const dst = new Float64Array(w * h);
    hsum(src, tmp, w, h, r);
    vsum(tmp, dst, w, h, r);
    return dst;
}

const ones = n => { const a = new Float64Array(n); a.fill(1); return a; };

// localStats over a w×w window — mirrors binarizers_native._local exactly:
// k = 2·(w//2)+1, centred, zero-padded, with an explicit count map.
export function localStats(gray, w, h, win) {
    const r = (win >> 1);                       // k = 2r+1
    const n = w * h;
    const g = Float64Array.from(gray);
    const g2 = new Float64Array(n);
    for (let i = 0; i < n; i++) g2[i] = g[i] * g[i];
    const s = boxSum(g, w, h, r);
    const s2 = boxSum(g2, w, h, r);
    const cnt = boxSum(ones(n), w, h, r);
    const mean = new Float64Array(n), std = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        mean[i] = s[i] / cnt[i];
        std[i] = Math.sqrt(Math.max(s2[i] / cnt[i] - mean[i] * mean[i], 0));
    }
    return { mean, std, sum: s, sumsq: s2, count: cnt };
}

// cv2.boxFilter(normalize=True, BORDER_REFLECT_101): reflect-padded mean.
export function boxMeanReflect(src, w, h, r) {
    const refl = (i, n) => {                     // BORDER_REFLECT_101: |abc → b a b c b a|
        if (n === 1) return 0;
        let p = 2 * (n - 1);
        i = ((i % p) + p) % p;
        return i < n ? i : p - i;
    };
    const k = 2 * r + 1;
    const tmp = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {                // horizontal
        const base = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let d = -r; d <= r; d++) s += src[base + refl(x + d, w)];
            tmp[base + x] = s / k;
        }
    }
    const dst = new Float64Array(w * h);
    for (let x = 0; x < w; x++) {                // vertical
        for (let y = 0; y < h; y++) {
            let s = 0;
            for (let d = -r; d <= r; d++) s += tmp[refl(y + d, h) * w + x];
            dst[y * w + x] = s / k;
        }
    }
    return dst;
}

// ── separable sliding min / max over a k×k square SE (cv2.erode / cv2.dilate)
// Border ignored: a clipped window at the edge (outside = +inf for erode,
// -inf for dilate, so it never wins). anchor = floor(k/2) like OpenCV's
// default (-1,-1). Monotonic-deque O(n) per axis.
// Per-line monotonic-deque sliding min/max (rows then cols).
function lineMinMax(get, set, len, k, anchor, takeMax) {
    const left = anchor, right = k - 1 - anchor;
    const dq = new Int32Array(len);             // indices, monotonic
    let head = 0, tail = 0;
    const better = (a, b) => takeMax ? a >= b : a <= b;
    const out = new Float64Array(len);
    // window for output i covers [i-left .. i+right] ∩ [0,len-1]
    let next = 0;                               // next index to push
    for (let i = 0; i < len; i++) {
        const hi = Math.min(len - 1, i + right);
        while (next <= hi) {
            const v = get(next);
            while (tail > head && better(v, get(dq[tail - 1]))) tail--;
            dq[tail++] = next++;
        }
        const lo = i - left;
        while (head < tail && dq[head] < lo) head++;
        out[i] = get(dq[head]);
    }
    for (let i = 0; i < len; i++) set(i, out[i]);
    head = tail = next = 0;
}

function morph(src, w, h, k, takeMax) {
    const anchor = k >> 1;
    const buf = Float64Array.from(src);
    for (let y = 0; y < h; y++) {               // rows
        const base = y * w;
        lineMinMax(i => buf[base + i], (i, v) => buf[base + i] = v, w, k, anchor, takeMax);
    }
    for (let x = 0; x < w; x++) {                // cols
        lineMinMax(i => buf[i * w + x], (i, v) => buf[i * w + x] = v, h, k, anchor, takeMax);
    }
    return buf;
}

export const maxFilter = (src, w, h, k) => morph(src, w, h, k, true);   // dilate
export const minFilter = (src, w, h, k) => morph(src, w, h, k, false);  // erode

// ── separable Gaussian blur, BORDER_REPLICATE (cv2.GaussianBlur default for
// adaptiveThreshold). sigma<=0 → cv2's rule: 0.3·((k-1)·0.5−1)+0.8. ──────────
export function gaussianBlurReplicate(src, w, h, ksize, sigma = 0) {
    const k = ksize % 2 ? ksize : ksize + 1;
    const s = sigma > 0 ? sigma : 0.3 * ((k - 1) * 0.5 - 1) + 0.8;
    const r = k >> 1;
    const ker = new Float64Array(k);
    let sum = 0;
    for (let i = 0; i < k; i++) { const d = i - r; ker[i] = Math.exp(-(d * d) / (2 * s * s)); sum += ker[i]; }
    for (let i = 0; i < k; i++) ker[i] /= sum;
    const clamp = (i, n) => i < 0 ? 0 : i >= n ? n - 1 : i;
    const tmp = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        const b = y * w;
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let d = -r; d <= r; d++) acc += src[b + clamp(x + d, w)] * ker[d + r];
            tmp[b + x] = acc;
        }
    }
    const dst = new Float64Array(w * h);
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let acc = 0;
            for (let d = -r; d <= r; d++) acc += tmp[clamp(y + d, h) * w + x] * ker[d + r];
            dst[y * w + x] = acc;
        }
    }
    return dst;
}

// ── Sobel 3×3, BORDER_REFLECT_101 (cv2 default) ─────────────────────────────
export function sobel3(src, w, h, dx, dy) {
    const refl = (i, n) => (n === 1 ? 0 : (() => { let p = 2 * (n - 1), j = ((i % p) + p) % p; return j < n ? j : p - j; })());
    // separable: d/dx = [-1,0,1] ⊗ [1,2,1]ᵀ ; d/dy = [1,2,1] ⊗ [-1,0,1]ᵀ
    const out = new Float64Array(w * h);
    const smoothX = [1, 2, 1], diffX = [-1, 0, 1];
    const kh = dx ? diffX : smoothX;             // horizontal kernel
    const kv = dy ? diffX : smoothX;             // vertical kernel
    const tmp = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        const base = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let d = -1; d <= 1; d++) s += src[base + refl(x + d, w)] * kh[d + 1];
            tmp[base + x] = s;
        }
    }
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let s = 0;
            for (let d = -1; d <= 1; d++) s += tmp[refl(y + d, h) * w + x] * kv[d + 1];
            out[y * w + x] = s;
        }
    }
    return out;
}

// ── np.percentile, linear interpolation ─────────────────────────────────────
export function percentile(values, q) {
    const a = Float64Array.from(values).sort();
    const n = a.length;
    if (n === 0) return 0;
    if (n === 1) return a[0];
    const pos = (q / 100) * (n - 1);
    const lo = Math.floor(pos), frac = pos - lo;
    return lo + 1 < n ? a[lo] + frac * (a[lo + 1] - a[lo]) : a[lo];
}

// ── Otsu threshold value (cv2.threshold THRESH_OTSU) ────────────────────────
// cv2 maximises between-class variance; ties keep the first maximum. Histogram
// over the supplied 8-bit values. Returns the integer threshold T (classes
// [0..T] background-side, dst = src>T ? 255 : 0).
export function otsuThreshold(gray, n) {
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[gray[i] | 0]++;
    let total = 0, sumAll = 0;
    for (let i = 0; i < 256; i++) { total += hist[i]; sumAll += i * hist[i]; }
    if (total === 0) return 0;
    const mu = sumAll / total;
    let q1 = 0, sum1 = 0, maxBetween = 0, thr = 0;
    for (let t = 0; t < 256; t++) {
        q1 += hist[t];
        if (q1 === 0) continue;
        const q2 = total - q1;
        if (q2 === 0) break;
        sum1 += t * hist[t];
        const mu1 = sum1 / q1;
        const mu2 = (sumAll - sum1) / q2;
        const diff = mu1 - mu2;
        const between = (q1 / total) * (q2 / total) * diff * diff;
        if (between > maxBetween) { maxBetween = between; thr = t; }
    }
    return thr;
}

// ── connected components, 8-connectivity (cv2.connectedComponentsWithStats) ──
// fg = truthy pixels are foreground; background labelled 0, components 1..n-1.
// Returns { count (incl. background), labels:Int32Array, areas:Int32Array
// indexed by label }. Two-pass union-find.
export function connectedComponents(fg, w, h) {
    const n = w * h;
    const labels = new Int32Array(n);
    const parent = [0];                          // parent[0] unused (label 0 = bg)
    const find = x => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; } return r; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    let next = 1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!fg[i]) continue;
            // neighbours already labelled (8-conn): W, NW, N, NE
            let best = 0;
            const consider = j => { if (j && (best === 0 || j < best)) best = j; };
            if (x > 0) consider(labels[i - 1]);
            if (y > 0) {
                consider(labels[i - w]);
                if (x > 0) consider(labels[i - w - 1]);
                if (x < w - 1) consider(labels[i - w + 1]);
            }
            if (best === 0) { labels[i] = next; parent[next] = next; next++; }
            else {
                labels[i] = best;
                if (x > 0 && labels[i - 1]) union(best, labels[i - 1]);
                if (y > 0) {
                    if (labels[i - w]) union(best, labels[i - w]);
                    if (x > 0 && labels[i - w - 1]) union(best, labels[i - w - 1]);
                    if (x < w - 1 && labels[i - w + 1]) union(best, labels[i - w + 1]);
                }
            }
        }
    }
    // relabel roots to 1..k consecutively
    const remap = new Int32Array(next);
    let k = 0;
    for (let l = 1; l < next; l++) if (find(l) === l) remap[l] = ++k;
    const areas = new Int32Array(k + 1);
    for (let i = 0; i < n; i++) {
        if (labels[i]) { const r = remap[find(labels[i])]; labels[i] = r; areas[r]++; }
    }
    return { count: k + 1, labels, areas };
}

// ── distance transform, DIST_L2, maskSize 3 (cv2 Borgefors chamfer) ─────────
// Distance of every non-zero pixel to the nearest zero pixel. OpenCV's 3×3 L2
// approximation uses a = 0.955, b = 1.3693 in a forward + backward pass.
const CH_A = 0.955, CH_B = 1.3693;
export function distanceTransform(fg, w, h) {
    const n = w * h;
    const INF = 1e18;
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = fg[i] ? INF : 0;
    for (let y = 0; y < h; y++) {                // forward
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (d[i] === 0) continue;
            let v = d[i];
            if (x > 0) v = Math.min(v, d[i - 1] + CH_A);
            if (y > 0) {
                v = Math.min(v, d[i - w] + CH_A);
                if (x > 0) v = Math.min(v, d[i - w - 1] + CH_B);
                if (x < w - 1) v = Math.min(v, d[i - w + 1] + CH_B);
            }
            d[i] = v;
        }
    }
    for (let y = h - 1; y >= 0; y--) {           // backward
        for (let x = w - 1; x >= 0; x--) {
            const i = y * w + x;
            if (d[i] === 0) continue;
            let v = d[i];
            if (x < w - 1) v = Math.min(v, d[i + 1] + CH_A);
            if (y < h - 1) {
                v = Math.min(v, d[i + w] + CH_A);
                if (x < w - 1) v = Math.min(v, d[i + w + 1] + CH_B);
                if (x > 0) v = Math.min(v, d[i + w - 1] + CH_B);
            }
            d[i] = v;
        }
    }
    return d;
}

// erode/dilate on a boolean/uint mask with a 3×3 (or k×k) square SE, returning
// a Uint8Array — convenience around min/maxFilter for morphological masks.
export function erodeMask(mask, w, h, k = 3) {
    const f = Float64Array.from(mask);
    const e = minFilter(f, w, h, k);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = e[i] >= 0.5 ? 1 : 0;
    return out;
}
export function dilateMask(mask, w, h, k = 3) {
    const f = Float64Array.from(mask);
    const e = maxFilter(f, w, h, k);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = e[i] >= 0.5 ? 1 : 0;
    return out;
}
