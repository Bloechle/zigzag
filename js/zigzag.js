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
 * single global Otsu threshold.
 *
 * Dependency-free ES module, separable rolling sums (O(n)), float64.
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 *
 * Usage (browser or Node):
 *   import { ZigZag } from './zigzag.js';
 *   const { data, width, height, info } = ZigZag.process(imageData, { mode: 'binary' });
 */

const OTSU_CAP = 250;
const MODES = ['binary', 'gray', 'color'];

class ZigZag {

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Rec. 601 luma, round-half-up. RGBA bytes → Float64Array. */
    static grayImage(rgba, w, h) {
        const gray = new Float64Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const o = i * 4;
            gray[i] = Math.floor(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114 + 0.5);
        }
        return gray;
    }

    /** Horizontal rolling sum over [x-r..x+r], zero-padded (truncated window). */
    static #hsum(src, dst, w, h, r) {
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

    /** Vertical rolling sum over [y-r..y+r], zero-padded (truncated window). */
    static #vsum(src, dst, w, h, r) {
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

    /** 2D box sum (horizontal then vertical pass). */
    static boxSum(src, w, h, r) {
        const tmp = new Float64Array(w * h);
        const dst = new Float64Array(w * h);
        ZigZag.#hsum(src, tmp, w, h, r);
        ZigZag.#vsum(tmp, dst, w, h, r);
        return dst;
    }

    static histogram(values, w, h, marginPercent) {
        const hist = new Uint32Array(256);
        const mw = Math.floor(w * marginPercent / 100);
        const mh = Math.floor(h * marginPercent / 100);
        for (let y = mh; y < h - mh; y++) {
            for (let x = mw; x < w - mw; x++) {
                hist[Math.min(255, Math.max(0, Math.trunc(values[y * w + x])))]++;
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

    /** Center-aligned 2x bilinear upsampling fused with thresholding:
     *  vertical interpolation pass, then the horizontal pass writes the
     *  binary RGBA pixels directly (no full-resolution float buffer). */
    static #upsampleBinarize(src, w, h, thr) {
        const W = w * 2, H = h * 2;
        const rows = new Float64Array(H * w);
        for (let y2 = 0; y2 < H; y2++) {
            const sy = (y2 + 0.5) * 0.5 - 0.5;
            const y0 = Math.floor(sy);
            const fy = sy - y0;
            const ya = Math.min(h - 1, Math.max(0, y0)) * w;
            const yb = Math.min(h - 1, Math.max(0, y0 + 1)) * w;
            const base = y2 * w;
            for (let x = 0; x < w; x++) {
                rows[base + x] = src[ya + x] * (1 - fy) + src[yb + x] * fy;
            }
        }
        const out = new Uint8ClampedArray(H * W * 4);
        for (let y2 = 0; y2 < H; y2++) {
            const base = y2 * w;
            let o = y2 * W * 4;
            for (let x2 = 0; x2 < W; x2++, o += 4) {
                const sx = (x2 + 0.5) * 0.5 - 0.5;
                const x0 = Math.floor(sx);
                const fx = sx - x0;
                const xa = Math.min(w - 1, Math.max(0, x0));
                const xb = Math.min(w - 1, Math.max(0, x0 + 1));
                const v = (rows[base + xa] * (1 - fx) + rows[base + xb] * fx) >= thr ? 255 : 0;
                out[o] = out[o + 1] = out[o + 2] = v;
                out[o + 3] = 255;
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
     *         thresholdOffset }  — offset shifts the auto Otsu threshold (0 = auto)
     * Returns { data: Uint8ClampedArray (RGBA), width, height, info }.
     */
    static process(imageData, opts = {}) {
        const { width: w, height: h } = imageData;
        const rgba = imageData.data;
        const mode = opts.mode ?? 'binary';
        if (!MODES.includes(mode)) {
            throw new Error(`invalid mode: ${mode} (expected binary, gray or color)`);
        }
        const size = opts.size ?? 30;
        const weight = opts.weight ?? 90;
        const upsample = opts.upsample ?? true;
        const offset = opts.thresholdOffset ?? 0;   // manual shift of the auto threshold

        const r = Math.floor(size / 2);
        const wf = weight / 100;
        const n = w * h;
        const gray = ZigZag.grayImage(rgba, w, h);

        // Pass A — background classification against the weighted local mean
        let sumAll = ZigZag.boxSum(gray, w, h, r);
        const maskVal = new Float64Array(n);   // gray value where background, else 0
        const maskCnt = new Float64Array(n);   // 1 where background, else 0
        for (let y = 0; y < h; y++) {
            const cy = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                const cx = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
                if (gray[i] >= wf * sumAll[i] / (cx * cy)) {
                    maskVal[i] = gray[i];
                    maskCnt[i] = 1;
                }
            }
        }

        sumAll = null;   // released before Pass B allocates its own sums

        // Pass B — normalization against the local mean of background-only pixels
        const cntBg = ZigZag.boxSum(maskCnt, w, h, r);

        const normalize = (channel, masked) => {
            const sumBg = ZigZag.boxSum(masked, w, h, r);
            const fg = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                const meanBg = cntBg[i] > 0.5 ? sumBg[i] / cntBg[i] : 0;
                const v = channel[i];
                fg[i] = (v >= meanBg || cntBg[i] < 0.5)
                    ? 255
                    : Math.min(255, v * 256 / Math.max(1, meanBg));
            }
            return fg;
        };

        const info = { size, weight, otsu: null, threshold: null };

        const fg = normalize(gray, maskVal);

        // Otsu threshold on the foreground histogram (10% margin crop),
        // optionally shifted by the manual offset
        const otsu = ZigZag.otsu(ZigZag.histogram(fg, w, h, 10));
        const thr = Math.min(255, Math.max(0, otsu + offset));
        info.otsu = otsu;
        info.threshold = thr;

        if (mode === 'gray' || mode === 'color') {
            // antialiased background cleanup: blend toward white with the 2x2
            // coverage of the thresholded 2x foreground - sharp text, soft cutoff
            const cov = ZigZag.#coverage(fg, w, h, thr);
            const out = new Uint8ClampedArray(n * 4);

            if (mode === 'gray') {
                for (let i = 0; i < n; i++) {
                    const v = Math.trunc(Math.min(255, Math.max(0,
                        cov[i] * 255.0 + (1.0 - cov[i]) * fg[i])));
                    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
                    out[i * 4 + 3] = 255;
                }
            } else {
                // luminance-guided: normalize once on luma, re-apply the colors
                for (let i = 0; i < n; i++) {
                    const o = i * 4;
                    const ratio = fg[i] / Math.max(1, gray[i]);
                    const c = cov[i], k = 1.0 - c;
                    for (let ch = 0; ch < 3; ch++) {
                        const tc = Math.min(255, rgba[o + ch] * ratio);
                        out[o + ch] = Math.trunc(Math.min(255, Math.max(0, c * 255.0 + k * tc)));
                    }
                    out[o + 3] = 255;
                }
            }
            return { data: out, width: w, height: h, info };
        }

        // binary — threshold, 2x upsample by default for detail preservation
        if (upsample) {
            const out = ZigZag.#upsampleBinarize(fg, w, h, thr);
            return { data: out, width: w * 2, height: h * 2, info };
        }
        const out = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) {
            const v = fg[i] >= thr ? 255 : 0;
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
            out[i * 4 + 3] = 255;
        }
        return { data: out, width: w, height: h, info };
    }
}

export { ZigZag };
