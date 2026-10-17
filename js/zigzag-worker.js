/*
 * zigzag-worker.js — runs the CPU port off the main thread, on every core.
 *
 * The page talks to one worker, the coordinator. It keeps the source image, so
 * each run only ships the options across, and the result is transferred back
 * rather than copied:
 *
 *   worker.postMessage({ image: { data, width, height } }, [data.buffer]);
 *   worker.postMessage({ id, opts });   // -> { id, data, width, height, info }
 *   worker.postMessage({ image: null });               // release it
 *
 * For a large image the coordinator splits the heavy half of the pipeline —
 * gray levels, box sums, Pass A, Pass B — into bands of rows, one per core: it
 * starts helper workers (this same file, sent { band } messages instead) and
 * computes one band itself. ZigZag.foreground gives a band exactly the
 * whole-image values, so the result is bit-identical to ZigZag.process. The
 * rest — Otsu, despeckle (connected components span bands), output — runs here.
 *
 * Helpers keep nothing: each band ships only the rows it reads (its own plus a
 * 2r margin, ZigZag.bandRows), transferred, so no helper holds a copy of the
 * image between runs.
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 */

import { ZigZag, resolveOptions } from './zigzag.js';

const PARALLEL_MIN_PIXELS = 1_000_000;   // below this, starting the bands costs more than it saves

let source = null;
let helpers = null;                      // started on the first large run; [] when unavailable
let jobs = 0;
const pending = new Map();               // band job -> { resolve, reject }

self.onmessage = ({ data: msg }) => {
    if ('band' in msg) return runBand(msg.band);          // helper role
    if ('image' in msg) return setImage(msg.image);
    run(msg).catch(err => self.postMessage({ id: msg.id, error: String(err?.message ?? err) }));
};

/** Helper: the foreground of one band, and its histogram. */
function runBand({ job, rows, top, w, h, y0, y1, size, weight }) {
    const fg = ZigZag.foreground(rows, w, h, size, weight, y0, y1, top);
    const hist = ZigZag.histogram(fg, w, h, 10, y0, y1);
    self.postMessage({ done: job, fg, hist }, [fg.buffer]);
}

function setImage(image) {
    source = image;
    if (!image) stopHelpers(null);                        // released: start afresh next time
}

async function run({ id, opts }) {
    const image = source;
    if (!image) throw new Error('no source image');
    const out = image.width * image.height >= PARALLEL_MIN_PIXELS && startHelpers().length
        ? await parallel(image, opts).catch(() => ZigZag.process(image, opts))   // a helper failed
        : ZigZag.process(image, opts);
    self.postMessage({ id, ...out }, [out.data.buffer]);
}

/** ZigZag.process with the foreground computed in bands, one per core. */
async function parallel(image, opts) {
    const { data, width: w, height: h } = image;
    const o = resolveOptions(opts, w, h);
    const k = helpers.length + 1;
    const bounds = Array.from({ length: k + 1 }, (_, b) => Math.floor(h * b / k));
    const done = helpers.map((helper, b) => new Promise((resolve, reject) => {
        const job = ++jobs;
        const y0 = bounds[b], y1 = bounds[b + 1];
        const [top, bot] = ZigZag.bandRows(h, o.size, y0, y1);
        const rows = data.slice(top * w * 4, bot * w * 4);   // the band's own copy, handed over
        pending.set(job, { resolve: msg => resolve({ ...msg, y0 }), reject });
        helper.postMessage({ band: { job, rows, top, w, h, y0, y1, size: o.size, weight: o.weight } },
            [rows.buffer]);
    }));

    // the coordinator takes the last band while the helpers work
    const y0 = bounds[k - 1];
    const own = ZigZag.foreground(data, w, h, o.size, o.weight, y0, h);
    const parts = [{ fg: own, hist: ZigZag.histogram(own, w, h, 10, y0, h), y0 }, ...await Promise.all(done)];

    const fg = new Float64Array(w * h);
    const hist = new Uint32Array(256);
    for (const part of parts) {
        fg.set(part.fg, part.y0 * w);
        for (let i = 0; i < 256; i++) hist[i] += part.hist[i];
    }
    return ZigZag.finish(fg, hist, data, w, h, o);
}

/** One helper per extra core; none where nested workers are unavailable. */
function startHelpers() {
    if (helpers) return helpers;
    helpers = [];
    const cores = Math.min(8, self.navigator?.hardwareConcurrency || 1);
    try {
        for (let i = 1; i < cores; i++) {
            const worker = new Worker(new URL(import.meta.url), { type: 'module' });
            worker.onmessage = ({ data }) => {
                const job = pending.get(data.done);
                pending.delete(data.done);
                job?.resolve(data);
            };
            // a failed helper fails the run (it falls back to serial) and the bands for good
            worker.onerror = () => stopHelpers([]);
            helpers.push(worker);
        }
    } catch {
        stopHelpers([]);
    }
    return helpers;
}

/** Terminate the helpers and fail their bands in flight; next: null starts them
 *  again on the next large run, [] keeps the coordinator serial. */
function stopHelpers(next) {
    for (const worker of helpers ?? []) worker.terminate();
    helpers = next;
    for (const { reject } of pending.values()) reject(new Error('band cancelled'));
    pending.clear();
}
