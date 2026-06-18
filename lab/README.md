# ZQS Lab

Blind binarization quality lab, **fully client-side** — ZigZag, the 19-method
committee and the ZQS metric all run in the browser (a Web Worker). No server.

## Layout
```
lab/
├── app/              the web app (static)
│   ├── index.html    shell (Shoelace + qry stack, CSP-locked)
│   ├── app.js        UI logic — worker-driven, folder / demo / drop-paste
│   ├── worker.js     module worker: ZigZag + committee + ZQS off the UI thread
│   ├── zigzag.js     the ZigZag engine (DocEng'24)
│   ├── binarizers.js the 19 committee methods        ┐ verified numerically
│   ├── zqs.js        the blind ZQS metric            │ vs the Python reference
│   ├── imageops.js   shared primitives               ┘ (see verify/)
│   ├── ui.js zqs.css widget factories + styles
│   ├── qry/          vendored qry stack
│   └── make-manifest.mjs   generate ../wezut/index.json from the images
├── wezut/            demo image set (sibling of app/) + index.json
└── verify/           optional JS↔Python fidelity check
```

## Run locally
ES modules + a module worker don't load from `file://`, and the app fetches the
**sibling** `../wezut/`, so serve from **`lab/`** (not `lab/app/`):
```sh
cd lab
python -m http.server            # then open http://localhost:8000/app/
```
Serving `lab/app/` directly would put `../wezut/` outside the web root — serve `lab/`.

## Deploy
Publish the whole `lab/` directory to any static host (e.g. GitHub Pages) and
link to `/app/`. The app's home is `app/index.html`; `wezut/` rides alongside.

## Demo set
Drop WEZUT photos into `wezut/`, then `node app/make-manifest.mjs wezut` (from
`lab/`), reload, click **Demo set**. Or just use **Open folder…** on your own
scans — no manifest, no server. Details in `wezut/README.md`.

## Fidelity
The committee and ZQS were checked against the Python reference: 19/19 methods at
100.000 % pixel agreement; ZQS scalar + every gate at 0.0000 error (only the
diagnostic `q_stroke`, not in the score, drifts ≤0.1 on flood cases). Reproduce
with `verify/` (needs Python numpy + opencv). CPO is omitted (diagnostic, absent
from the lab score).
