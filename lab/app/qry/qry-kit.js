/**
 * qry-kit.js — application glue for the qry stack
 *
 * The stack, kept deliberately small:
 *   • qry.js   (CDN)  — DOM core: the global `$`
 *   • Shoelace (CDN)  — widgets: <sl-alert>, <sl-dialog>, <sl-drawer>, <sl-button>…
 *   • qry-ui.css      — app shell, layout, design tokens (built on Shoelace tokens)
 *   • qry-kit.js      — this file: the glue Shoelace and qry don't provide
 *
 * Not a widget library, not a base class — a flat set of named exports. Import
 * only what a page needs:
 *
 *   import { boot, theme, toast, makeKeyboard, format } from './qry-kit.js';
 *
 * ── Conventions ──────────────────────────────────────────────────────────────
 *   • Pure helpers & one-shot actions are bare functions:  clamp, toast, copy…
 *   • Cohesive families are namespaces:                    format.*, str.*, theme.*
 *   • `make*` builds something STATEFUL and returns a controller object.
 *     Those that bind listeners or inject DOM also expose `.destroy()` to
 *     unwind cleanly:
 *         makeSidebar · makeAutoHideHeader · makeKeyboard ·
 *         makeDropZone · makeIframeAutoHeight
 *     (makeStore returns a plain get/set store — nothing to tear down.)
 *   • Everything injected into the DOM is prefixed `qry-`.
 *
 * ── Contents ─────────────────────────────────────────────────────────────────
 *   1. Primitives      sleep · clamp · scale · stamp · throttle · debounce · loadScript
 *   2. Format          format.{duration,bytes,date,clock,number,truncate}
 *   3. Strings         str.{camelCase,stripBom}  (CSV parsing lives in core: $.parseCSV)
 *   4. Storage         makeStore  (prefixed, JSON-safe localStorage)
 *   5. Theme & icons   theme.{set,toggle,isDark,init} · icons
 *   6. Network         api
 *   7. Clipboard/files copy · download · readFiles · onPasteFile
 *   8. Notifications   toast · confirm · prompt
 *   9. Layout (make*)  makeSidebar · makeAutoHideHeader
 *  10. Input (make*)   makeKeyboard · bindAll
 *  11. Drop zone       makeDropZone
 *  12. Iframe embed    makeIframeAutoHeight (child) · embedIframe (parent)
 *  13. Boot            boot
 *
 * Requires qry.js loaded first as a <script> (provides window.$). Functions that
 * build widgets (toast, confirm, prompt) require Shoelace's autoloader.
 *
 * @version 1.1.0
 * @author  Jean-Luc Bloechle with Claude.ai
 * @license MIT
 */

// ─── 1. Primitives — pure, dependency-free helpers ───────────────────────────

/** Await a delay.
 *  @param {number} ms
 *  @returns {Promise<void>}
 *  @example await sleep(500)
 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Constrain a number to `[lo, hi]`.
 *  @param {number} x @param {number} lo @param {number} hi @returns {number}
 *  @example clamp(frame, 0, lastFrame)
 */
export const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;

/** Linear map of `v` from `[inMin, inMax]` onto `[outMin, outMax]` — alias of
 *  qry.js core's `$.scale`, re-exported so kit users can import it by name.
 *  @example scale(0.5, 0, 1, 0, 100) // → 50
 */
export const scale = $.scale;

/** @private — zero-pad a number to `w` digits (shared by stamp + format). */
const _pad = (n, w = 2) => String(n).padStart(w, '0');

/** Compact local-time `YYYYMMDDhhmmss` timestamp for filenames.
 *  @returns {string}
 *  @example download(`export_${stamp()}.csv`)
 */
export const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${_pad(d.getMonth() + 1)}${_pad(d.getDate())}` +
           `${_pad(d.getHours())}${_pad(d.getMinutes())}${_pad(d.getSeconds())}`;
};

/** At most one call per `ms` (leading edge).
 *  @param {Function} fn @param {number} ms @returns {Function}
 *  @example window.on('scroll', throttle(update, 100))
 */
export const throttle = (fn, ms) => {
    let last = 0;
    return (...args) => {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn(...args); }
    };
};

/** Fire `fn` only after `ms` of quiet. Returns a fn with `.cancel()`.
 *  @param {Function} fn @param {number} ms @returns {Function}
 *  @example search.on('input', debounce(run, 250))
 */
export const debounce = (fn, ms) => {
    let t;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
};

/** Load an external script once, on demand. Concurrent calls for the same URL
 *  share one `<script>` (and one Promise); a failed load is not cached, so a
 *  later call can retry. Resolves when the script has run.
 *  @param {string} src
 *  @returns {Promise<void>}
 *  @example await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js')
 */
const _scripts = new Map();
export const loadScript = src => {
    if (_scripts.has(src)) return _scripts.get(src);
    const p = new Promise((resolve, reject) => {
        const el = $.create('script', { src });
        el.on('load', () => resolve());
        el.on('error', () => { _scripts.delete(src); reject(new Error(`Failed to load ${src}`)); });
        el.mount(document.head);
    });
    _scripts.set(src, p);
    return p;
};

// ─── 2. Format — value → display string ──────────────────────────────────────

/** Small set of display formatters. Pure, no DOM.
 *  @example format.duration(90000) // → '1m 30s'
 *  @example format.bytes(1536)     // → '1.5 KB'
 */
export const format = {
    /** ms → `1h 02m`, `5m 03s`, `820ms`. @param {number} ms */
    duration(ms) {
        ms = Math.round(ms);
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000) % 60;
        const m = Math.floor(ms / 60000) % 60;
        const h = Math.floor(ms / 3600000);
        if (h) return `${h}h ${_pad(m)}m`;
        if (m) return `${m}m ${_pad(s)}s`;
        return `${s}s`;
    },
    /** bytes → `1.5 KB`, `3.2 MB`. @param {number} n */
    bytes(n) {
        if (!(n > 0)) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = clamp(Math.floor(Math.log(n) / Math.log(1024)), 0, u.length - 1);
        return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
    },
    /** Date|number|string → `YYYY-MM-DD HH:MM`. @param {Date|number|string} d */
    date(d) {
        const x = d instanceof Date ? d : new Date(d);
        return `${x.getFullYear()}-${_pad(x.getMonth() + 1)}-${_pad(x.getDate())} ${_pad(x.getHours())}:${_pad(x.getMinutes())}`;
    },
    /** seconds → `mm:ss.mmm` media-clock timecode. @param {number} s @example format.clock(90.5) → '01:30.500' */
    clock(s) {
        if (s == null || isNaN(s)) return '00:00.000';
        const m  = Math.floor(s / 60);
        const ss = Math.floor(s % 60);
        const ms = Math.floor((s % 1) * 1000);
        return `${_pad(m)}:${_pad(ss)}.${_pad(ms, 3)}`;
    },
    /** number → fixed-precision string (`''` for null/undefined). @param {number} v @param {number} [p=2] */
    number(v, p = 2) {
        return v == null || isNaN(v) ? '' : Number(v).toFixed(p);
    },
    /** Truncate with a trailing ellipsis if longer than `max`. @param {string} s @param {number} max */
    truncate(s, max) {
        if (!s || s.length <= max) return s;
        return s.slice(0, Math.max(0, max - 1)) + '…';
    },
};

// ─── 3. Strings — non-display string helpers ─────────────────────────────────

/** String helpers that aren't display-formatting (those live in `format`). */
export const str = {
    /** Strip a leading UTF-8 BOM. Unity / Windows exports often start with one,
     *  which makes `JSON.parse` throw — this guards against that.
     *  @param {string} text @returns {string} */
    stripBom(text) {
        return text && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    },
    /** `"Hello World!"` → `"helloWorld"`, `"font-size"` → `"fontSize"`,
     *  `"reaction_time_ms"` → `"reactionTimeMs"`. Hyphens/underscores count as
     *  word boundaries; other non-alphanumerics are stripped.
     *  @param {string} s @returns {string} */
    camelCase(s) {
        return String(s)
            .trim()
            .replace(/[-_]+/g, ' ')
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .map((w, i) => i === 0
                ? w.toLowerCase()
                : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    },
};

// ─── 4. Storage — prefixed, JSON-safe localStorage ───────────────────────────

/** Prefixed localStorage with safe JSON. Failures are swallowed (private mode).
 *  @param {string} prefix  Prepended to every key (e.g. 'mocap_')
 *  @returns {{ get, set, remove }}
 *  @example const store = makeStore('app_'); store.set('theme', 'dark')
 */
export const makeStore = (prefix = '') => ({
    get:    k      => { try { return JSON.parse(localStorage.getItem(prefix + k)); } catch { return null; } },
    set:    (k, v) => { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch {} },
    remove: k      => { try { localStorage.removeItem(prefix + k); } catch {} },
});

const _themeStore = makeStore('qry_');

// ─── 5. Theme & icons — one switch drives qry-ui.css + Shoelace ──────────────

/** Light/dark theme, persisted, applied via two hooks on <html>:
 *  - `sl-theme-dark` class → drives BOTH the qry-ui.css tokens and all
 *    Shoelace widgets (qry-ui.css keys its dark tokens off this class)
 *  - `data-theme="light|dark"` attribute → not used by the stack itself;
 *    kept as a stable hook for app-specific CSS
 *
 *  @example
 *  theme.init();              // apply saved (or system) preference on boot
 *  theme.toggle();            // flip + persist
 *  if (theme.isDark()) {...}  // query
 */
export const theme = {
    /** @param {'light'|'dark'} mode */
    set(mode) {
        const dark = mode === 'dark';
        const html = document.documentElement;
        html.attr('data-theme', mode);
        html.cls(dark ? '+sl-theme-dark' : '-sl-theme-dark');
        _themeStore.set('theme', mode);
        return mode;
    },
    isDark() { return document.documentElement.cls('?sl-theme-dark'); },
    toggle() { return this.set(this.isDark() ? 'light' : 'dark'); },
    /** Apply the saved theme, or fall back to the OS preference. */
    init() {
        const saved = _themeStore.get('theme');
        const sys = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        return this.set(saved ?? sys);
    },
};

/** Render any `data-lucide` icons currently in the DOM. Call after injecting
 *  HTML that contains icons. No-op if Lucide isn't loaded.
 *  @example $('#panel').html(markup); icons();
 */
export const icons = () => { try { window.lucide?.createIcons(); } catch {} };

// ─── 6. Network — fetch with timeout + JSON ──────────────────────────────────

/** JSON fetch wrapper: throws on non-2xx, parses JSON (else text), with an
 *  optional base URL, timeout (AbortController), and JSON-body convenience.
 *
 *  A non-string `body` is JSON-stringified and `Content-Type: application/json`
 *  is set automatically. A timeout aborts the request and throws.
 *
 *  @param {string} path
 *  @param {Object} [opts]
 *  @param {string} [opts.base='']                 Prepended to `path`
 *  @param {string} [opts.method='GET']
 *  @param {any}    [opts.body]                    Object → JSON; string / FormData / Blob / URLSearchParams → sent as-is
 *  @param {Object} [opts.headers]
 *  @param {number} [opts.timeout]                 ms before abort (omit = no timeout)
 *  @param {...any} [opts.rest]                    any other fetch init option
 *  @returns {Promise<any>}
 *  @example const data = await api('/api/qry/apps')
 *  @example await api('/notes', { method: 'POST', body: { text: 'hi' }, timeout: 5000 })
 */
export const api = async (path, { base = '', method = 'GET', body, headers = {}, timeout, ...rest } = {}) => {
    const init = { method, headers: { ...headers }, ...rest };
    if (body !== undefined) {
        if (typeof body === 'string' || body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams) {
            init.body = body;
        } else {
            init.body = JSON.stringify(body);
            if (!Object.keys(init.headers).some(k => k.toLowerCase() === 'content-type'))
                init.headers['Content-Type'] = 'application/json';
        }
    }

    let timer;
    if (timeout) {
        const ctrl = new AbortController();
        init.signal = ctrl.signal;
        timer = setTimeout(() => ctrl.abort(), timeout);
    }
    try {
        const res = await fetch(base + path, init);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeout}ms — ${path}`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
};

// ─── 7. Clipboard & files — copy / download / read / paste ───────────────────

/** Copy text to the clipboard. Shows a toast unless `notify` is false.
 *  @param {string} text
 *  @param {Object}  [opts] @param {boolean} [opts.notify=true]
 *  @returns {Promise<boolean>} whether the copy succeeded
 *  @example await copy(report.url)
 */
export const copy = async (text, { notify = true } = {}) => {
    try {
        await navigator.clipboard.writeText(text);
        if (notify) toast('Copied to clipboard', 'success', 1500);
        return true;
    } catch {
        if (notify) toast('Copy failed', 'error');
        return false;
    }
};

/** Trigger a file download from data (Blob, string, or ArrayBuffer/typed array).
 *  @param {Blob|string|BufferSource} data
 *  @param {string} filename
 *  @param {string} [type='text/plain']  MIME type when `data` isn't a Blob
 *  @example download(JSON.stringify(obj, null, 2), 'data.json', 'application/json')
 *  @example download(pdfBytes, 'letter.pdf', 'application/pdf')
 */
export const download = (data, filename, type = 'text/plain') => {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = $.create('a', { href: url, download: filename });
    a.mount(document.body);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);   // immediate revoke can abort the download
};

/** Read a list of dropped/selected files into parsed JSON payloads.
 *
 *  Accepts `.json` files directly and `.zip` archives (every `.json` inside is
 *  extracted). BOM-tolerant. Per-file failures are reported via `onError`
 *  instead of aborting the whole batch.
 *
 *  ZIP support auto-loads JSZip from jsDelivr on demand (override via `jszipUrl`).
 *
 *  @param {FileList|File[]} files
 *  @param {Object}   [opts]
 *  @param {boolean}  [opts.parse=true]   Parse JSON (false → raw `{name, text}`)
 *  @param {Function} [opts.onError]      (name, error) → void; defaults to console.warn
 *  @param {string}   [opts.jszipUrl]     CDN URL for the on-demand JSZip load
 *  @returns {Promise<Array<{name: string, data?: any, text?: string}>>}
 *
 *  @example
 *  input.on('change', async e => {
 *      const items = await readFiles(e.target.files);
 *      items.forEach(({ name, data }) => addSession(name, data));
 *  });
 */
export const readFiles = async (files, { parse = true, onError, jszipUrl = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js' } = {}) => {
    const warn = onError || ((name, err) => console.warn(`readFiles: ${name} — ${err.message}`));
    const out = [];

    const take = (name, raw) => {
        const text = str.stripBom(raw);
        if (!parse) { out.push({ name, text }); return; }
        try { out.push({ name, data: JSON.parse(text) }); }
        catch (err) { warn(name, err); }
    };

    for (const file of files) {
        try {
            if (file.name.toLowerCase().endsWith('.zip')) {
                if (typeof JSZip === 'undefined') await loadScript(jszipUrl);   // auto-load on demand
                const zip = await new JSZip().loadAsync(file);
                for (const [name, entry] of Object.entries(zip.files)) {
                    if (entry.dir || !name.toLowerCase().endsWith('.json')) continue;
                    try { take(name, await entry.async('string')); }
                    catch (err) { warn(name, err); }
                }
            } else if (file.name.toLowerCase().endsWith('.json')) {
                take(file.name, await file.text());
            }
        } catch (err) {
            warn(file.name, err);
        }
    }
    return out;
};

/** Capture clipboard paste of files (images by default), filtered by MIME.
 *  Returns a detach function. Useful for "paste a screenshot" flows.
 *  @param {Object}   opts
 *  @param {Function} opts.onPaste            (File, ClipboardEvent) → void  (required)
 *  @param {string}   [opts.accept='image/*'] MIME filter ('image/*', 'image/png', '*')
 *  @returns {() => void} detach
 *  @example const off = onPasteFile({ onPaste: f => upload(f) });
 */
export const onPasteFile = ({ onPaste, accept = 'image/*' } = {}) => {
    if (typeof onPaste !== 'function') throw new Error('onPasteFile: onPaste is required');
    const matches = type => accept === '*' || accept.split(',').some(a => {
        const t = a.trim();
        return t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t;
    });
    const handler = e => {
        for (const item of e.clipboardData?.items || []) {
            if (item.kind === 'file' && matches(item.type)) {
                const file = item.getAsFile();
                if (file) { e.preventDefault(); onPaste(file, e); return; }
            }
        }
    };
    document.on('paste', handler);
    return () => document.off('paste', handler);
};

// ─── 8. Notifications — Shoelace <sl-alert> / <sl-dialog> ────────────────────

const _slVariant = { success: 'success', error: 'danger', warn: 'warning', warning: 'warning', info: 'primary' };
const _slIcon    = { success: 'check2-circle', error: 'exclamation-octagon', warn: 'exclamation-triangle', warning: 'exclamation-triangle', info: 'info-circle' };

/** @private — shared <sl-dialog> plumbing for confirm() and prompt(): builds,
 *  mounts and shows the dialog, settles the promise exactly once, resolves
 *  `dismiss` when closed via ✕ / Esc / backdrop, removes itself after hiding. */
const _dialog = (label, innerHTML, resolve, dismiss) => {
    const dialog = Object.assign(document.createElement('sl-dialog'), { label, innerHTML });
    let settled = false;
    const done = val => { if (settled) return; settled = true; resolve(val); dialog.hide(); };
    dialog.on('sl-after-hide', () => { done(dismiss); dialog.remove(); });
    dialog.mount(document.body);
    customElements.whenDefined('sl-dialog').then(() => dialog.show());
    return { dialog, done };
};

const _act = e => e.target.closest('[data-act]')?.dataset.act;

/** Transient notification, rendered as a Shoelace `<sl-alert … toast>`.
 *  Themes automatically with the rest of Shoelace — no injected CSS.
 *  @param {string} msg  Message — rendered as HTML, so keep user data out of it
 *  @param {'success'|'error'|'warn'|'info'} [type='info']
 *  @param {number} [duration=3000]  ms before auto-dismiss
 *  @returns {HTMLElement} the sl-alert
 *  @example toast('Saved', 'success')
 *  @example toast('Not found', 'warn', 5000)
 */
export const toast = (msg, type = 'info', duration = 3000) => {
    const variant = _slVariant[type] || 'primary';
    const alert = Object.assign(document.createElement('sl-alert'), {
        variant, closable: true, duration,
        innerHTML: `<sl-icon slot="icon" name="${_slIcon[type] || 'info-circle'}"></sl-icon>${msg}`,
    });
    alert.mount(document.body);
    customElements.whenDefined('sl-alert').then(() => alert.toast());
    return alert;
};

/** Promise-based confirm dialog (Shoelace `<sl-dialog>`). Resolves `true` on
 *  OK, `false` on Cancel or dismissal (✕ / Esc / backdrop).
 *  @param {string} message  Rendered as plain text
 *  @param {Object} [opts] @param {string} [opts.label='Confirm'] @param {string} [opts.confirm='OK'] @param {string} [opts.cancel='Cancel']
 *  @returns {Promise<boolean>}
 *  @example if (await confirm('Delete this take?')) remove()
 */
export const confirm = (message, { label = 'Confirm', confirm = 'OK', cancel = 'Cancel' } = {}) =>
    new Promise(resolve => {
        const { dialog, done } = _dialog(label, `<p></p>
            <sl-button slot="footer" data-act="cancel">${cancel}</sl-button>
            <sl-button slot="footer" variant="primary" data-act="ok">${confirm}</sl-button>`,
            resolve, false);
        dialog.find('p')[0].text(message);
        dialog.on('click', e => {
            const act = _act(e);
            if (act === 'ok') done(true);
            else if (act === 'cancel') done(false);
        });
    });

/** Promise-based prompt dialog (Shoelace `<sl-dialog>` + `<sl-input>`).
 *  Resolves with the entered string, or `null` if cancelled / dismissed.
 *  @param {string} message  Rendered as plain text
 *  @param {Object} [opts] @param {string} [opts.label='Input'] @param {string} [opts.value=''] @param {string} [opts.placeholder=''] @param {string} [opts.confirm='OK'] @param {string} [opts.cancel='Cancel']
 *  @returns {Promise<string|null>}
 *  @example const name = await prompt('Session name?', { value: 'take-1' })
 */
export const prompt = (message, { label = 'Input', value = '', placeholder = '', confirm = 'OK', cancel = 'Cancel' } = {}) =>
    new Promise(resolve => {
        const { dialog, done } = _dialog(label, `<p></p>
            <sl-input id="qry-prompt-input"></sl-input>
            <sl-button slot="footer" data-act="cancel">${cancel}</sl-button>
            <sl-button slot="footer" variant="primary" data-act="ok">${confirm}</sl-button>`,
            resolve, null);
        const input = dialog.find('#qry-prompt-input')[0];
        dialog.find('p')[0].text(message);
        Object.assign(input, { value, placeholder });
        dialog.on('click', e => {
            const act = _act(e);
            if (act === 'ok') done(input.value ?? '');
            else if (act === 'cancel') done(null);
        });
        dialog.on('keydown', e => { if (e.key === 'Enter') done(input.value ?? ''); });
    });

// ─── 9. Layout (make*) — qry-ui.css shell pieces ─────────────────────────────

/** Wire the qry-ui.css sidebar: responsive open/close (mobile) + collapse (desktop).
 *
 *  Mobile (≤ breakpoint): `.open` slides the sidebar in; overlay click closes.
 *  Desktop (> breakpoint): `.collapsed` shrinks it to icon-only width.
 *
 *  Markup contract: the mobile slide-in needs the sidebar to ALSO carry the
 *  `mobile` class (qry-ui.css keys off `.qry-sidebar.mobile.open`; without it
 *  toggling is a no-op on small screens), plus a backdrop element matching
 *  `opts.overlay` styled by `.qry-overlay`:
 *      <aside class="qry-sidebar mobile">…</aside>
 *      <div id="qry-overlay" class="qry-overlay"></div>
 *  Desktop collapse needs no extra markup.
 *
 *  All selectors are optional — missing elements are skipped, not fatal.
 *  @param {string} sidebarSel
 *  @param {Object} [opts] @param {string} [opts.collapseBtn='#qry-collapse'] @param {string} [opts.overlay='#qry-overlay'] @param {number} [opts.breakpoint=768]
 *  @returns {{ open, close, toggle, destroy }}
 *  @example const nav = makeSidebar('.qry-sidebar'); nav.toggle()
 */
export const makeSidebar = (sidebarSel, {
    collapseBtn = '#qry-collapse',
    overlay     = '#qry-overlay',
    breakpoint  = 768,
} = {}) => {
    const el = $(sidebarSel);
    const ov  = $.opt(overlay);                  // overlay + collapse button are optional
    const btn = $.opt(collapseBtn);
    const isMobile = () => window.innerWidth <= breakpoint;

    const open   = () => { el.cls('+open');  ov?.cls('+visible'); };
    const close  = () => { el.cls('-open');  ov?.cls('-visible'); };
    const toggle = () => isMobile() ? (el.cls('?open') ? close() : open()) : el.cls('~collapsed');

    ov?.on('click', close);
    btn?.on('click', toggle);
    return {
        open, close, toggle,
        destroy() { ov?.off('click', close); btn?.off('click', toggle); },
    };
};

/** Hide a fixed `.qry-header` on scroll-down, reveal on scroll-up.
 *  Toggles `is-hidden` on the header and `header-hidden` on `.qry-app`
 *  (qry-ui.css reacts via `:has()` to offset the sidebar/content).
 *  Auto-detects the scroll container (`.qry-content`), falling back to window.
 *  @param {Object} [opts] @param {string} [opts.headerSel='.qry-header'] @param {string} [opts.appSel='.qry-app'] @param {string} [opts.scrollSel='.qry-content'] @param {number} [opts.topGuard=8] @param {number} [opts.hideDelta=12] @param {number} [opts.showDelta=6]
 *  @returns {{ destroy: Function }}
 */
export const makeAutoHideHeader = ({
    headerSel = '.qry-header', appSel = '.qry-app', scrollSel = '.qry-content',
    topGuard = 8, hideDelta = 12, showDelta = 6,
} = {}) => {
    const header = $.opt(headerSel);
    const app    = $.opt(appSel);
    if (!header || !app) return { destroy() {} };

    const candidate = $.opt(scrollSel);
    const scrollable = el => {
        if (!el) return false;
        return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)
            && el.scrollHeight > el.clientHeight + 1;
    };
    const useEl  = scrollable(candidate);
    const target = useEl ? candidate : window;
    const getY   = useEl ? () => candidate.scrollTop : () => window.scrollY;

    let lastY = getY(), hidden = false, raf = 0;
    const setHidden = v => {
        if (hidden === v) return;
        hidden = v;
        header.cls(v ? '+is-hidden' : '-is-hidden');
        app.cls(v ? '+header-hidden' : '-header-hidden');
    };
    const update = () => {
        raf = 0;
        const y = getY(), dy = y - lastY;
        if      (y <= topGuard)              setHidden(false);
        else if (!hidden && dy >  hideDelta) setHidden(true);
        else if ( hidden && dy < -showDelta) setHidden(false);
        lastY = y;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    target.on('scroll', onScroll, { passive: true });

    return {
        destroy() {
            target.off('scroll', onScroll);
            if (raf) cancelAnimationFrame(raf);
            setHidden(false);
        },
    };
};

// ─── 10. Input (make*) — keyboard & declarative event binding ────────────────

/** Global keyboard shortcuts. Returns a controller: `on(key, fn, opts)` registers
 *  and returns an unregister function; `destroy()` removes everything. Matching
 *  is case-insensitive; a `ctrl` binding fires only with Ctrl/⌘ held, a plain
 *  binding only without. Shortcuts are skipped while focus is in an INPUT,
 *  TEXTAREA, SELECT, [contenteditable] — or a Shoelace form field (events from
 *  inside a shadow root retarget to the host, so the SL-* host tag is checked).
 *  @returns {{ on:(key:string, fn:Function, opts?:{ctrl?:boolean,prevent?:boolean})=>(()=>void), destroy:()=>void }}
 *  @example
 *  const keys = makeKeyboard();
 *  keys.on(' ',      () => player.toggle(), { prevent: true });
 *  keys.on('e',      () => exportCsv(),      { ctrl: true });
 *  keys.on('Escape', () => closeDialog(),    { prevent: false });
 */
export const makeKeyboard = () => {
    const handlers = [];
    const _typing = /^(INPUT|TEXTAREA|SELECT|SL-INPUT|SL-TEXTAREA|SL-SELECT|SL-COLOR-PICKER)$/;
    const onKey = e => {
        const t = e.target;
        if (_typing.test(t.tagName) || t.isContentEditable) return;
        const ctrl = e.ctrlKey || e.metaKey;
        for (const h of handlers) {
            if (e.key.toLowerCase() !== h.key.toLowerCase()) continue;
            if (!!h.ctrl !== ctrl) continue;
            if (h.prevent !== false) e.preventDefault();
            h.fn(e);
            return;
        }
    };
    document.on('keydown', onKey);
    return {
        on: (key, fn, opts = {}) => {
            const h = { key, fn, ...opts };
            handlers.push(h);
            return () => { const i = handlers.indexOf(h); if (i !== -1) handlers.splice(i, 1); };
        },
        destroy() { document.off('keydown', onKey); handlers.length = 0; },
    };
};

/** Bind handlers from a `{ selector → fn }` map. Default event is `click`;
 *  pass `'selector @event'` to choose another. Binds to **every** element
 *  matching the selector (not just the first). Missing selectors are skipped.
 *  Handlers receive the native event; `e.currentTarget` is the matched element.
 *  @param {Object<string, Function>} map
 *  @returns {() => void} detach — removes every listener bound by this call
 *  @example
 *  bindAll({
 *      '#qry-refresh':          () => load(),
 *      '#search @input':        e => filter(e.target.value),
 *      '.row @click':           e => select(e.currentTarget),  // all .row elements
 *  })
 */
export const bindAll = map => {
    const offs = [];
    for (const [spec, fn] of Object.entries(map)) {
        const [sel, evt = 'click'] = spec.split('@').map(s => s.trim());
        $.all(sel).forEach(el => {
            el.on(evt, fn);
            offs.push(() => el.off(evt, fn));
        });
    }
    return () => offs.forEach(off => off());
};

// ─── 11. Drop zone (make*) — drag-and-drop file overlay ──────────────────────

/** Wire drag-and-drop file loading with the qry-ui.css overlay.
 *
 *  Shows `.qry-drop-overlay` (creating one if absent) while a drag is over the
 *  target, hides it on drop/leave, and calls `onFiles` with the dropped File[].
 *  Pair with `readFiles` to parse them.
 *
 *  @param {string|Element} [target=document.body]  drop target
 *  @param {Object}   opts
 *  @param {Function} opts.onFiles                 (File[]) → void  (required)
 *  @param {string}   [opts.label='Drop files here']
 *  @param {string}   [opts.icon='upload']         Lucide icon name
 *  @param {string}   [opts.overlay='#qry-drop']   overlay element (auto-created)
 *  @returns {{ destroy: Function }}
 *
 *  @example
 *  makeDropZone(document.body, {
 *      onFiles: async files => {
 *          const items = await readFiles(files);
 *          items.forEach(({ name, data }) => load(name, data));
 *      },
 *  });
 */
export const makeDropZone = (target = document.body, {
    onFiles,
    label = 'Drop files here',
    icon = 'upload',
    overlay = '#qry-drop',
} = {}) => {
    if (typeof onFiles !== 'function') throw new Error('makeDropZone: onFiles is required');
    const el = $(target);

    // Reuse an existing overlay or build one matching qry-ui.css structure.
    let ov = $.opt(overlay);
    if (!ov) {
        ov = $.create('div', {
            id: overlay.replace(/^#/, ''),
            class: 'qry-drop-overlay',
            html: `<div class="qry-drop-overlay-inner"><i data-lucide="${icon}"></i><span>${label}</span></div>`,
        });
        ov.mount(document.body);
        icons();
    }

    let depth = 0;                              // dragenter/leave fire per child
    const show = () => ov.cls('+visible');
    const hide = () => { depth = 0; ov.cls('-visible'); };

    const onEnter = e => { e.preventDefault(); if (++depth === 1) show(); };
    const onOver  = e => e.preventDefault();    // required to allow drop
    const onLeave = e => { e.preventDefault(); if (--depth <= 0) hide(); };
    const onDrop  = e => {
        e.preventDefault();
        hide();
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) onFiles(files);
    };

    el.on('dragenter', onEnter);
    el.on('dragover', onOver);
    el.on('dragleave', onLeave);
    el.on('drop', onDrop);

    return {
        destroy() {
            el.off('dragenter', onEnter);
            el.off('dragover', onOver);
            el.off('dragleave', onLeave);
            el.off('drop', onDrop);
            hide();
        },
    };
};

// ─── 12. Iframe embed — responsive embed, child + parent ─────────────────────

const _IFRAME_MSG = 'qry:iframe-height';

/** CHILD side: measure this document's content height and post it to the parent
 *  so an embedding page can resize the iframe to fit. Pairs with `embedIframe`.
 *
 *  Measures via a zero-size sentinel appended at the end of <body> (created
 *  automatically if absent), so measurement stays accurate without app markup.
 *  Debounces resize + DOM mutations; the `min` threshold prevents resize
 *  feedback loops. Posts `{ type: 'qry:iframe-height', height }`.
 *
 *  @param {Object} [opts]
 *  @param {string} [opts.sentinel='qry-iframe-sentinel']  sentinel id (auto-created)
 *  @param {string} [opts.origin='*']      target origin for postMessage (set it in prod)
 *  @param {number} [opts.min=20]          min px change before re-posting
 *  @param {number} [opts.debounce=250]    resize/mutation debounce (ms)
 *  @returns {{ send: () => void, post: (type: string, data?: Object) => void, destroy: () => void }}
 *  @example makeIframeAutoHeight({ origin: 'https://host.example' })
 */
export const makeIframeAutoHeight = ({ sentinel = 'qry-iframe-sentinel', origin = '*', min = 20, debounce: ms = 250 } = {}) => {
    let lastH = 0, t1 = 0, t2 = 0, observer = null;

    const sid = sentinel.replace(/^#/, '');
    // Auto-create the sentinel at the end of <body> if the app didn't provide one,
    // so measurement is accurate without the app having to add markup.
    let mark = $.opt('#' + sid);
    if (!mark) {
        mark = $.create('div', { id: sid, class: 'qry-iframe-sentinel', style: 'width:0;height:0' });
        mark.mount(document.body);
    }

    const measure = () =>
        mark.getBoundingClientRect().bottom + window.scrollY;

    const send = () => {
        const h = Math.ceil(measure());
        if (lastH !== 0 && Math.abs(h - lastH) < min) return;
        lastH = h;
        window.parent.postMessage({ type: _IFRAME_MSG, height: h }, origin);
    };

    const onResize = () => { clearTimeout(t1); t1 = setTimeout(send, ms); };
    const onMutate = () => { clearTimeout(t2); t2 = setTimeout(send, ms); };

    window.on('resize', onResize, { passive: true });
    if (window.MutationObserver) {
        observer = new MutationObserver(onMutate);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    }
    // initial measure once laid out
    if (document.readyState === 'complete') send();
    else window.on('load', send);

    return {
        send,
        /** Post an app-defined message to the parent. `type` is auto-prefixed
         *  with `qry:` if not already, so it passes embedIframe's filter and
         *  reaches its onMessage hook. @example post('show-modal', { id: 42 }) */
        post(type, data = {}) {
            const t = type.startsWith('qry:') ? type : 'qry:' + type;
            window.parent.postMessage({ ...data, type: t }, origin);
        },
        destroy() {
            window.off('resize', onResize);
            observer?.disconnect();
            clearTimeout(t1); clearTimeout(t2);
        },
    };
};

/** PARENT side: listen for height messages from an embedded iframe and resize it
 *  to fit. Pairs with `makeIframeAutoHeight` running inside the iframe.
 *
 *  Only messages coming from the given iframe's window are honored (and, if
 *  `origin` is set, only from that origin) — so unrelated postMessage traffic
 *  can't drive the resize.
 *
 *  @param {string|HTMLIFrameElement} target  the iframe (selector or element)
 *  @param {Object}   [opts]
 *  @param {string}   [opts.origin]        if set, only accept messages from this origin
 *  @param {number}   [opts.min]           floor height (px) — never shrink below
 *  @param {number}   [opts.max]           ceiling height (px) — never grow above
 *  @param {number}   [opts.buffer=0]      extra px added to the reported height
 *  @param {number}   [opts.fallback]      apply this height if no message arrives…
 *  @param {number}   [opts.fallbackAfter=3000]  …within this many ms
 *  @param {Function} [opts.onMessage]     (data, event) → void for other qry:* messages
 *                                          from the iframe (e.g. app-defined events)
 *  @returns {{ destroy: () => void }}
 *  @example embedIframe('#widget', { origin: 'https://host.example', min: 800, buffer: 24 })
 *  @example embedIframe('#shop', { onMessage: d => d.type === 'qry:show-modal' && openModal(d) })
 */
export const embedIframe = (target, {
    origin, min, max, buffer = 0, fallback, fallbackAfter = 3000, onMessage,
} = {}) => {
    const frame = $(target);
    let got = false;

    const apply = px => {
        let h = px + buffer;
        if (min != null) h = Math.max(h, min);
        if (max != null) h = Math.min(h, max);
        frame.css('height', h + 'px');
    };

    const onMsg = e => {
        if (e.source !== frame.contentWindow) return;          // must be THIS iframe
        if (origin && e.origin !== origin) return;             // optional origin pin
        const d = e.data;
        if (!d || typeof d.type !== 'string' || !d.type.startsWith('qry:')) return;
        if (d.type === _IFRAME_MSG && typeof d.height === 'number') {
            got = true;
            apply(d.height);
        } else {
            onMessage?.(d, e);                                 // app-defined qry:* messages
        }
    };

    window.on('message', onMsg);

    // Fallback: if the iframe never reports a height, apply a sensible default.
    let timer = 0;
    if (fallback != null) {
        timer = setTimeout(() => { if (!got) apply(fallback); }, fallbackAfter);
    }

    return { destroy() { window.off('message', onMsg); clearTimeout(timer); } };
};

// ─── 13. Boot — one-call startup ─────────────────────────────────────────────

/** One-call convenience for the common opening sequence:
 *  apply saved/system theme → render Lucide icons → run `fn` on DOM-ready.
 *  Every step is also available standalone — use this only if it saves typing.
 *  @param {Object}   [opts]
 *  @param {Function} [opts.ready]        Run once the DOM is ready
 *  @param {boolean}  [opts.theme=true]   Apply persisted/system theme
 *  @param {boolean}  [opts.icons=true]   Render Lucide icons on ready
 *  @param {string}   [opts.title]        Sets document.title if given
 *  @example boot({ title: 'Gallery', ready: () => new Gallery() })
 */
export const boot = ({ ready, theme: useTheme = true, icons: useIcons = true, title } = {}) => {
    if (title) document.title = title;
    if (useTheme) theme.init();
    $.ready(() => {
        if (useIcons) icons();
        ready?.();
    });
};
