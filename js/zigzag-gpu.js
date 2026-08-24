/*
 * zigzag-gpu.js - optional WebGPU accelerator for ZigZag.
 *
 * Same pipeline as zigzag.js (the CPU port), executed as WGSL
 * compute shaders: typically 10-50 ms where the CPU takes ~1 s. Arithmetic
 * is float32 (WebGPU has no f64), so a handful of boundary pixels may differ
 * from the CPU output by +/-1 gray level - visually identical.
 *
 * The foreground only depends on (size, weight): switching the output mode
 * or toggling the 2x upsample reuses the cached foreground buffer, making
 * mode changes near-instant.
 *
 * Imports zigzag.js for the Otsu threshold only, so the two backends can
 * never silently diverge on it.
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 *
 * Usage:
 *   import { ZigZagGPU } from './zigzag-gpu.js';
 *   if (ZigZagGPU.isSupported()) {
 *       const gpu = new ZigZagGPU();
 *       await gpu.init();                      // throws if no adapter
 *       gpu.maxPixels;                         // largest image this device accepts
 *       await gpu.uploadImage(imageData);      // once per image
 *       const res = await gpu.process({ mode: 'binary', size: 30, weight: 90 });
 *       // res: { data: Uint8ClampedArray (RGBA), width, height, info }
 *   }
 */

import { ZigZag, MODES } from './zigzag.js';

// ─── Params struct (32 bytes, 16-byte aligned) ──────────────────────────────

const PARAMS = `
struct Params {
    width:     u32,
    height:    u32,
    half_size: u32,
    weight:    f32,
    threshold: f32,
    margin:    u32,
    out_w:     u32,
    out_h:     u32,
}`;

// ═════════════════════════════════════════════════════════════════════════════
// SHADERS
// ═════════════════════════════════════════════════════════════════════════════

/** Rec. 601 luma, round-half-up — identical to the CPU ports. */
const SH_GRAYSCALE = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       input : array<u32>;
@group(0) @binding(1) var<storage, read_write> gray  : array<f32>;
@group(0) @binding(2) var<uniform>             p     : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let i = y * p.width + x;
    let rgba = input[i];
    let r = f32( rgba        & 0xFFu);
    let g = f32((rgba >> 8u) & 0xFFu);
    let b = f32((rgba >> 16u)& 0xFFu);
    gray[i] = floor(r * 0.299 + g * 0.587 + b * 0.114 + 0.5);
}`;

/** Horizontal rolling sum over [x-r..x+r], zero-padded (one thread per row). */
const SH_HSUM = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;
@group(0) @binding(2) var<uniform>             p   : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let row = gid.x;
    if (row >= p.height) { return; }
    let hs = i32(p.half_size);
    let w  = i32(p.width);
    let base = row * p.width;
    var sum : f32 = 0.0;
    let initR = min(hs, w - 1);
    for (var ix = 0; ix <= initR; ix++) { sum += src[base + u32(ix)]; }
    dst[base] = sum;
    for (var x = 1; x < w; x++) {
        let addX = x + hs;
        let remX = x - hs - 1;
        if (addX < w)  { sum += src[base + u32(addX)]; }
        if (remX >= 0) { sum -= src[base + u32(remX)]; }
        dst[base + u32(x)] = sum;
    }
}`;

/** Vertical rolling sum over [y-r..y+r], zero-padded (one thread per column). */
const SH_VSUM = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;
@group(0) @binding(2) var<uniform>             p   : Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let col = gid.x;
    if (col >= p.width) { return; }
    let hs = i32(p.half_size);
    let h  = i32(p.height);
    let w  = p.width;
    var sum : f32 = 0.0;
    let initB = min(hs, h - 1);
    for (var iy = 0; iy <= initB; iy++) { sum += src[u32(iy) * w + col]; }
    dst[col] = sum;
    for (var y = 1; y < h; y++) {
        let addY = y + hs;
        let remY = y - hs - 1;
        if (addY < h)  { sum += src[u32(addY) * w + col]; }
        if (remY >= 0) { sum -= src[u32(remY) * w + col]; }
        dst[u32(y) * w + col] = sum;
    }
}`;

/** Pass A — background classification against the weighted local mean. */
const SH_MASK = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       gray    : array<f32>;
@group(0) @binding(1) var<storage, read>       sumAll  : array<f32>;
@group(0) @binding(2) var<storage, read_write> maskVal : array<f32>;
@group(0) @binding(3) var<storage, read_write> maskCnt : array<f32>;
@group(0) @binding(4) var<uniform>             p       : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let idx = y * p.width + x;
    let hs  = i32(p.half_size);
    let ix  = i32(x);  let iy = i32(y);
    let w   = i32(p.width);  let h = i32(p.height);
    let cntX = f32(min(w - 1, ix + hs) - max(0, ix - hs) + 1);
    let cntY = f32(min(h - 1, iy + hs) - max(0, iy - hs) + 1);
    let mean = p.weight * sumAll[idx] / (cntX * cntY);
    let val  = gray[idx];
    if (val >= mean) {
        maskVal[idx] = val;
        maskCnt[idx] = 1.0;
    } else {
        maskVal[idx] = 0.0;
        maskCnt[idx] = 0.0;
    }
}`;

/** Pass B — normalization against the local mean of background-only pixels. */
const SH_FOREGROUND = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       gray  : array<f32>;
@group(0) @binding(1) var<storage, read>       sumBg : array<f32>;
@group(0) @binding(2) var<storage, read>       cntBg : array<f32>;
@group(0) @binding(3) var<storage, read_write> fg    : array<f32>;
@group(0) @binding(4) var<uniform>             p     : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let idx = y * p.width + x;
    let cnt = cntBg[idx];
    if (cnt < 0.5) {
        fg[idx] = 255.0;                       // all-foreground window
        return;
    }
    let mean_bg = sumBg[idx] / cnt;
    let val = gray[idx];
    if (val >= mean_bg) {
        fg[idx] = 255.0;
    } else {
        fg[idx] = min(255.0, val * 256.0 / max(1.0, mean_bg));
    }
}`;

/** Foreground histogram with border margin (atomic bins). */
const SH_HISTOGRAM = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       fg   : array<f32>;
@group(0) @binding(1) var<storage, read_write> hist : array<atomic<u32>>;
@group(0) @binding(2) var<uniform>             p    : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let mw = p.width  * p.margin / 100u;
    let mh = p.height * p.margin / 100u;
    if (x < mw || x >= p.width - mw || y < mh || y >= p.height - mh) { return; }
    let i = y * p.width + x;
    let val = u32(clamp(fg[i], 0.0, 255.0));
    atomicAdd(&hist[val], 1u);
}`;

/** Center-aligned 2x bilinear upsampling of the foreground. */
const SH_UPSAMPLE = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;
@group(0) @binding(2) var<uniform>             p   : Params;

fn sample(x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(p.width) - 1);
    let cy = clamp(y, 0, i32(p.height) - 1);
    return src[u32(cy) * p.width + u32(cx)];
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let ox = gid.x;  let oy = gid.y;
    if (ox >= p.out_w || oy >= p.out_h) { return; }
    let sx = (f32(ox) + 0.5) * 0.5 - 0.5;
    let sy = (f32(oy) + 0.5) * 0.5 - 0.5;
    let x0 = i32(floor(sx));  let y0 = i32(floor(sy));
    let fx = sx - f32(x0);    let fy = sy - f32(y0);
    let top    = sample(x0, y0)     * (1.0 - fx) + sample(x0 + 1, y0)     * fx;
    let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
    dst[oy * p.out_w + ox] = top * (1.0 - fy) + bottom * fy;
}`;

/** Binary thresholding to RGBA (works at 1x or 2x via out_w/out_h). */
const SH_BINARIZE = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       fg  : array<f32>;
@group(0) @binding(1) var<storage, read_write> out : array<u32>;
@group(0) @binding(2) var<uniform>             p   : Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.out_w || y >= p.out_h) { return; }
    let i = y * p.out_w + x;
    let v = select(0u, 255u, fg[i] >= p.threshold);
    out[i] = v | (v << 8u) | (v << 16u) | (0xFFu << 24u);
}`;

/** Antialiased white-cleanup coverage, shared by the gray and color shaders:
 *  the four 2x bilinear subsamples of the pixel (offsets +/-0.25) are
 *  thresholded and averaged -> coverage in {0,.25,.5,.75,1}. Mirrors the
 *  CPU coverage() exactly. */
const WGSL_COVERAGE = `
fn fgAt(x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(p.width) - 1);
    let cy = clamp(y, 0, i32(p.height) - 1);
    return fg[u32(cy) * p.width + u32(cx)];
}

fn coverage(ix: i32, iy: i32, thr: f32) -> f32 {
    let xm = ix - 1;  let xp = ix + 1;
    let ym = iy - 1;  let yp = iy + 1;
    let rowA_m = fgAt(xm, ym) * 0.25 + fgAt(xm, iy) * 0.75;
    let rowA_0 = fgAt(ix, ym) * 0.25 + fgAt(ix, iy) * 0.75;
    let rowA_p = fgAt(xp, ym) * 0.25 + fgAt(xp, iy) * 0.75;
    let rowB_m = fgAt(xm, iy) * 0.75 + fgAt(xm, yp) * 0.25;
    let rowB_0 = fgAt(ix, iy) * 0.75 + fgAt(ix, yp) * 0.25;
    let rowB_p = fgAt(xp, iy) * 0.75 + fgAt(xp, yp) * 0.25;
    let tl = select(0.0, 1.0, (rowA_m * 0.25 + rowA_0 * 0.75) >= thr);
    let tr = select(0.0, 1.0, (rowA_0 * 0.75 + rowA_p * 0.25) >= thr);
    let bl = select(0.0, 1.0, (rowB_m * 0.25 + rowB_0 * 0.75) >= thr);
    let br = select(0.0, 1.0, (rowB_0 * 0.75 + rowB_p * 0.25) >= thr);
    return (tl + tr + bl + br) * 0.25;
}`;

/** Gray output: normalized foreground blended toward white by the coverage. */
const SH_GRAY_OUT = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       fg  : array<f32>;
@group(0) @binding(1) var<storage, read_write> out : array<u32>;
@group(0) @binding(2) var<uniform>             p   : Params;
${WGSL_COVERAGE}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let i = y * p.width + x;
    let cov = coverage(i32(x), i32(y), p.threshold);
    let v = u32(clamp(cov * 255.0 + (1.0 - cov) * fg[i], 0.0, 255.0));
    out[i] = v | (v << 8u) | (v << 16u) | (0xFFu << 24u);
}`;

/** Color output: luminance-guided (ratio fg/gray on every channel), then the
 *  same antialiased white blend as gray mode. */
const SH_COLOR_OUT = `
${PARAMS}
@group(0) @binding(0) var<storage, read>       input : array<u32>;
@group(0) @binding(1) var<storage, read>       gray  : array<f32>;
@group(0) @binding(2) var<storage, read>       fg    : array<f32>;
@group(0) @binding(3) var<storage, read_write> out   : array<u32>;
@group(0) @binding(4) var<uniform>             p     : Params;
${WGSL_COVERAGE}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let x = gid.x;  let y = gid.y;
    if (x >= p.width || y >= p.height) { return; }
    let idx = y * p.width + x;
    let cov = coverage(i32(x), i32(y), p.threshold);
    let k = 1.0 - cov;
    let ratio = fg[idx] / max(1.0, gray[idx]);
    let rgba = input[idx];
    let tr = min(255.0, f32( rgba        & 0xFFu) * ratio);
    let tg = min(255.0, f32((rgba >> 8u) & 0xFFu) * ratio);
    let tb = min(255.0, f32((rgba >> 16u)& 0xFFu) * ratio);
    let r = u32(clamp(cov * 255.0 + k * tr, 0.0, 255.0));
    let g = u32(clamp(cov * 255.0 + k * tg, 0.0, 255.0));
    let b = u32(clamp(cov * 255.0 + k * tb, 0.0, 255.0));
    out[idx] = r | (g << 8u) | (b << 16u) | (0xFFu << 24u);
}`;

// ═════════════════════════════════════════════════════════════════════════════
// ZigZagGPU class
// ═════════════════════════════════════════════════════════════════════════════

export class ZigZagGPU {
    #device    = null;
    #pipes     = {};
    #bufs      = {};
    #curSize   = 0;
    #imgWidth  = 0;
    #imgHeight = 0;
    #fgKey     = null;     // "size:weight" of the cached foreground buffer
    #otsu      = 127;      // threshold matching the cached foreground
    #maxPixels = 0;        // largest image the device limits allow

    static isSupported() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

    /** Largest image (in pixels) this device can process — the 2x buffers are
     *  16 bytes/pixel, and the default WebGPU storage binding limit is 128 MiB,
     *  i.e. only ~8.4 MP unless the adapter allows more (it usually does). */
    get maxPixels() { return this.#maxPixels; }

    async init() {
        if (!ZigZagGPU.isSupported()) throw new Error('WebGPU not supported');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No GPU adapter found');

        const keys = ['maxStorageBufferBindingSize', 'maxBufferSize'];
        const requiredLimits = Object.fromEntries(keys.map(k => [k, adapter.limits[k]]));
        this.#device = await adapter.requestDevice({ requiredLimits });

        const L = this.#device.limits;
        this.#maxPixels = Math.floor(Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) / 16);
        this.#createPipelines();
    }

    /** Upload an image (RGBA ImageData-like) and compute its grayscale. */
    async uploadImage(imageData) {
        const { width, height } = imageData;
        const n = width * height;
        if (n > this.#maxPixels) {
            throw new Error(`Image too large for this GPU (${n} > ${this.#maxPixels} px)`);
        }
        await this.#guard(() => {
            this.#ensureBuffers(n);
            this.#imgWidth  = width;
            this.#imgHeight = height;
            this.#fgKey = null;

            const pixels = new Uint32Array(imageData.data.buffer, imageData.data.byteOffset, n);
            this.#device.queue.writeBuffer(this.#bufs.input, 0, pixels);
            this.#writeParams(width, height, 0, 0, 0, 0, width, height);

            const enc = this.#device.createCommandEncoder();
            this.#dispatchWith(enc, 'grayscale', [
                [0, this.#bufs.input], [1, this.#bufs.gray], [2, this.#bufs.params]
            ], [Math.ceil(width / 16), Math.ceil(height / 16)]);
            this.#device.queue.submit([enc.finish()]);
        });
    }

    /**
     * Run the pipeline. The foreground (and its Otsu threshold) is cached:
     * calling again with the same size/weight only re-runs the output stage.
     * Returns { data, width, height, info } like ZigZag.process().
     *
     * Single-flight: one staging buffer is mapped per call, so the returned
     * promise must settle before process() is called again.
     */
    async process(opts = {}) {
        if (!this.#imgWidth) throw new Error('Call uploadImage() first');
        const mode = opts.mode ?? 'binary';
        if (!MODES.includes(mode)) {
            throw new Error(`invalid mode: ${mode} (expected binary, gray or color)`);
        }
        const size = opts.size ?? 30;
        const weight = opts.weight ?? 90;
        const upsample = opts.upsample ?? true;
        const offset = opts.thresholdOffset ?? 0;   // manual shift of the auto threshold

        const w = this.#imgWidth, h = this.#imgHeight;
        const B = this.#bufs;
        const key = size + ':' + weight;

        if (this.#fgKey !== key) {
            await this.#computeForeground(w, h, size, weight);
            this.#fgKey = key;
        }
        const thr = Math.min(255, Math.max(0, this.#otsu + offset));
        const info = { size, weight, otsu: this.#otsu, threshold: thr };

        // ─── output stage ───
        const is2x = mode === 'binary' && upsample;
        const outW = is2x ? w * 2 : w, outH = is2x ? h * 2 : h;
        this.#writeParams(w, h, 0, 0, thr, 10, outW, outH);

        const readBytes = outW * outH * 4;
        await this.#guard(() => {
            const enc = this.#device.createCommandEncoder();
            const xyDisp = [Math.ceil(w / 16), Math.ceil(h / 16)];
            const outDisp = [Math.ceil(outW / 16), Math.ceil(outH / 16)];

            if (mode === 'gray') {
                this.#dispatchWith(enc, 'grayOut',
                    [[0, B.foreground], [1, B.output], [2, B.params]], xyDisp);
            } else if (mode === 'color') {
                this.#dispatchWith(enc, 'colorOut', [
                    [0, B.input], [1, B.gray], [2, B.foreground], [3, B.output], [4, B.params]
                ], xyDisp);
            } else if (is2x) {
                this.#dispatchWith(enc, 'upsample',
                    [[0, B.foreground], [1, B.upsampled], [2, B.params]], outDisp);
                this.#dispatchWith(enc, 'binarize',
                    [[0, B.upsampled], [1, B.output], [2, B.params]], outDisp);
            } else {
                this.#dispatchWith(enc, 'binarize',
                    [[0, B.foreground], [1, B.output], [2, B.params]], outDisp);
            }

            enc.copyBufferToBuffer(B.output, 0, B.outStaging, 0, readBytes);
            this.#device.queue.submit([enc.finish()]);
        });

        await B.outStaging.mapAsync(GPUMapMode.READ, 0, readBytes);
        const data = new Uint8ClampedArray(B.outStaging.getMappedRange(0, readBytes).slice(0));
        B.outStaging.unmap();

        return { data, width: outW, height: outH, info };
    }

    /** Submit 1: Pass A + Pass B + histogram readback -> Otsu threshold. */
    async #computeForeground(w, h, size, weight) {
        const B = this.#bufs;
        const hs = Math.floor(size / 2);
        const wf = weight / 100;
        this.#writeParams(w, h, hs, wf, 0, 10, w, h);
        this.#device.queue.writeBuffer(B.histogram, 0, new Uint32Array(256));

        await this.#guard(() => {
            const enc = this.#device.createCommandEncoder();
            const hDisp = [Math.ceil(h / 256)];
            const vDisp = [Math.ceil(w / 256)];
            const xyDisp = [Math.ceil(w / 16), Math.ceil(h / 16)];

            // Pass A: sumAll -> mask
            this.#dispatchWith(enc, 'hsum', [[0, B.gray], [1, B.hTemp], [2, B.params]], hDisp);
            this.#dispatchWith(enc, 'vsum', [[0, B.hTemp], [1, B.sumAll], [2, B.params]], vDisp);
            this.#dispatchWith(enc, 'mask', [
                [0, B.gray], [1, B.sumAll], [2, B.maskVal], [3, B.maskCnt], [4, B.params]
            ], xyDisp);

            // Pass B: masked sums -> foreground
            this.#dispatchWith(enc, 'hsum', [[0, B.maskVal], [1, B.hTemp], [2, B.params]], hDisp);
            this.#dispatchWith(enc, 'vsum', [[0, B.hTemp], [1, B.sumBg], [2, B.params]], vDisp);
            this.#dispatchWith(enc, 'hsum', [[0, B.maskCnt], [1, B.hTemp], [2, B.params]], hDisp);
            this.#dispatchWith(enc, 'vsum', [[0, B.hTemp], [1, B.cntBg], [2, B.params]], vDisp);
            this.#dispatchWith(enc, 'foreground', [
                [0, B.gray], [1, B.sumBg], [2, B.cntBg], [3, B.foreground], [4, B.params]
            ], xyDisp);

            // Histogram + readback
            this.#dispatchWith(enc, 'histogram', [
                [0, B.foreground], [1, B.histogram], [2, B.params]
            ], xyDisp);
            enc.copyBufferToBuffer(B.histogram, 0, B.histStaging, 0, 256 * 4);
            this.#device.queue.submit([enc.finish()]);
        });

        await B.histStaging.mapAsync(GPUMapMode.READ);
        const hist = new Uint32Array(B.histStaging.getMappedRange().slice(0));
        B.histStaging.unmap();
        this.#otsu = ZigZag.otsu(hist);   // shared with the CPU port — never diverges
    }

    destroy() {
        for (const b of Object.values(this.#bufs)) b?.destroy?.();
        this.#bufs = {};
        this.#curSize = 0;
        this.#imgWidth = 0;
        this.#fgKey = null;
    }

    // ═══ Private infrastructure ═════════════════════════════════════════════

    #createPipelines() {
        const make = (code) => this.#device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.#device.createShaderModule({ code }), entryPoint: 'main' },
        });
        this.#pipes.grayscale  = make(SH_GRAYSCALE);
        this.#pipes.hsum       = make(SH_HSUM);
        this.#pipes.vsum       = make(SH_VSUM);
        this.#pipes.mask       = make(SH_MASK);
        this.#pipes.foreground = make(SH_FOREGROUND);
        this.#pipes.histogram  = make(SH_HISTOGRAM);
        this.#pipes.upsample   = make(SH_UPSAMPLE);
        this.#pipes.binarize   = make(SH_BINARIZE);
        this.#pipes.grayOut    = make(SH_GRAY_OUT);
        this.#pipes.colorOut   = make(SH_COLOR_OUT);
    }

    #ensureBuffers(n) {
        if (n === this.#curSize) return;
        this.destroy();
        this.#curSize = n;
        const dev = this.#device;
        const buf = (size, usage) => dev.createBuffer({ size, usage });
        const S = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC;
        const CD = GPUBufferUsage.COPY_DST, MR = GPUBufferUsage.MAP_READ;
        const nb = n * 4, nb4 = n * 4 * 4;

        this.#bufs.input       = buf(nb,      S | CD);
        this.#bufs.gray        = buf(nb,      S);
        this.#bufs.hTemp       = buf(nb,      S);
        this.#bufs.sumAll      = buf(nb,      S);
        this.#bufs.maskVal     = buf(nb,      S);
        this.#bufs.maskCnt     = buf(nb,      S);
        this.#bufs.sumBg       = buf(nb,      S);
        this.#bufs.cntBg       = buf(nb,      S);
        this.#bufs.foreground  = buf(nb,      S);
        this.#bufs.upsampled   = buf(nb4,     S);
        this.#bufs.histogram   = buf(256 * 4, S | CD | CS);
        this.#bufs.output      = buf(nb4,     S | CS);
        this.#bufs.params      = buf(32,      GPUBufferUsage.UNIFORM | CD);
        this.#bufs.histStaging = buf(256 * 4, MR | CD);
        this.#bufs.outStaging  = buf(nb4,     MR | CD);
    }

    #writeParams(w, h, halfSize, weight, threshold, margin, outW, outH) {
        const ab = new ArrayBuffer(32);
        const u = new Uint32Array(ab), f = new Float32Array(ab);
        u[0] = w; u[1] = h; u[2] = halfSize;
        f[3] = weight; f[4] = threshold;
        u[5] = margin; u[6] = outW; u[7] = outH;
        this.#device.queue.writeBuffer(this.#bufs.params, 0, ab);
    }

    #dispatchWith(encoder, pipeKey, entries, workgroups) {
        const pipe = this.#pipes[pipeKey];
        const bg = this.#device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(...workgroups);
        pass.end();
    }

    /** WebGPU reports most validation errors asynchronously instead of throwing,
     *  so encode/submit under an error scope and surface failures as exceptions —
     *  that is what lets the caller fall back to the CPU port. */
    async #guard(fn) {
        this.#device.pushErrorScope('validation');
        fn();
        const err = await this.#device.popErrorScope();
        if (err) throw new Error('WebGPU: ' + err.message);
    }
}
