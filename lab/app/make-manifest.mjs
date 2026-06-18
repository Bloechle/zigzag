#!/usr/bin/env node
/*
 * make-manifest.mjs — generate the demo-set manifest the "Demo set" button reads.
 *
 *   node app/make-manifest.mjs wezut                # from lab/ → writes wezut/index.json
 *   node make-manifest.mjs <imagesDir> [outDir]
 *
 * The manifest lists the image filenames; the app resolves them relative to
 * the sibling wezut/ folder it fetches (../wezut/). For images hosted elsewhere (a CDN, to
 * dodge a static host's size limit), set "base" to the absolute URL by hand and
 * make sure CORS allows it.
 */
import { readdirSync, writeFileSync, statSync } from 'fs';
import { join, basename, resolve } from 'path';

const IMG = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;
const dir = process.argv[2];
const out = process.argv[3] || dir;
if (!dir) { console.error('usage: node make-manifest.mjs <imagesDir> [outDir]'); process.exit(1); }

const files = readdirSync(dir)
    .filter(f => IMG.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const manifest = {
    name: basename(resolve(dir)) || 'WEZUT',
    base: '',                     // empty → app uses the sibling ../wezut/ folder
    images: files,
};
writeFileSync(join(out, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${files.length} image${files.length === 1 ? '' : 's'} → ${join(out, 'index.json')}`);
