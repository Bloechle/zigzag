/**
 * app.js — ZQS Lab, fully client-side. No server: the Python endpoints
 * (/folder /thumb /zigzag /method /scores /cfg /pick /events) are replaced by
 * local computation in a Web Worker (worker.js → zigzag.js + binarizers.js +
 * zqs.js). The Insight-style shell is unchanged; only the data layer moved.
 *
 *   • ZigZag tab  — original ⟷ ZigZag result, before/after split, pan + zoom,
 *     three outputs (BW · Gray · Color).
 *   • All Methods — every committee binarization of the current image, scored
 *     by ZQS and streamed best-first from the worker.
 *
 * Image sources, in order of nicety:
 *   - a local folder via the File System Access API (showDirectoryPicker),
 *   - a <input webkitdirectory> fallback where that API is absent,
 *   - a bundled demo set described by ../wezut/index.json,
 *   - drag-drop or paste of individual photos.
 * Everything runs on-device; the page is a static site (works from any host).
 *
 * Deps: qry.js ($), qry-kit.js, ui.js.
 */
import { boot, theme, icons, toast, debounce, clamp, makeStore } from './qry/qry-kit.js';
import { makeSlider } from './ui.js';

const store = makeStore('zqslab');

// ── Worker plumbing (request/response + streaming correlation) ──────────────
const worker = new Worker('./worker.js', { type: 'module' });
let reqId = 0;
const pending = new Map();
worker.onmessage = ({ data: m }) => {
    const p = pending.get(m.id); if (!p) return;
    if (m.type === 'ready' || m.type === 'render') { pending.delete(m.id); p.resolve(m); }
    else if (m.type === 'score') p.onScore && p.onScore(m);
    else if (m.type === 'scoresDone') { pending.delete(m.id); p.onDone && p.onDone(); }
    else if (m.type === 'error') { pending.delete(m.id); (p.reject || (() => {}))(new Error(m.message)); toast('Compute error', 'danger'); }
};
worker.onerror = e => { status('worker error'); toast(`Worker: ${e.message}`, 'danger'); };

const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++reqId; pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
});
const callStream = (msg, onScore, onDone) => {
    const id = ++reqId; pending.set(id, { onScore, onDone });
    worker.postMessage({ ...msg, id }); return id;
};

// ── State ──────────────────────────────────────────────────────────────────
let zz = { size: 25, weight: 90, off: 0 };
const ZZ_DEFAULTS = { size: 25, weight: 90, off: 0 };
let mode = 'binary';
let tab = 'zigzag';
let zoom = 1;
let images = [];                       // [{ name, file? | getFile? | url? , _url? }]
let currentImage = null;               // name
let loadedName = null;                  // image currently resident in the worker

const MODE_LABEL = { binary: 'zigzag · BW', gray: 'zigzag · gray', color: 'zigzag · color' };
const SCORE_MAX = 1000;                // working resolution for the committee (speed)
const entry = name => images.find(e => e.name === name);

// ── Decode helpers (Blob/handle/url → ImageData / object URL) ───────────────
async function entryBlob(e) {
    if (e.file) return e.file;
    if (e.getFile) return await e.getFile();
    if (e.url) return await fetch(e.url).then(r => r.blob());
    throw new Error('no source');
}
async function entryURL(e) {
    if (e._url) return e._url;
    if (e.url) return (e._url = e.url);
    return (e._url = URL.createObjectURL(await entryBlob(e)));
}
async function entryImageData(e) {
    const bmp = await createImageBitmap(await entryBlob(e));
    const c = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(bmp.width, bmp.height)
        : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return ctx.getImageData(0, 0, c.width, c.height);
}
// RGBA buffer → object URL (fresh canvas per call — toBlob is async, no sharing)
function rgbaToURL(buf, w, h) {
    const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    if (c.convertToBlob) return c.convertToBlob({ type: 'image/png' }).then(b => URL.createObjectURL(b));
    return new Promise(res => c.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
}

// load the current image into the worker exactly once
async function ensureLoaded() {
    if (loadedName === currentImage) return;
    const id = await entryImageData(entry(currentImage));
    const buf = id.data.buffer.slice(0);             // owned copy to transfer
    await call({ type: 'load', rgba: buf, w: id.width, h: id.height }, [buf]);
    loadedName = currentImage;
}

// ── Footer status ───────────────────────────────────────────────────────────
function status(text, busy) {
    $('#status-label').html(`<i data-lucide="${busy ? 'loader' : 'image'}"></i> ${text}`); icons();
    $('#progress-bar').attr('indeterminate', busy ? '' : null).attr('data-on', busy ? '' : null);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setTab(name) {
    tab = name;
    $.all('.zqs-tab').forEach(t => {
        const on = t.attr('data-tab') === name;
        t.cls(on ? '+active' : '-active').attr('aria-selected', on ? 'true' : 'false');
    });
    $.all('.zqs-panel').forEach(p => p.cls(p.attr('data-tab') === name ? '+active' : '-active'));
    $('.zqs-app').cls(name === 'zigzag' ? '+tab-zigzag' : '-tab-zigzag');
    if (name === 'methods') renderMethodsGrid();
    else scheduleRender();
}

// ── Stage pan + zoom ──────────────────────────────────────────────────────────
function renderMax() {
    const canvas = $.opt('#canvas');
    const cssW = (canvas && canvas.clientWidth) || (($.opt('#stage')?.clientWidth || 800) * zoom);
    const need = cssW * (window.devicePixelRatio || 1);
    return clamp(Math.ceil(need / 300) * 300, 900, 2400);
}
function applyZoom() {
    $('#canvas').css('width', (zoom * 100) + '%');
    $('#zoom-pct').text(Math.round(zoom * 100) + '%');
    requestAnimationFrame(centerGrip);
}
function setZoom(z) { zoom = clamp(z, 0.25, 8); applyZoom(); scheduleRender(); }
function zoomAt(cx, cy, factor) {
    const stage = $('#stage'), rect = stage.getBoundingClientRect();
    const x = stage.scrollLeft + (cx - rect.left), y = stage.scrollTop + (cy - rect.top);
    const old = zoom; setZoom(zoom * factor); const r = zoom / old;
    stage.scrollLeft = x * r - (cx - rect.left);
    stage.scrollTop = y * r - (cy - rect.top);
}
function setSplit(pct) { $('#canvas').style.setProperty('--split', clamp(pct, 2, 98) + '%'); }
function splitFromX(clientX) {
    const rect = $('#canvas').getBoundingClientRect();
    if (rect.width) setSplit((clientX - rect.left) / rect.width * 100);
}
function centerGrip() {
    const stage = $.opt('#stage'), canvas = $.opt('#canvas'), grip = $.opt('#split-grip');
    if (!grip || !canvas || !stage) return;
    const ch = canvas.offsetHeight || stage.clientHeight;
    const mid = (stage.scrollTop + Math.min(ch, stage.scrollTop + stage.clientHeight)) / 2;
    grip.style.top = mid + 'px';
}

const scheduleRender = debounce(() => {
    if (tab !== 'zigzag' || !currentImage) return;
    showAfter();
}, 160);

// ── Gallery ────────────────────────────────────────────────────────────────
function renderGallery() {
    const list = $('#imglist').empty();
    if (!images.length) {
        list.add($.create('div', { class: 'zqs-empty', text: 'No images. Open a folder or drop photos here.' }));
        return;
    }
    images.forEach(e => {
        const row = $.create('button', { class: 'zqs-imgrow', 'data-img': e.name, role: 'listitem' });
        row.html('<img class="zqs-imgrow-thumb" loading="lazy" alt="">'
            + '<span class="zqs-imgrow-name"></span>');
        row.find('.zqs-imgrow-name')[0].text(e.name);
        entryURL(e).then(u => row.find('img')[0].attr('src', u)).catch(() => {});
        list.add(row);
    });
}

function selectImage(name) {
    if (!name) return;
    currentImage = name;
    const i = images.findIndex(e => e.name === name);
    $('#pos-info').text(`${i + 1} / ${images.length} · ${name}`);
    $.all('#imglist .zqs-imgrow').forEach(r =>
        r.cls(r.attr('data-img') === name ? '+is-sel' : '-is-sel'));
    setZoom(1); setSplit(50);
    const s = $('#stage'); s.scrollTop = 0; s.scrollLeft = 0;
    renderComparator();
    requestAnimationFrame(centerGrip);
    if (tab === 'methods') renderMethodsGrid();
}

// ── ZigZag before/after ──────────────────────────────────────────────────────
let afterTok = 0;
async function showAfter() {
    if (!currentImage) return;
    const a = $('#cmp-after');
    const tok = ++afterTok;
    a.cls('+is-loading');
    $('#tag-res').text(MODE_LABEL[mode] || 'zigzag');
    try {
        await ensureLoaded(); if (tok !== afterTok) return;
        const m = await call({ type: 'zigzag', mode, size: zz.size, weight: zz.weight, off: zz.off, max: renderMax() });
        if (tok !== afterTok) return;
        const url = await rgbaToURL(m.data, m.width, m.height);
        if (tok !== afterTok) { URL.revokeObjectURL(url); return; }
        if (a._url) URL.revokeObjectURL(a._url); a._url = url;
        a.attr('src', url).cls('-is-loading -hide');
    } catch (e) {
        if (tok === afterTok) { a.cls('-is-loading'); toast('ZigZag render failed', 'danger'); }
    }
}

async function renderComparator() {
    const a = $('#cmp-after'), b = $('#cmp-before'), line = $('#split-line');
    const tagO = $('#tag-orig'), tagR = $('#tag-res'), stage = $('#stage');
    if (!currentImage) {
        a.attr('src', '').cls('+hide'); b.attr('src', '').cls('+hide');
        line.cls('+hide'); tagO.cls('+hide'); tagR.cls('+hide'); stage.cls('+empty');
        return;
    }
    const src = await entryURL(entry(currentImage));
    b.attr('src', src).cls('-hide');
    line.cls('-hide'); tagO.cls('-hide'); tagR.cls('-hide'); stage.cls('-empty');
    showAfter();
}

function setMode(m) {
    mode = m;
    $.all('#zz-modes .zqs-srcbtn').forEach(btn =>
        btn.cls(btn.attr('data-mode') === m ? '+is-on' : '-is-on'));
    if (currentImage) showAfter();
}

// ── All Methods grid (worker-streamed, re-sorted live) ──────────────────────
let scoresReq = 0;
let methodURLs = [];

function buildMethodCell(method, zqs, url, ms) {
    const t = ms != null ? `${(+ms).toFixed(ms < 10 ? 1 : 0)} ms` : '';
    const fig = $.create('figure', { class: 'zqs-mcell', 'data-m': method,
        title: `${method} · ZQS ${(+zqs).toFixed(2)}${t ? ' · ' + t : ''}` });
    if (method === 'zigzag') fig.cls('+is-zz');
    fig.html('<span class="mtime qry-mono"></span><span class="mzqs qry-mono"></span>'
        + '<img loading="lazy" alt="">'
        + '<figcaption class="mname"></figcaption>');
    fig.find('img')[0].attr('src', url);
    fig.find('.mname')[0].text(method);
    fig.find('.mtime')[0].text(t);
    fig.find('.mzqs')[0].text((+zqs).toFixed(1));
    return fig;
}

async function renderMethodsGrid() {
    const grid = $('#methods-grid');
    if (!currentImage) {
        grid.empty().add($.create('div', { class: 'zqs-empty', text: 'Select an image.' }));
        return;
    }
    const token = ++scoresReq;
    methodURLs.forEach(URL.revokeObjectURL); methodURLs = [];
    grid.empty();
    status('Scoring methods…', true);

    const placed = [];
    const insert = (rec) => {
        let i = 0;
        while (i < placed.length && placed[i].zqs >= rec.zqs) i++;
        placed.splice(i, 0, rec);
        if (i >= placed.length - 1) grid.add(rec.el);
        else placed[i + 1].el.addBefore(rec.el);
    };

    try {
        await ensureLoaded(); if (token !== scoresReq) return;
        callStream({ type: 'scores', size: zz.size, weight: zz.weight, off: zz.off, scoreMax: SCORE_MAX },
            async (m) => {
                if (token !== scoresReq) return;
                const url = await rgbaToURL(m.data, m.width, m.height);
                if (token !== scoresReq) { URL.revokeObjectURL(url); return; }
                methodURLs.push(url);
                insert({ zqs: m.zqs, el: buildMethodCell(m.method, m.zqs, url, m.ms) });
                status(`${placed.length} method${placed.length > 1 ? 's' : ''} · best first`, true);
            },
            () => {
                if (token !== scoresReq) return;
                if (!placed.length) grid.add($.create('div', { class: 'zqs-empty', text: 'No results.' }));
                status(`${placed.length} methods · best first · click to open full size`);
            });
    } catch (e) {
        if (token === scoresReq) { status('Scoring failed'); toast('Scoring failed', 'danger'); }
    }
}

// ── ZigZag parameters (drawer) ───────────────────────────────────────────────
function renderZZ() {
    const box = $('#zz-params').empty();
    box.add(makeSlider('size', zz.size, 10, 60, 1, v => { zz.size = v; onParams(); }));
    box.add(makeSlider('weight', zz.weight, 50, 100, 1, v => { zz.weight = v; onParams(); }));
    box.add(makeSlider('T offset %', zz.off, -50, 50, 5, v => { zz.off = v; onParams(); }));
}
const onParams = debounce(() => {
    store.set('zz', zz);
    if (!currentImage) return;
    if (tab === 'zigzag') showAfter(); else renderMethodsGrid();
}, 200);

// ── Folder / image-set loading ───────────────────────────────────────────────
const IMG_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;

function setImages(entries, folderName) {
    images.forEach(e => { if (e._url && !e.url) URL.revokeObjectURL(e._url); });
    images = entries;
    currentImage = null; loadedName = null;
    $('#img-count').text(`${images.length}`);
    $('#folder-name').text(folderName || '');
    renderGallery();
    if (images.length) { selectImage(images[0].name); status(`${images.length} image${images.length === 1 ? '' : 's'}`); }
    else { renderComparator(); status('Empty folder'); }
}

async function pickFolder() {
    if (window.showDirectoryPicker) {
        try {
            const dir = await window.showDirectoryPicker();
            const entries = [];
            for await (const [name, handle] of dir.entries())
                if (handle.kind === 'file' && IMG_RE.test(name))
                    entries.push({ name, getFile: () => handle.getFile() });
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            if (!entries.length) { toast('No images in that folder', 'warning'); return; }
            setImages(entries, dir.name);
        } catch (e) { if (e.name !== 'AbortError') toast('Could not open folder', 'warning'); }
    } else {
        $('#dir-input').click();   // <input webkitdirectory> fallback
    }
}

function loadFromFileList(fileList) {
    const files = [...fileList].filter(f => IMG_RE.test(f.name) || /^image\//.test(f.type));
    if (!files.length) { toast('No images selected', 'warning'); return; }
    const folder = (files[0].webkitRelativePath || '').split('/')[0] || 'files';
    const entries = files
        .map(f => ({ name: (f.webkitRelativePath || f.name).split('/').pop(), file: f }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setImages(entries, folder);
}

async function loadDemo() {
    status('Loading demo set…', true);
    const man = await fetch('../wezut/index.json').then(r => r.ok ? r.json() : null).catch(() => null);
    if (!man || !man.images || !man.images.length) {
        status('Pick a folder');
        toast('No demo set found in ../wezut/ — add images and an index.json', 'warning');
        return;
    }
    const base = man.base || '../wezut/';
    const entries = man.images.map(it => {
        const name = typeof it === 'string' ? it : it.name;
        const path = typeof it === 'string' ? it : (it.path || it.name);
        return { name, url: base + path };
    });
    setImages(entries, man.name || 'WEZUT');
}

// drop / paste single photos as an ad-hoc set
function addDroppedFiles(fileList) {
    const files = [...fileList].filter(f => /^image\//.test(f.type) || IMG_RE.test(f.name));
    if (!files.length) return;
    const incoming = files.map(f => ({ name: f.name, file: f }));
    // merge into the current set (or start a new one)
    const merged = [...images, ...incoming.filter(n => !images.some(e => e.name === n.name))];
    setImages(merged, $('#folder-name').text() || 'dropped');
    selectImage(incoming[0].name);
}

// ── Stage wiring (pan + zoom + split drag) ─────────────────────────────────────
function wireStage() {
    const stage = $('#stage');
    $('#zoom-fit').on('click', () => { setZoom(1); stage.scrollTop = 0; stage.scrollLeft = 0; });
    $('#zoom-in').on('click', () => setZoom(zoom * 1.25));
    $('#zoom-out').on('click', () => setZoom(zoom * 0.8));
    stage.on('wheel', e => {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9); }
    });
    stage.on('scroll', centerGrip);
    let panning = false, sx = 0, sy = 0, sl = 0, st = 0;
    stage.on('pointerdown', e => {
        if (e.button !== 0 || !currentImage) return;
        if (e.target.closest && e.target.closest('#split-line')) return;
        try { stage.setPointerCapture(e.pointerId); } catch (_) { /* */ }
        panning = true; sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop; stage.cls('+grabbing');
    });
    stage.on('pointermove', e => {
        if (panning) { stage.scrollLeft = sl - (e.clientX - sx); stage.scrollTop = st - (e.clientY - sy); }
    });
    const end = () => { if (panning) { panning = false; stage.cls('-grabbing'); } };
    stage.on('pointerup', end).on('pointercancel', end);
}

function wireSplit() {
    const line = $('#split-line');
    let sliding = false;
    line.on('pointerdown', e => {
        if (e.button !== 0 || !currentImage) return;
        e.preventDefault(); e.stopPropagation();
        sliding = true; line.cls('+dragging');
        try { line.setPointerCapture(e.pointerId); } catch (_) { /* */ }
        splitFromX(e.clientX);
    });
    line.on('pointermove', e => { if (sliding) splitFromX(e.clientX); });
    const end = e => {
        if (!sliding) return;
        sliding = false; line.cls('-dragging');
        try { line.releasePointerCapture(e.pointerId); } catch (_) { /* */ }
    };
    line.on('pointerup', end).on('pointercancel', end)
        .on('lostpointercapture', () => { sliding = false; line.cls('-dragging'); });
}

function wireSplitter() {
    const split = $('#split'), app = $('.zqs-app');
    let dragging = false;
    split.on('pointerdown', e => {
        dragging = true; split.cls('+dragging');
        try { split.setPointerCapture(e.pointerId); } catch (_) { /* */ }
        e.preventDefault();
    });
    split.on('pointermove', e => {
        if (!dragging) return;
        const left = app.getBoundingClientRect().left;
        const w = clamp(e.clientX - left, 150, Math.min(480, window.innerWidth * 0.5));
        app.style.setProperty('--zqs-left-w', w + 'px');
    });
    const end = () => { if (dragging) { dragging = false; split.cls('-dragging'); scheduleRender(); } };
    split.on('pointerup', end).on('pointercancel', end);
}

function wireDropPaste() {
    const stage = $('#stage');
    ['dragenter', 'dragover'].forEach(ev => stage.addEventListener(ev, e => { e.preventDefault(); $('#stage').cls('+dropping'); }));
    ['dragleave', 'drop'].forEach(ev => stage.addEventListener(ev, () => $('#stage').cls('-dropping')));
    stage.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) addDroppedFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', e => {
        const items = [...(e.clipboardData?.items || [])].filter(it => it.type.startsWith('image/'));
        if (!items.length) return;
        const files = items.map(it => it.getAsFile()).filter(Boolean);
        if (files.length) addDroppedFiles(files);
    });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function syncThemeIcon() {
    $('#btn-theme').html(`<i data-lucide="${theme.isDark() ? 'sun' : 'moon'}"></i>`); icons();
}

function init() {
    zz = { ...ZZ_DEFAULTS, ...(store.get('zz') || {}) };

    renderZZ();
    wireStage(); wireSplit(); wireSplitter(); wireDropPaste();
    applyZoom(); setSplit(50); setTab('zigzag');

    $('.zqs-tabs').delegate('.zqs-tab', 'click', function () { setTab(this.attr('data-tab')); });
    $('#zz-modes').delegate('.zqs-srcbtn', 'click', function () { setMode(this.attr('data-mode')); });
    $('#imglist').delegate('.zqs-imgrow', 'click', function () { selectImage(this.attr('data-img')); });
    $('#methods-grid').delegate('.zqs-mcell', 'click', function () {
        const m = this.attr('data-m');
        const img = this.find('img')[0];
        if (img && img.attr('src')) window.open(img.attr('src'), '_blank');
    });

    $('#toggle-left').on('click', () => {
        const app = $('.zqs-app');
        app.cls(app.cls('?left-collapsed') ? '-left-collapsed' : '+left-collapsed');
        scheduleRender();
    });

    $('#cmp-after').on('load', centerGrip);
    $('#cmp-before').on('load', centerGrip);
    window.on('resize', () => { centerGrip(); scheduleRender(); });

    // folder / demo / fallback input
    $('#pick-imgs').on('click', pickFolder);
    $('#pick-demo').on('click', loadDemo);
    $('#dir-input').on('change', function () { loadFromFileList(this.files); });

    // parameters drawer
    const drawer = $('#params-drawer');
    $('#btn-params').on('click', () => drawer.show());
    $('#params-reset').on('click', () => { zz = { ...ZZ_DEFAULTS }; renderZZ(); onParams(); });

    // theme
    $('#btn-theme').on('click', () => { theme.toggle(); syncThemeIcon(); });

    status('Open a folder, load the demo set, or drop photos');
}

boot({ title: 'ZQS Lab', ready: () => { init(); syncThemeIcon(); } });
