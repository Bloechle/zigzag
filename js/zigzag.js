/*
 * ZigZag - adaptive document image binarization and background removal.
 *
 * Implementation of the original algorithm published at ACM DocEng 2024:
 * Bloechle, Hennebert, Gisler - "ZigZag: A Robust Adaptive Approach to
 * Non-Uniformly Illuminated Document Image Binarization"
 * (DOI 10.1145/3685650.3685661).
 *
 * Two-pass local mean filtering: Pass A classifies likely background pixels
 * against the weighted local mean; Pass B normalizes each pixel against the
 * local mean of background-only pixels, equalizing illumination before a
 * single global Otsu threshold; ink specks below an area that scales with the
 * window are then removed (despeckle).
 *
 * Dependency-free ES module, separable rolling sums (O(n)), float64.
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 *
 * Usage (browser or Node):
 *   import { ZigZag } from './zigzag.js';
 *   const { data, width, height, info } = ZigZag.process(imageData, { mode: 'binary' });
 */

const VERSION = '1.3.2';
// Opaque white / black as one 32-bit word each, built from bytes so the
// value is right whatever the platform's endianness.
const WHITE = new Uint32Array(new Uint8ClampedArray([255, 255, 255, 255]).buffer)[0];
const BLACK = new Uint32Array(new Uint8ClampedArray([0, 0, 0, 255]).buffer)[0];
const OTSU_CAP = 250;
/** Largest window: keeps 255 * (size + 1)^2 inside the Int32 box sums
 *  (the automatic size stops at 250). */
const MAX_SIZE = 2048;
const MODES = ['binary', 'gray', 'color'];
/** size and despeckle: null (or 'auto') = the automatic rules below. */
const DEFAULTS = Object.freeze({
    mode: 'binary', size: null, weight: 90, upsample: true, thresholdOffset: 0, despeckle: null,
});

/**
 * Automatic window size: one window per 45 px of image diagonal, clamped to
 * [20, 250]. Keeps the window proportional to the page whatever the camera
 * resolution. Written with sqrt (correctly rounded in IEEE 754, unlike hypot)
 * and an explicit floor(x + 0.5), so the three ports agree on every input.
 * 250 also keeps the GPU's float32 box sums exact: (251^2) * 255 < 2^24.
 */
function autoSize(w, h) {
    return Math.min(250, Math.max(20, Math.floor(Math.sqrt(w * w + h * h) / 45 + 0.5)));
}

/**
 * Automatic despeckle area: ink specks smaller than round(size^2 / 225) pixels
 * are removed (an area, so it scales as the square of the window: 2 px at
 * size 20, 4 at 30, 26 at 77). Integer arithmetic, identical in every port.
 */
function autoDespeckle(size) {
    return Math.floor((2 * size * size + 225) / 450);
}

/** Resolve and validate options; throws on values the pipeline cannot honour. */
function resolveOptions(opts, w, h) {
    const o = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] != null && opts[k] !== 'auto') o[k] = opts[k];
    if (!MODES.includes(o.mode)) {
        throw new Error(`invalid mode: ${o.mode} (expected binary, gray or color)`);
    }
    const auto = o.size == null;
    if (auto) o.size = autoSize(w, h);
    if (!Number.isInteger(o.size) || o.size < 2 || o.size > MAX_SIZE) {
        throw new RangeError(`invalid size: ${o.size} (expected an integer 2..${MAX_SIZE})`);
    }
    if (!(o.weight > 0)) throw new RangeError(`invalid weight: ${o.weight} (expected > 0)`);
    if (o.despeckle == null) o.despeckle = autoDespeckle(o.size);
    if (!Number.isInteger(o.despeckle) || o.despeckle < 0) {
        throw new RangeError(`invalid despeckle: ${o.despeckle} (expected an integer >= 0)`);
    }
    return { ...o, auto };
}

/**
 * Turn 8-connected ink components (fg < thr) smaller than minArea into paper
 * (255), in place. Union-find over runs: each horizontal run of ink is one
 * node, joined to the runs of the row above that touch it (8-connectivity:
 * overlapping once widened by a pixel); a root holds its component's size as
 * a negative number. Components are unique, so the result is the same as any
 * other labelling — a run per node just makes far fewer unions than a pixel
 * per node. Works on any numeric array (the CPU's Float64Array, the GPU's
 * Float32Array).
 */
function despeckle(fg, w, h, thr, minArea) {
    const parent = new Int32Array(w * h);   // at a run's first pixel: parent run, or -size
    const find = i => {
        while (parent[i] >= 0) {
            const p = parent[i];
            if (parent[p] >= 0) parent[i] = parent[p];   // path halving
            i = p;
        }
        return i;
    };
    const union = (a, b) => {
        let ra = find(a), rb = find(b);
        if (ra === rb) return;
        if (parent[ra] > parent[rb]) [ra, rb] = [rb, ra];   // ra = larger
        parent[ra] += parent[rb];
        parent[rb] = ra;
    };
    let above = { start: new Int32Array(w), end: new Int32Array(w), n: 0 };
    let row = { start: new Int32Array(w), end: new Int32Array(w), n: 0 };
    for (let y = 0; y < h; y++) {
        const base = y * w;
        row.n = 0;
        for (let x = 0, k = 0; x < w;) {
            if (fg[base + x] >= thr) { x++; continue; }
            const s = x;
            while (x < w && fg[base + x] < thr) x++;
            parent[base + s] = s - x;                       // a run of x - s pixels
            row.start[row.n] = s;
            row.end[row.n++] = x;
            while (k < above.n && above.end[k] < s) k++;    // ends left of column s - 1
            for (let j = k; j < above.n && above.start[j] <= x; j++) {
                union(base + s, base - w + above.start[j]);
            }
        }
        [above, row] = [row, above];
    }
    for (let y = 0; y < h; y++) {
        const base = y * w;
        for (let x = 0; x < w;) {
            if (fg[base + x] >= thr) { x++; continue; }
            const s = x;
            while (x < w && fg[base + x] < thr) x++;
            if (-parent[find(base + s)] < minArea) fg.fill(255, base + s, base + x);
        }
    }
}

class ZigZag {

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Rec. 601 luma, round-half-up. RGBA bytes → one byte per pixel. */
    static grayImage(rgba, w, h) {
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const o = i * 4;
            gray[i] = Math.floor(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114 + 0.5);
        }
        return gray;
    }

    /** Horizontal rolling sum over [x-r..x+r], zero-padded (truncated window).
     *  The x loop is split where the window enters and leaves the row, so the
     *  inner loops carry no bounds tests; `| 0` keeps the sum an int32. */
    static #hsum(src, dst, w, h, r) {
        const initR = Math.min(r, w - 1);
        const addEnd = Math.max(1, w - r);      // x < addEnd  <=>  x + r < w
        const remBeg = r + 1;                   // x >= remBeg <=>  x - r - 1 >= 0
        for (let y = 0; y < h; y++) {
            const base = y * w;
            let sum = 0;
            for (let x = 0; x <= initR; x++) sum = (sum + src[base + x]) | 0;
            dst[base] = sum;
            let x = 1;
            for (const end = Math.min(addEnd, remBeg); x < end; x++) {       // add only
                sum = (sum + src[base + x + r]) | 0;
                dst[base + x] = sum;
            }
            for (; x < addEnd; x++) {                                        // add and remove
                sum = (sum + src[base + x + r] - src[base + x - r - 1]) | 0;
                dst[base + x] = sum;
            }
            for (; x < remBeg && x < w; x++) dst[base + x] = sum;            // neither
            for (; x < w; x++) {                                             // remove only
                sum = (sum - src[base + x - r - 1]) | 0;
                dst[base + x] = sum;
            }
        }
    }

    /** Vertical rolling sum over [y-r..y+r], zero-padded (truncated window).
     *  Row y is row y-1 plus the row entering the window minus the row
     *  leaving it, so memory is read row by row, sequentially. */
    static #vsum(src, dst, w, h, r) {
        const initB = Math.min(r, h - 1);
        for (let y = 0; y <= initB; y++) {
            const b = y * w;
            for (let x = 0; x < w; x++) dst[x] += src[b + x];
        }
        for (let y = 1; y < h; y++) {
            const o = y * w, p = o - w;
            const add = y + r < h ? (y + r) * w : -1;
            const rem = y - r - 1 >= 0 ? (y - r - 1) * w : -1;
            if (add >= 0 && rem >= 0) for (let x = 0; x < w; x++) dst[o + x] = dst[p + x] + src[add + x] - src[rem + x];
            else if (add >= 0) for (let x = 0; x < w; x++) dst[o + x] = dst[p + x] + src[add + x];
            else if (rem >= 0) for (let x = 0; x < w; x++) dst[o + x] = dst[p + x] - src[rem + x];
            else dst.copyWithin(o, p, o);
        }
    }

    /** 2D box sum (horizontal then vertical pass). The inputs are bytes (gray
     *  levels, 0/1 flags) and the sums integers: exact in any order, half the
     *  memory of doubles, and equal to what a floating-point sum would give.
     *  Bounded by 255 * (2r + 1)^2, which MAX_SIZE keeps inside an Int32. */
    static boxSum(src, w, h, r) {
        const tmp = new Int32Array(w * h);
        const dst = new Int32Array(w * h);
        ZigZag.#hsum(src, tmp, w, h, r);
        ZigZag.#vsum(tmp, dst, w, h, r);
        return dst;
    }

    /** Histogram of the foreground inside a marginPercent crop of the w x h
     *  image. values holds rows y0..y1-1 (the whole image by default), so
     *  bands can be counted separately and their histograms added. */
    static histogram(values, w, h, marginPercent, y0 = 0, y1 = h) {
        const hist = new Uint32Array(256);
        const mw = Math.floor(w * marginPercent / 100);
        const mh = Math.floor(h * marginPercent / 100);
        for (let y = Math.max(mh, y0); y < Math.min(h - mh, y1); y++) {
            for (let x = mw, i = (y - y0) * w + mw; x < w - mw; x++, i++) {
                hist[Math.min(255, Math.max(0, Math.trunc(values[i])))]++;
            }
        }
        return hist;
    }

    /** Standard Otsu, first-maximum tie-break, capped at OTSU_CAP. */
    static otsu(hist) {
        let total = 0, sum = 0;
        for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
        if (total === 0) return 127;
        let sumB = 0, wB = 0, maxVar = -1, thr = 127;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const v = wB * wF * (mB - mF) * (mB - mF);
            if (v > maxVar) { maxVar = v; thr = t; }
        }
        return Math.min(OTSU_CAP, thr);
    }

    /** Center-aligned 2x bilinear upsampling fused with thresholding. At
     *  exactly 2x every output sample sits at -0.25 / +0.25 of a source pixel,
     *  so each source row yields two output rows from constant 0.25 / 0.75
     *  weights — the same samples as #coverage, written as pixels instead of
     *  being counted. Pixels are stored as 32-bit words. */
    static #upsampleBinarize(src, w, h, thr) {
        const W = w * 2;
        const out = new Uint8ClampedArray(W * h * 2 * 4);
        const px = new Uint32Array(out.buffer);
        const rowA = new Float64Array(w);   // y2 = 2y   (sy = y - 0.25)
        const rowB = new Float64Array(w);   // y2 = 2y+1 (sy = y + 0.25)
        for (let y = 0; y < h; y++) {
            const ya = Math.max(0, y - 1) * w, yc = y * w, yb = Math.min(h - 1, y + 1) * w;
            for (let x = 0; x < w; x++) {
                rowA[x] = src[ya + x] * 0.25 + src[yc + x] * 0.75;
                rowB[x] = src[yc + x] * 0.75 + src[yb + x] * 0.25;
            }
            const oa = 2 * y * W, ob = oa + W;
            for (let x = 0; x < w; x++) {
                const xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
                px[oa + 2 * x]     = (rowA[xa] * 0.25 + rowA[x] * 0.75) >= thr ? WHITE : BLACK;
                px[oa + 2 * x + 1] = (rowA[x] * 0.75 + rowA[xb] * 0.25) >= thr ? WHITE : BLACK;
                px[ob + 2 * x]     = (rowB[xa] * 0.25 + rowB[x] * 0.75) >= thr ? WHITE : BLACK;
                px[ob + 2 * x + 1] = (rowB[x] * 0.75 + rowB[xb] * 0.25) >= thr ? WHITE : BLACK;
            }
        }
        return out;
    }

    /** Antialiased cleanup coverage: threshold the 2x-upsampled foreground and
     *  average each 2x2 block back to 1x -> white coverage in {0,.25,.5,.75,1}.
     *  Same center-aligned bilinear samples as #upsampleBinarize, never
     *  materializing the 2x image. */
    static #coverage(src, w, h, thr) {
        const cov = new Float64Array(w * h);
        const rowA = new Float64Array(w);   // y2 = 2y   (sy = y - 0.25)
        const rowB = new Float64Array(w);   // y2 = 2y+1 (sy = y + 0.25)
        for (let y = 0; y < h; y++) {
            const ya = Math.max(0, y - 1) * w, yc = y * w, yb = Math.min(h - 1, y + 1) * w;
            for (let x = 0; x < w; x++) {
                rowA[x] = src[ya + x] * 0.25 + src[yc + x] * 0.75;
                rowB[x] = src[yc + x] * 0.75 + src[yb + x] * 0.25;
            }
            for (let x = 0; x < w; x++) {
                const xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
                const tl = (rowA[xa] * 0.25 + rowA[x] * 0.75) >= thr ? 1 : 0;
                const tr = (rowA[x] * 0.75 + rowA[xb] * 0.25) >= thr ? 1 : 0;
                const bl = (rowB[xa] * 0.25 + rowB[x] * 0.75) >= thr ? 1 : 0;
                const br = (rowB[x] * 0.75 + rowB[xb] * 0.25) >= thr ? 1 : 0;
                cov[yc + x] = (tl + tr + bl + br) * 0.25;
            }
        }
        return cov;
    }

    // ── core pipeline (Algorithm 1 of the paper) ─────────────────────────────

    /**
     * imageData: { data: RGBA bytes, width, height }
     * opts: { mode: 'binary'|'gray'|'color', size, weight, upsample,
     *         thresholdOffset, despeckle }  — size and despeckle null/'auto'
     *         (default) = automatic; offset shifts the auto Otsu threshold;
     *         despeckle 0 keeps every ink speck
     * Returns { data: Uint8ClampedArray (RGBA), width, height, info }.
     */
    static process(imageData, opts = {}) {
        const { width: w, height: h, data: rgba } = imageData;
        const o = resolveOptions(opts, w, h);
        const fg = ZigZag.foreground(rgba, w, h, o.size, o.weight);
        return ZigZag.finish(fg, ZigZag.histogram(fg, w, h, 10), rgba, w, h, o);
    }

    /**
     * Pass A and Pass B: the normalized foreground of rows y0..y1-1 (the whole
     * image by default). A band reads only the rows it needs — Pass B sums at
     * rows y0..y1-1 read the background mask of rows y0-r..y1+r-1, whose
     * Pass A sums read the gray levels of rows y0-2r..y1+2r-1 — so bands can
     * be computed apart (in parallel) and give exactly the whole-image values.
     */
    static foreground(rgba, w, h, size, weight, y0 = 0, y1 = h) {
        const r = Math.floor(size / 2);
        const wf = weight / 100;
        const top = Math.max(0, y0 - 2 * r), bot = Math.min(h, y1 + 2 * r), sh = bot - top;
        const n = w * sh;
        const gray = ZigZag.grayImage(rgba.subarray(top * w * 4, bot * w * 4), w, sh);

        // Pass A — background classification against the weighted local mean
        let sumAll = ZigZag.boxSum(gray, w, sh, r);
        const maskVal = new Uint8Array(n);     // gray value where background, else 0
        const maskCnt = new Uint8Array(n);     // 1 where background, else 0
        const cols = new Int32Array(w);        // pixels of the clamped window, per column
        for (let x = 0; x < w; x++) cols[x] = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
        for (let y = Math.max(top, y0 - r); y < Math.min(bot, y1 + r); y++) {
            const cy = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
            for (let x = 0, i = (y - top) * w; x < w; x++, i++) {
                if (gray[i] >= wf * sumAll[i] / (cols[x] * cy)) {
                    maskVal[i] = gray[i];
                    maskCnt[i] = 1;
                }
            }
        }

        sumAll = null;   // released before Pass B allocates its own sums

        // Pass B — fg = 255 if v >= mean_bg else v*256/mean_bg; all-foreground windows → 255
        const cntBg = ZigZag.boxSum(maskCnt, w, sh, r);
        const sumBg = ZigZag.boxSum(maskVal, w, sh, r);
        const fg = new Float64Array((y1 - y0) * w);
        for (let i = (y0 - top) * w, j = 0; j < fg.length; i++, j++) {
            const cnt = cntBg[i];
            const meanBg = cnt > 0 ? sumBg[i] / cnt : 0;
            const v = gray[i];
            fg[j] = (v >= meanBg || cnt === 0) ? 255 : Math.min(255, v * 256 / Math.max(1, meanBg));
        }
        return fg;
    }

    /**
     * Everything after the foreground: Otsu threshold from its histogram (10 %
     * margin crop) shifted by the offset, despeckle, then the output mode.
     * o: options from resolveOptions. fg is modified (despeckled) in place.
     */
    static finish(fg, hist, rgba, w, h, o) {
        const n = w * h;
        const otsu = ZigZag.otsu(hist);
        const thr = Math.min(255, Math.max(0, otsu + o.thresholdOffset));
        const info = { size: o.size, autoSize: o.auto, weight: o.weight, otsu, threshold: thr, despeckle: o.despeckle };

        // Despeckle: ink components smaller than the area become paper. Done on
        // the 1x foreground, before any output: a removed speck's neighbours are
        // all paper, so every 2x sample around it is paper too, in every mode.
        if (o.despeckle > 1) despeckle(fg, w, h, thr, o.despeckle);

        if (o.mode === 'gray' || o.mode === 'color') {
            // antialiased background cleanup: blend toward white with the 2x2
            // coverage of the thresholded 2x foreground - sharp text, soft cutoff
            const cov = ZigZag.#coverage(fg, w, h, thr);
            const out = new Uint8ClampedArray(n * 4);

            if (o.mode === 'gray') {
                for (let i = 0; i < n; i++) {
                    const v = Math.trunc(Math.min(255, Math.max(0,
                        cov[i] * 255.0 + (1.0 - cov[i]) * fg[i])));
                    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
                    out[i * 4 + 3] = 255;
                }
            } else {
                // luminance-guided: normalize once on luma, re-apply the colors
                const gray = ZigZag.grayImage(rgba, w, h);
                for (let i = 0; i < n; i++) {
                    const p = i * 4;
                    const ratio = fg[i] / Math.max(1, gray[i]);
                    const c = cov[i], k = 1.0 - c;
                    for (let ch = 0; ch < 3; ch++) {
                        const tc = Math.min(255, rgba[p + ch] * ratio);
                        out[p + ch] = Math.trunc(Math.min(255, Math.max(0, c * 255.0 + k * tc)));
                    }
                    out[p + 3] = 255;
                }
            }
            return { data: out, width: w, height: h, info };
        }

        // binary — threshold, 2x upsample by default for detail preservation
        if (o.upsample) {
            const out = ZigZag.#upsampleBinarize(fg, w, h, thr);
            return { data: out, width: w * 2, height: h * 2, info };
        }
        const out = new Uint8ClampedArray(n * 4);
        const px = new Uint32Array(out.buffer);
        for (let i = 0; i < n; i++) px[i] = fg[i] >= thr ? WHITE : BLACK;
        return { data: out, width: w, height: h, info };
    }
}

export { ZigZag, MODES, DEFAULTS, VERSION, autoSize, autoDespeckle, despeckle, resolveOptions };
