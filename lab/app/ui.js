/**
 * ui.js — TopPod widget helpers on the qry stack.
 * Thin factories over Shoelace (<sl-button>, <sl-range>, <sl-select>) and
 * qry-ui.css components (.qry-info-row, .qry-chip). App-level by design:
 * the stack ships no widget factories — Shoelace is the widget layer.
 */

// ── Rows (label / value) ─────────────────────────────────────────────────

export const makeRowHtml = (label, value, cls = '') =>
    `<div class="qry-info-row"><span class="qry-info-label">${label}</span>` +
    `<span class="qry-info-value${cls ? ' ' + cls : ''}">${value}</span></div>`;

export const makeRow = (label, value, cls = '') => {
    const row = $.create('div', { class: 'qry-info-row' });
    row.add($.create('span', { class: 'qry-info-label', text: label }));
    row.add($.create('span', { class: `qry-info-value${cls ? ' ' + cls : ''}`, text: value }));
    return row;
};

// ── Button (Shoelace) ────────────────────────────────────────────────────

export const makeBtn = (label, onClick, opts = {}) => {
    const btn = $.create('sl-button', { text: label });
    btn.variant = opts.variant ?? 'default';
    btn.size = opts.size ?? 'small';
    if (opts.cls) btn.cls(opts.cls);
    if (onClick) btn.on('click', onClick);
    return btn;
};

// ── Slider (Shoelace range + persistent value readout) ──────────────────

export const makeSlider = (label, value, min, max, step, onChange) => {
    const fmt = v => step < 1 ? v.toFixed(2) : `${v}`;
    const wrap = $.create('div', { class: 'tp-slider' });
    const head = $.create('div', { class: 'tp-slider-head' });
    head.add($.create('span', { text: label }));
    const val = $.create('span', { class: 'tp-slider-val qry-mono', text: fmt(value) });
    head.add(val);
    const range = $.create('sl-range', { min, max, step });
    range.value = value;
    range.tooltip = 'none';
    range.on('sl-input', () => { onChange(range.value); val.text(fmt(range.value)); });
    wrap.add(head).add(range);
    return wrap;
};

// ── Select (Shoelace) ────────────────────────────────────────────────────

export const makeSelect = (label, options, selected, onChange) => {
    const sel = $.create('sl-select');
    sel.size = 'small';
    if (label) sel.label = label;
    for (const opt of options) {
        const o = $.create('sl-option', { text: opt.label ?? opt });
        o.value = opt.value ?? opt;
        sel.add(o);
    }
    sel.value = selected;
    sel.on('sl-change', () => onChange(sel.value));
    return sel;
};

// ── Chips (qry-ui pills) ─────────────────────────────────────────────────

export const makeChips = (items, selected, onClick, opts = {}) => {
    const wrap = $.create('div', { class: 'flex flex-wrap gap-2' });
    for (const item of items) {
        const key = item.key ?? item.name ?? item.label ?? item;
        const sel = opts.nearFn ? opts.nearFn(item, selected) : key === selected;
        const chip = opts.renderChip
            ? opts.renderChip(item, sel)
            : $.create('div', { class: `qry-chip${sel ? ' selected' : ''}`, text: item.label ?? item });
        chip.on('click', () => onClick(item));
        wrap.add(chip);
    }
    return wrap;
};
