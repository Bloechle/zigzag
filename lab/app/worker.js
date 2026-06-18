/*
 * worker.js â€” all the heavy lifting, off the UI thread.
 *
 * The main thread decodes a photo to RGBA once and transfers it here; the
 * worker then answers render/score requests using the verified compute core
 * (zigzag.js + binarizers.js + zqs.js). Results are posted back as transferable
 * RGBA buffers, so painting stays cheap on the main thread.
 *
 * Protocol (main â†’ worker):
 *   {type:'load',   id, rgba, w, h}
 *   {type:'zigzag', id, mode, size, weight, off, max}
 *   {type:'method', id, method, size, weight, off, max}
 *   {type:'scores', id, size, weight, off, scoreMax}
 * (worker â†’ main): 'ready' Â· 'render' Â· 'score' Â· 'scoresDone' Â· 'error'
 */
import { ZigZag } from '../../zigzag.js';
import { METHODS } from './binarizers.js';
import { qualityMetrics } from './zqs.js';

let SRC = null;   // { rgba: Uint8ClampedArray, w, h }

// â”€â”€ area-average downscale (â‰ˆ cv2.INTER_AREA), no-op when already small â”€â”€â”€â”€â”€
function resizeRGBA(rgba, w, h, maxDim) {
    const scale = maxDim / Math.max(w, h);
    if (scale >= 1) return { data: rgba, w, h };
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(nw * nh * 4);
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        for (let x = 0; x < nw; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
            let r = 0, g = 0, b = 0, a = 0, cnt = 0;
            for (let yy = y0; yy < y1 && yy < h; yy++) {
                for (let xx = x0; xx < x1 && xx < w; xx++) {
                    const o = (yy * w + xx) * 4;
                    r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3]; cnt++;
                }
            }
            const o = (y * nw + x) * 4;
            out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt; out[o + 3] = a / cnt;
        }
    }
    return { data: out, w: nw, h: nh };
}

const imageDataOf = (rgba, w, h) => ({ data: rgba, width: w, height: h });

// committee binary (0/255 Uint8) â†’ displayable RGBA
function binaryToRGBA(bin, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const v = bin[i]; const o = i * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
    return out;
}

function runZigzag({ mode, size, weight, off, max }) {
    const { data, w, h } = resizeRGBA(SRC.rgba, SRC.w, SRC.h, max);
    const res = ZigZag.process(imageDataOf(data, w, h),
        { mode, size, weight, thresholdOffset: off, upsample: mode === 'binary' });
    return res;   // { data: Uint8ClampedArray RGBA, width, height, info }
}

// one committee method â†’ { binary Uint8, rgba, w, h }
function runMethod(name, gray, w, h) {
    const bin = METHODS[name](gray, w, h);
    return { bin, rgba: binaryToRGBA(bin, w, h), w, h };
}

let scoreId = 0;

async function runScores(msg) {
    const myId = msg.id;
    const { data, w, h } = resizeRGBA(SRC.rgba, SRC.w, SRC.h, msg.scoreMax);
    const gray = ZigZag.grayImage(data, w, h);
    const order = ['zigzag', ...Object.keys(METHODS)];   // ZigZag scored among the committee
    for (const name of order) {
        if (myId !== scoreId) return;                    // a newer request superseded this one
        const t0 = performance.now();
        let bin, rgba;
        if (name === 'zigzag') {
            const res = ZigZag.process(imageDataOf(data, w, h),
                { mode: 'binary', size: msg.size, weight: msg.weight, thresholdOffset: msg.off, upsample: false });
            rgba = res.data;
            bin = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) bin[i] = rgba[i * 4];   // R channel = 0/255
        } else {
            const r = runMethod(name, gray, w, h); bin = r.bin; rgba = r.rgba;
        }
        const qm = qualityMetrics(gray, bin, w, h);
        const ms = performance.now() - t0;
        self.postMessage({ type: 'score', id: myId, method: name, zqs: qm.zqs,
            profile: qm, ms, data: rgba.buffer, width: w, height: h }, [rgba.buffer]);
        await new Promise(r => setTimeout(r, 0));        // yield â†’ let a newer 'scores' bump scoreId
    }
    if (myId === scoreId) self.postMessage({ type: 'scoresDone', id: myId });
}

self.onmessage = ({ data: msg }) => {
    try {
        if (msg.type === 'load') {
            SRC = { rgba: new Uint8ClampedArray(msg.rgba), w: msg.w, h: msg.h };
            self.postMessage({ type: 'ready', id: msg.id });
            return;
        }
        if (!SRC) return;

        if (msg.type === 'zigzag') {
            const res = runZigzag(msg);
            const buf = res.data.buffer;
            self.postMessage({ type: 'render', id: msg.id, data: buf,
                width: res.width, height: res.height, info: res.info }, [buf]);
            return;
        }

        if (msg.type === 'method') {
            const { data, w, h } = resizeRGBA(SRC.rgba, SRC.w, SRC.h, msg.max);
            if (msg.method === 'zigzag') {
                const res = ZigZag.process(imageDataOf(data, w, h),
                    { mode: 'binary', size: msg.size, weight: msg.weight, thresholdOffset: msg.off, upsample: true });
                const buf = res.data.buffer;
                self.postMessage({ type: 'render', id: msg.id, data: buf, width: res.width, height: res.height }, [buf]);
                return;
            }
            const gray = ZigZag.grayImage(data, w, h);
            const { rgba } = runMethod(msg.method, gray, w, h);
            self.postMessage({ type: 'render', id: msg.id, data: rgba.buffer, width: w, height: h }, [rgba.buffer]);
            return;
        }

        if (msg.type === 'scores') { scoreId = msg.id; runScores(msg); return; }
    } catch (e) {
        self.postMessage({ type: 'error', id: msg && msg.id, message: String(e && e.stack || e) });
    }
};
