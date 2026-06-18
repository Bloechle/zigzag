/**
 * qry.js — Lightweight DOM library
 *
 * Prototype-based: $() returns native elements — transparent, near-zero clashes, fully chainable.
 * Utilities live under $.* — one namespace, no global pollution.
 *
 * KISS · DRY · Zero dependencies · No ES module
 *
 * @version 1.1.0
 * @author Jean-Luc Bloechle with Claude.ai
 * @license MIT
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. NULL-SAFE SINGLETON
// ═══════════════════════════════════════════════════════════════════════════

/** Fresh detached element returned when a selector matches nothing — prevents
 *  crashes. A factory, not a singleton: each failed lookup gets its own node, so
 *  two misses never share state (e.g. one `.add()` can't leak into another). */
const _nil = () => document.createElement('qry-nil');

// ═══════════════════════════════════════════════════════════════════════════
// 2. SELECTORS
// ═══════════════════════════════════════════════════════════════════════════

/** Select one element (null-safe — returns _nil if not found).
 *  Accepts a CSS selector string or an existing Element (pass-through).
 *  Uses getElementById for bare #id selectors (faster).
 *  @param {string|Element} s  CSS selector or Element
 *  @returns {Element}
 *  @example const el = $('#chart')
 *  @example const el = $('main .title')
 */
const $ = (s) => {
    if (s instanceof Element) return s;
    if (typeof s !== 'string' || !s) {
        console.warn(`$(${String(s)}) — invalid selector`);
        return _nil();
    }
    const el = s[0] === '#' && /^#[\w-]+$/.test(s)
        ? document.getElementById(s.slice(1))
        : document.querySelector(s);
    if (!el) console.warn(`$("${s}") — not found`);
    return el ?? _nil();
};

/** Select all matching elements as a real Array.
 *  @param {string} s  CSS selector
 *  @returns {Element[]}
 *  @example $.all('.btn').forEach(btn => btn.cls('active'))
 */
$.all = (s) => [...document.querySelectorAll(s)];

/** Select an OPTIONAL element: the element, or undefined — no warning, no nil.
 *  For things that may legitimately be absent; pairs with optional chaining.
 *  @param {string|Element} s  CSS selector or Element (pass-through)
 *  @returns {Element|undefined}
 *  @example $.opt('#save')?.show()
 */
$.opt = (s) => s instanceof Element ? s
    : (typeof s === 'string' && s ? document.querySelector(s) ?? undefined : undefined);

/** Create an element with optional props (attributes, handlers, text, html).
 *  @param {string} tag          Tag name
 *  @param {Object} [props={}]   Attributes (strings), event handlers (functions),
 *                               'class', 'text', 'html' (shorthands)
 *  @returns {HTMLElement}
 *  @example $.create('div', { class: 'card', text: 'Hi' })
 *  @example $.create('button', { onclick: fn })
 */
$.create = (tag, props = {}) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (typeof v === 'function') el.on(k.replace(/^on/, ''), v);
        else if (k === 'class') el.className = v;
        else if (k === 'text')  el.textContent = v;
        else if (k === 'html')  el.innerHTML = v;
        else el.setAttribute(k, v);
    }
    return el;
};

/** Run fn when DOM is ready (or immediately if already loaded).
 *  @param {Function} fn
 *  @example $.ready(() => console.log('DOM ready'))
 */
$.ready = (fn) => (document.readyState === 'loading'
    ? document.on('DOMContentLoaded', fn)
    : fn());

// ═══════════════════════════════════════════════════════════════════════════
// 3. EVENTS — on EventTarget (window, document, all elements)
// ═══════════════════════════════════════════════════════════════════════════

/** Add an event listener (chainable).
 *  @param {string}   evt    Event name
 *  @param {Function} fn     Handler
 *  @param {Object}   [opts] addEventListener options
 *  @example el.on('click', e => console.log(e))
 *  @example window.on('resize', fn)
 */
EventTarget.prototype.on = function (evt, fn, opts) {
    this.addEventListener(evt, fn, opts);
    return this;
};

/** Remove an event listener (chainable).
 *  @example el.off('click', fn)
 */
EventTarget.prototype.off = function (evt, fn) {
    this.removeEventListener(evt, fn);
    return this;
};

/** Delegated event — fires only when event target matches sel.
 *  @param {string}   sel  CSS selector for the target descendant
 *  @param {string}   evt  Event name
 *  @param {Function} fn   Handler — called with matched element as context
 *  @example list.delegate('li', 'click', function(e) { this.cls('~active') })
 */
Element.prototype.delegate = function (sel, evt, fn) {
    return this.on(evt, (e) => {
        const t = e.target.closest(sel);
        if (t && this.contains(t)) fn.call(t, e);
    });
};

/** Dispatch a bubbling, cancelable CustomEvent with an optional detail payload.
 *  For native actions, call the native method directly — it's already shorter:
 *  btn.click(), input.focus().
 *  @param {string} evt      Event name
 *  @param {any}    [detail] Payload (e.detail on the listener side)
 *  @example el.trigger('update', { value: 42 })
 */
EventTarget.prototype.trigger = function (evt, detail) {
    this.dispatchEvent(new CustomEvent(evt, { bubbles: true, cancelable: true, detail }));
    return this;
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. STYLES — on Element (HTML + SVG)
// ═══════════════════════════════════════════════════════════════════════════

/** Get computed / set one / set multiple CSS properties.
 *  @example el.css('color')                           → 'rgb(0,0,0)'
 *  @example el.css('color', 'red')                    → this
 *  @example el.css({ color: 'red', fontSize: '2em' }) → this
 */
Element.prototype.css = function (prop, val) {
    if (typeof prop === 'object') { Object.assign(this.style, prop); return this; }
    if (val === undefined) return getComputedStyle(this)[prop];
    this.style[prop] = val;
    return this;
};

/** Measure width in px (border-box) with no arg; with an arg, set CSS width.
 *  @example el.width()       → 320
 *  @example el.width(320)    → this
 */
Element.prototype.width = function (v) {
    if (v === undefined) return this.getBoundingClientRect().width;
    this.style.width = typeof v === 'number' ? v + 'px' : v;
    return this;
};

/** Measure height in px (border-box) with no arg; with an arg, set CSS height.
 *  @example el.height()      → 200
 *  @example el.height(200)   → this
 */
Element.prototype.height = function (v) {
    if (v === undefined) return this.getBoundingClientRect().height;
    this.style.height = typeof v === 'number' ? v + 'px' : v;
    return this;
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. CLASSES — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Manipulate CSS classes with prefix operators.
 *  +name  add      (default if no prefix)
 *  -name  remove
 *  ~name  toggle
 *  ?name  check    → returns boolean
 *  Multiple classes can be space-separated in a single string.
 *  @example el.cls('active')        → this   (add)
 *  @example el.cls('-active')       → this   (remove)
 *  @example el.cls('~open')         → this   (toggle)
 *  @example el.cls('?visible')      → true/false
 *  @example el.cls('+a -b ~c')      → this   (multiple)
 */
Element.prototype.cls = function (s) {
    const ops = { '+': 'add', '-': 'remove', '~': 'toggle' };
    let query;
    for (const t of s.split(' ')) {
        if (!t) continue;
        const op = ops[t[0]];
        if (op) this.classList[op](t.slice(1));
        else if (t[0] === '?') query = this.classList.contains(t.slice(1));
        else this.classList.add(t);
    }
    return query !== undefined ? query : this;
};

// ═══════════════════════════════════════════════════════════════════════════
// 6. VISIBILITY — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Show element (restores default display).  @example el.show() */
Element.prototype.show = function () { this.style.display = ''; return this; };

/** Hide element (display: none).             @example el.hide() */
Element.prototype.hide = function () { this.style.display = 'none'; return this; };

// ═══════════════════════════════════════════════════════════════════════════
// 7. ATTRIBUTES — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Get / set / remove (null) / set multiple (object) attributes.
 *  @example el.attr('href')              → '/page'
 *  @example el.attr('href', '/new')      → this
 *  @example el.attr('title', null)       → this  (removes)
 *  @example el.attr({ x: 10, y: 20 })   → this
 */
Element.prototype.attr = function (name, val) {
    if (typeof name === 'object') {
        for (const [k, v] of Object.entries(name)) this.attr(k, v);
        return this;
    }
    if (val === undefined) return this.getAttribute(name);
    val === null ? this.removeAttribute(name) : this.setAttribute(name, val);
    return this;
};

/** Get / set data-* attributes.
 *  @example el.data('id')        → '42'
 *  @example el.data('id', '42')  → this
 */
Element.prototype.data = function (key, val) {
    if (val === undefined) return this.dataset[key] ?? '';
    this.dataset[key] = val;
    return this;
};

// ═══════════════════════════════════════════════════════════════════════════
// 8. CONTENT — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Get / set text content (safe — no HTML parsing).
 *  @example el.text()         → 'Hello'
 *  @example el.text('Hello')  → this
 */
Element.prototype.text = function (v) {
    if (v === undefined) return this.textContent;
    this.textContent = v;
    return this;
};

/** Get / set inner HTML.
 *  @example el.html()                       → '<strong>Hi</strong>'
 *  @example el.html('<strong>Hi</strong>')  → this
 */
Element.prototype.html = function (v) {
    if (v === undefined) return this.innerHTML;
    this.innerHTML = v;
    return this;
};

/** Remove all children.  @example el.empty() */
Element.prototype.empty = function () { this.replaceChildren(); return this; };

/** Remove element from the DOM (chainable). Overrides the native
 *  ChildNode.remove() to return this instead of undefined; behaviour is
 *  otherwise identical.  @example el.remove() */
Element.prototype.remove = function () { this.parentNode?.removeChild(this); return this; };

// ═══════════════════════════════════════════════════════════════════════════
// 9. FORM — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Get / set the value of a form control.
 *  @example input.val()       → '42'
 *  @example input.val('42')   → this
 */
Element.prototype.val = function (v) {
    if (v === undefined) return this.value ?? '';
    this.value = v;
    return this;
};

/** Enable or disable a form control.
 *  @example input.enable()        → this  (enabled)
 *  @example input.enable(false)   → this  (disabled)
 */
Element.prototype.enable = function (s = true) { this.disabled = !s; return this; };

/** Disable a form control.  @example input.disable() */
Element.prototype.disable = function () { return this.enable(false); };

/** Serialize a form to a URLSearchParams object (chainable via .toString()).
 *  Skips disabled fields, buttons, and unchecked checkboxes/radios.
 *  @returns {URLSearchParams}
 *  @example form.serialize().toString()   → 'name=Alice&age=30'
 *  @example fetch('/api', { body: form.serialize() })
 */
Element.prototype.serialize = function () {
    const params = new URLSearchParams();
    for (const el of this.elements) {
        if (!el.name || el.disabled) continue;
        if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
        params.append(el.name, el.value);
    }
    return params;
};

// ═══════════════════════════════════════════════════════════════════════════
// 10. CHILDREN — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** @private — shared insertion helper */
const _pos = { end: 'beforeend', start: 'afterbegin', before: 'beforebegin', after: 'afterend' };

const _add = (el, content, where) => {
    if (content instanceof Element)     el.insertAdjacentElement(_pos[where], content);
    else if (typeof content === 'string') el.insertAdjacentHTML(_pos[where], content);
    return el;
};

/** Append a child (Element or HTML string) at the end.
 *  @example el.add($.create('span', { text: 'Hi' }))
 *  @example el.add('<li>Item</li>')
 */
Element.prototype.add = function (c) { return _add(this, c, 'end'); };

/** Prepend a child at the start.            @example el.addFirst(header) */
Element.prototype.addFirst = function (c) { return _add(this, c, 'start'); };

/** Insert a sibling before this element.    @example el.addBefore(separator) */
Element.prototype.addBefore = function (c) { return _add(this, c, 'before'); };

/** Insert a sibling after this element.     @example el.addAfter(note) */
Element.prototype.addAfter = function (c) { return _add(this, c, 'after'); };

/** Mount this element into a target (append).
 *  @param {string|Element} target  CSS selector or Element
 *  @example card.mount('#container')
 *  @example card.mount(parentEl)
 */
Element.prototype.mount = function (target) { $(target).add(this); return this; };

/** Mount this element into a target (prepend).  @example header.mountFirst('body') */
Element.prototype.mountFirst = function (target) { $(target).addFirst(this); return this; };

// ═══════════════════════════════════════════════════════════════════════════
// 11. TRAVERSAL — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Parent element, or nearest ancestor matching selector (null-safe).
 *  @param {string} [s]  Optional CSS selector
 *  @example el.parent()         → direct parent element
 *  @example el.parent('.card')  → nearest ancestor matching '.card'
 */
Element.prototype.parent = function (s) {
    if (!s) return this.parentElement;
    return this.parentElement?.closest(s) ?? _nil();
};

/** Next sibling element.      @example el.next() */
Element.prototype.next = function () { return this.nextElementSibling; };

/** Previous sibling element.  @example el.prev() */
Element.prototype.prev = function () { return this.previousElementSibling; };

/** querySelectorAll shortcut — returns a real Array.  @example el.find('li.active') */
Element.prototype.find = function (s) { return [...this.querySelectorAll(s)]; };

/** Direct children, optionally filtered by selector.  @example ul.childs('li.done') */
Element.prototype.childs = function (s) {
    const c = [...this.children];
    return s ? c.filter((el) => el.matches(s)) : c;
};

/** Siblings (excluding self), optionally filtered.  @example el.sibs('.active') */
Element.prototype.sibs = function (s) {
    const c = [...(this.parentElement?.children ?? [])].filter((el) => el !== this);
    return s ? c.filter((el) => el.matches(s)) : c;
};

/** Index among siblings (0-based).  @example el.idx()  → 2 */
Element.prototype.idx = function () {
    return this.parentElement ? [...this.parentElement.children].indexOf(this) : -1;
};

// ═══════════════════════════════════════════════════════════════════════════
// 12. MANIPULATION — on Element
// ═══════════════════════════════════════════════════════════════════════════

/** Deep clone this element.  @example const copy = el.clone() */
Element.prototype.clone = function (deep = true) { return this.cloneNode(deep); };

/** Replace this element with content. Returns the replacement — for an HTML
 *  string, the first inserted element (null if the HTML contains none).
 *  @example const newEl = el.swap('<div class="new">...</div>')
 */
Element.prototype.swap = function (content) {
    if (typeof content === 'string') {
        const tpl = document.createElement('template');
        tpl.innerHTML = content;
        const r = tpl.content.firstElementChild;
        this.replaceWith(tpl.content);
        return r;
    }
    this.replaceWith(content);
    return content;
};

/** Test whether this element matches a CSS selector.
 *  @example el.is('.active')   → true/false
 */
Element.prototype.is = function (s) { return this.matches(s); };

/** Wrap this element inside an HTML structure.  @example el.wrap('<div class="wrapper">') */
Element.prototype.wrap = function (html) {
    const w = document.createElement('div');
    w.innerHTML = html;
    const c = w.firstElementChild;
    this.parentNode?.insertBefore(c, this);
    c.appendChild(this);
    return this;
};

/** Get position relative to the document (top + left).
 *  @example const { top, left } = el.offset()
 */
Element.prototype.offset = function () {
    const r = this.getBoundingClientRect();
    return { top: r.top + scrollY, left: r.left + scrollX };
};

// ═══════════════════════════════════════════════════════════════════════════
// 12b. LEGACY SHADOW FIXES
// ═══════════════════════════════════════════════════════════════════════════

/* A few specific prototypes carry legacy members that shadow the qry methods
 * defined on Element.prototype, making them silently unavailable there
 * (e.g. `$('a').text('Hi')` would throw — HTMLAnchorElement.text is a legacy
 * string accessor). Re-assert the qry method where the native member is a
 * vestigial alias nobody should rely on:
 *   .text  on <a>, <option>, <script>   (legacy aliases of textContent)
 *   .data  on <object>                  (legacy reflection of the data attr)
 *   .add   on <select>                  (native add(option, before) — the qry
 *                                        add(el|html) covers the common case)
 * Deliberately NOT touched: width/height on <img>/<canvas>/<video>/<iframe>/
 * <embed>/<object>/<td> — `canvas.width = …` must keep resizing the bitmap.
 * Use el.css('width') / getBoundingClientRect() there. Likewise <dialog>
 * keeps its native show(). defineProperty is required: plain assignment would
 * trip the legacy accessor's setter instead of replacing it. */
{
    const P = Element.prototype;
    const fix = (proto, name) =>
        Object.defineProperty(proto, name, { value: P[name], writable: true, configurable: true });
    [HTMLAnchorElement, HTMLOptionElement, HTMLScriptElement].forEach(C => fix(C.prototype, 'text'));
    fix(HTMLObjectElement.prototype, 'data');
    fix(HTMLSelectElement.prototype, 'add');
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. SCALE
// ═══════════════════════════════════════════════════════════════════════════

/** Map a value linearly from one range to another.
 *  @param {number} val    Input value
 *  @param {number} inMin  Input minimum
 *  @param {number} inMax  Input maximum
 *  @param {number} outMin Output minimum
 *  @param {number} outMax Output maximum
 *  @returns {number}
 *  @example $.scale(82, 0, 100, 0, 500)    → 410
 *  @example $.scale(82, 0, 100, 300, 0)    → 54   (inverted for SVG y-axis)
 */
$.scale = (val, inMin, inMax, outMin, outMax) =>
    outMin + ((val - inMin) / (inMax - inMin)) * (outMax - outMin);

// ═══════════════════════════════════════════════════════════════════════════
// 14. CONSOLE
// ═══════════════════════════════════════════════════════════════════════════

/** @example $.log('loaded', data.length, 'rows')  */
$.log   = console.log.bind(console);

/** @example $.warn('Missing value at row', i)  */
$.warn  = console.warn.bind(console);

/** @example $.error('Failed to load', url)  */
$.error = console.error.bind(console);

/** @example $.debug('scale input', val)  */
$.debug = console.debug.bind(console);

// ═══════════════════════════════════════════════════════════════════════════
// 15. DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

/** @private — fetch with an HTTP-status check, so a 404/500 throws a readable
 *  error instead of an opaque parse failure on the error-page body. */
const _fetch = (url) =>
    fetch(url).then((r) => {
        if (!r.ok) throw new Error(`$.load — ${r.status} ${r.statusText} — ${url}`);
        return r;
    });

/** Parse CSV text. Honors quoted fields, `""` escapes, separators and
 *  newlines inside quotes, a leading BOM, and CRLF/CR line endings. Blank
 *  lines are skipped. Values stay strings — convert with +v or parseFloat(v).
 *
 *  With `headers` (default), the first row names the columns and each data
 *  row becomes an object. With `headers: false`, returns string arrays.
 *
 *  @param {string} text  Raw CSV text
 *  @param {Object} [opts]
 *  @param {string}  [opts.sep=',']       Column separator (',' '\t' ';'…)
 *  @param {boolean} [opts.headers=true]  First row is a header row
 *  @param {boolean} [opts.trim=true]     Trim each field
 *  @returns {Object[]|string[][]}
 *  @example $.parseCSV('a,b\n1,"x,y"')                    → [{ a:'1', b:'x,y' }]
 *  @example $.parseCSV('1;2\n3;4', { sep:';', headers:false }) → [['1','2'],['3','4']]
 */
$.parseCSV = (text, { sep = ',', headers = true, trim = true } = {}) => {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
    const rows = [[]];
    let cur = '', q = false;
    const endField = () => { rows[rows.length - 1].push(trim ? cur.trim() : cur); cur = ''; };
    const endRow   = () => { endField(); rows.push([]); };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (q && text[i + 1] === '"') { cur += '"'; i++; }   // "" escape
            else q = !q;
        }
        else if (!q && c === sep)  endField();
        else if (!q && c === '\n') endRow();
        else if (!q && c === '\r') { endRow(); if (text[i + 1] === '\n') i++; }
        else cur += c;
    }
    endField();
    const out = rows.filter((r) => r.length > 1 || r[0] !== '');  // drop blank lines
    if (!out.length || !headers) return out;
    const keys = out[0];
    return out.slice(1).map((vals) =>
        Object.fromEntries(keys.map((k, i) => [k, vals[i] ?? ''])));
};

/** Data loaders — $.load.json(), $.load.csv()
 *  @namespace $.load
 */
$.load = {
    /** Load and parse a JSON file.
     *  @param {string} url
     *  @returns {Promise<any>}
     *  @example const data = await $.load.json('./data/countries.json')
     */
    json: (url) => _fetch(url).then((r) => r.json()),

    /** Load and parse a CSV file into an array of objects — see $.parseCSV
     *  for parsing rules and options.
     *  @param {string} url
     *  @param {Object} [opts]  { sep, headers, trim }
     *  @returns {Promise<Object[]>}
     *  @example const data = await $.load.csv('./data/pop.csv')
     *  @example const data = await $.load.csv('./data/pop.tsv', { sep: '\t' })
     */
    csv: (url, opts) => _fetch(url).then((r) => r.text()).then((text) => $.parseCSV(text, opts)),
};

// ═══════════════════════════════════════════════════════════════════════════
// 16. TOOLTIP — lazy: DOM created on first show()
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tooltip — one per page, follows the mouse.
 *
 *  High-level: bind all three listeners in one call.
 *  @param {Element}        el        Target element
 *  @param {string}         title     Tooltip title (plain text)
 *  @param {string}         content   Tooltip body (may contain HTML)
 *  @param {Function}       [onEnter] Optional callback on mouseenter (after show)
 *  @param {Function}       [onLeave] Optional callback on mouseleave (after hide)
 *  @example $.tip(circle, 'France', '67.4M inhabitants')
 *  @example $.tip(slice, d.name, d.value, () => slice.css('opacity', '0.7'))
 *
 *  Low-level: full control (e.g. suppress tooltip while dragging).
 *  @example $.tip.show(e, 'France', '67.4M inhabitants')
 *  @example $.tip.move(e)
 *  @example $.tip.hide()
 */
$.tip = (el, title, content, onEnter, onLeave) => {
    return el.on('mouseenter', (e) => { $.tip.show(e, title, content); if (onEnter) onEnter(); })
        .on('mousemove',  (e) => $.tip.move(e))
        .on('mouseleave', ()  => { $.tip.hide();                  if (onLeave) onLeave(); });
};

$.tip._el = null;
$.tip._t  = null;
$.tip._c  = null;

$.tip._init = () => {
    if ($.tip._el) return;
    $.tip._t  = $.create('p',   { id: 'qry-tooltip-title' });
    $.tip._c  = $.create('p',   { id: 'qry-tooltip-content' });
    $.tip._el = $.create('div', { id: 'qry-tooltip' });
    $.tip._el.add($.tip._t).add($.tip._c);
    document.body.add($.tip._el);
    // Mechanics only — appearance is the project's job. Style #qry-tooltip,
    // #qry-tooltip-title and #qry-tooltip-content in your own CSS (background,
    // padding, border-radius, shadow, fonts, colors). The lib only guarantees the
    // tooltip positions, fades, floats above content and never eats the mouse.
    const style = $.create('style', { text: `
        #qry-tooltip {
            position: absolute;          /* required: move() sets left/top */
            pointer-events: none;        /* required: never intercept the mouse */
            opacity: 0;                  /* hidden until show() sets it to 1 */
            transition: opacity 0.15s;   /* fade driven by show()/hide() */
            z-index: 1000;               /* float above page content */
        }
        #qry-tooltip-title, #qry-tooltip-content { margin: 0; }  /* neutralize UA <p> margins */
    `});
    document.head.add(style);
};

/** Show tooltip near the mouse with a title and content. */
$.tip.show = (e, title, content) => {
    $.tip._init();
    $.tip._t.textContent = title;
    $.tip._c.innerHTML   = content;
    $.tip._el.style.opacity = '1';
    $.tip.move(e);
};

/** Move tooltip to follow the mouse. */
$.tip.move = (e) => {
    if (!$.tip._el) return;
    $.tip._el.style.left = e.pageX + 20 + 'px';
    $.tip._el.style.top  = e.pageY - 10 + 'px';
};

/** Hide tooltip (fade out via CSS transition). */
$.tip.hide = () => { if ($.tip._el) $.tip._el.style.opacity = '0'; };

// ═══════════════════════════════════════════════════════════════════════════
// 17. GLOBAL EXPORT
// ═══════════════════════════════════════════════════════════════════════════

window.$ = $;
