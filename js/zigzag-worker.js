/*
 * zigzag-worker.js — runs the CPU port off the main thread.
 *
 * The source image is uploaded once and kept here, so each run only ships the
 * options across; the result is transferred back rather than copied.
 *
 *   worker.postMessage({ image: { data, width, height } }, [data.buffer]);
 *   worker.postMessage({ id, opts });   // -> { id, data, width, height, info }
 *   worker.postMessage({ image: null });               // release it
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 */

import { ZigZag } from './zigzag.js';

let source = null;

self.onmessage = ({ data: msg }) => {
    if ('image' in msg) {          // null releases the cached source
        source = msg.image;
        return;
    }
    if (!source) {
        self.postMessage({ id: msg.id, error: 'no source image' });
        return;
    }
    const res = ZigZag.process(source, msg.opts);
    self.postMessage({ id: msg.id, ...res }, [res.data.buffer]);
};
