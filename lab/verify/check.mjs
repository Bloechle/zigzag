// check.mjs — compare the JS port against the Python reference dumps.
import { readFileSync } from 'fs';
import { binarize, METHODS } from '../app/binarizers.js';
import { qualityMetrics } from '../app/zqs.js';

const REF = './refs';
const man = JSON.parse(readFileSync(`${REF}/manifest.json`));
const u8 = p => new Uint8Array(readFileSync(p).buffer, readFileSync(p).byteOffset ?? 0, readFileSync(p).length);
const readU8 = p => { const b = readFileSync(p); return new Uint8Array(b.buffer, b.byteOffset, b.length); };

// metric fields to compare and their tolerance (rounded values from Python)
const FIELDS = ['ink_pct', 'speckles_mpx', 'sw_px', 'sw_src_px', 'q_stroke', 'q_edge',
    'q_recall', 'f_adh', 'q_swm', 'cc_per_mpx', 'edge_strong', 'flood_pct',
    'cov_worst', 'q_clean', 'q_cov', 'q_solid', 'zqs'];

let binTotal = 0, binSumAgree = 0, binWorst = { agree: 1, k: '' };
const metricErr = Object.fromEntries(FIELDS.map(f => [f, { max: 0, sum: 0, n: 0, where: '' }]));

for (const [name, info] of Object.entries(man.images)) {
    const { w, h } = info;
    const gray = readU8(`${REF}/${name}.gray`);

    for (const m of man.methods) {
        const py = readU8(`${REF}/${name}.${m}.bin`);
        const js = binarize(m, gray, w, h);
        let agree = 0; for (let i = 0; i < py.length; i++) if (py[i] === js[i]) agree++;
        const frac = agree / py.length;
        binTotal++; binSumAgree += frac;
        if (frac < binWorst.agree) binWorst = { agree: frac, k: `${name}/${m}` };

        // ZQS on the IDENTICAL python binary → isolates the metric port
        const ref = info.methods[m];
        const got = qualityMetrics(gray, py, w, h);
        for (const f of FIELDS) {
            if (ref[f] == null || got[f] == null) continue;
            const e = Math.abs(ref[f] - got[f]);
            const rec = metricErr[f];
            rec.sum += e; rec.n++;
            if (e > rec.max) { rec.max = e; rec.where = `${name}/${m}`; }
        }
    }
    // the synthetic dropped-band case (ZQS only)
    const py = readU8(`${REF}/${name}.dropped.bin`);
    const ref = info.methods['__dropped'];
    const got = qualityMetrics(gray, py, w, h);
    for (const f of FIELDS) {
        if (ref[f] == null || got[f] == null) continue;
        const e = Math.abs(ref[f] - got[f]);
        const rec = metricErr[f]; rec.sum += e; rec.n++;
        if (e > rec.max) { rec.max = e; rec.where = `${name}/dropped`; }
    }
}

console.log('── binarizer pixel agreement vs Python ──');
console.log(`  methods×images: ${binTotal}   mean agreement: ${(100 * binSumAgree / binTotal).toFixed(3)}%`);
console.log(`  worst: ${binWorst.k}  ${(100 * binWorst.agree).toFixed(3)}%`);

console.log('\n── ZQS metric error (|JS − Python| on identical binaries) ──');
console.log('  field            max-abs-err   mean-abs-err   worst-case');
for (const f of FIELDS) {
    const r = metricErr[f];
    console.log(`  ${f.padEnd(14)} ${r.max.toFixed(4).padStart(10)} ${(r.sum / r.n).toFixed(4).padStart(13)}   ${r.where}`);
}
