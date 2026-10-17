---
name: zigzag
description: "Develop Jean-Luc Bloechle's ZigZag repository (Bloechle/zigzag, public, AGPL): the document binarization algorithm of DocEng 2024 in three bit-identical ports (ports/zigzag.py, ports/ZigZag.java, js/zigzag.js), the WebGPU accelerator (js/zigzag-gpu.js), the PWA web app (index.html, sw.js) published by GitHub Pages, and its two gates (tools/parity.py, tools/app_check.py). Use it for any change to a port, the app, the gates, the defaults (automatic size, despeckle, weight), a release or the docs of this repo. Benchmarking ZigZag against other methods (binbench, db50, DocEng/ICDAR competitions) is NOT here: it lives in the account skill of the same name, which is private."
---

# ZigZag — working on the repository

Read `AGENTS.md` first (map, rules, gates). This skill carries what the card does not:
how the ports stay identical, the defaults and why, the pitfalls already paid for,
and the release procedure. It lives in the repo and is updated by commit, in the same
commit as the change it records; the account skill `zigzag` points here and keeps the
private evaluation tooling (binbench, the db50 results, competition notes), which a
public repository must not carry.

## The pipeline, in the order the code runs it

1. Rec. 601 luma, round-half-up: `floor(0.299 R + 0.587 G + 0.114 B + 0.5)`.
2. Pass A: background where `gray >= weight% × local mean` over a `size`×`size` window
   (zero-padded sums divided by the true clamped pixel count).
3. Pass B: `fg = 255` where `gray >= mean of background pixels` (or no background in the
   window), else `min(255, gray × 256 / max(1, mean_bg))`.
4. Otsu on the `fg` histogram with a 10 % margin crop, first maximum, capped at 250;
   plus `threshold_offset`, clamped to 0–255.
5. Despeckle: 8-connected components of `fg < thr` smaller than the area become 255.
6. Output: binary (2× by default), gray or color, all three from the cleaned `fg`.

The despeckle sits on the 1× foreground on purpose: a removed speck's 8-neighbours are
all paper, so every bilinear 2× sample around it is paper too — one pass serves the
three modes and both resolutions.

## Defaults and why

- **size: automatic**, `clamp(floor(sqrt(w² + h²) / 45 + 0.5), 20, 250)`. Measured on
  synthetic pages at three resolutions: every fixed size loses somewhere (30 at high
  resolution, 80 at low), the rule loses nowhere. It is insurance, not a gain. A
  content-based size (from the stroke width) was measured and rejected: the output would
  depend on the content, and parity and reproducibility with it.
- **weight: 90.** 85 and 90 tie at the top of the 60–100 sweep; 100 is clearly worse.
  The old advice to lower it to ~60 for degraded documents was not supported by any
  measurement and is gone — do not reintroduce it.
- **despeckle: `round(size² / 225)`**, written `(2·size² + 225) div 450` in integers. An
  area, so it scales as the square of the window (2 px at size 20, 4 at 30, 12 at 52,
  26 at 77). The largest measured gain of all: dark, noisy pages lose their
  salt-and-pepper (normalising by a small background amplifies sensor noise, and the
  global Otsu cannot tell it from faint ink). A fixed constant would eat i-dots and
  punctuation at low resolution. `despeckle=0` turns it off (music, dotted scripts).

The evaluation behind these numbers is in the account skill (private).

## How the ports stay identical

`tools/parity.py` is the proof (13 images × 3 modes × 6 parameter sets × 2 ports = 468
comparisons, plus the size rule on ~10 000 dimensions). What it relies on:

- **Same float64 operations, same order.** `a*(1-f) + b*f` with the vertical pass before
  the horizontal one; the 2× upsampling at fixed weights 0.25 / 0.75 (four "phases" in
  Python, two output rows per source row in Java/JS) keeps exactly those products.
- **Running sums add, then remove, in the same order.** Java/JS split the horizontal
  loop into bounds-free segments and walk the vertical pass row by row with one
  accumulator per column — same additions, same order, sequential memory.
- **Rounding written out.** `floor(x + 0.5)`, never a language's `round` (they differ
  on .5); `sqrt(w*w + h*h)`, never `hypot` (not correctly rounded everywhere); the
  despeckle area in integers (Java in `long`).
- **Integers exact in float64.** Box sums of integer samples stay exact, so OpenCV's
  separable filter, CuPy's integral image and the Java/JS running sums agree.
- **The GPU is float32**: box sums exact up to a 254 px window (`(2r+1)² × 255 < 2²⁴`);
  divisions differ, so a handful of gray/color pixels may be off by one level.
  `tools/app_check.py` measures it (binary identical on the example; gray/color ~10⁻⁷).
  The GPU imports `resolveOptions`, Otsu and `despeckle` from `zigzag.js`: one copy.
- Connected components are unique whatever the algorithm: OpenCV in Python (on the
  host even for CuPy), union-find with the size stored negative at the root in Java/JS.

## Pitfalls already paid for

- Java `TYPE_BYTE_GRAY` / `TYPE_USHORT_GRAY` + `getRGB()` applies a silent linear→sRGB
  conversion (1 → 13, 128 → 186). Read raster samples; `getRGB()` only for palettes.
- Glob: both CLIs expand `*`, `?`, `**` themselves (Windows shells don't). Java's `**`
  must span a directory, so the collapsed form (`/**/` → `/`, leading `**/` removed) is
  matched too; a wildcard in a folder name walks from the fixed prefix.
- WebGPU's default storage binding limit is 128 MiB (~8.4 MP at 16 B/px): `init()`
  requests the adapter's limits and exposes `maxPixels`. Every submit runs in a
  validation error scope, so a failed dispatch throws and the CPU fallback fires.
- Headless Chromium has WebGPU with `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`.
  `context.set_offline()` does not stop a service worker's own fetches: stop the server
  to test offline.
- The app awaits nothing at load (GPU init in the background, loads await it); a failed
  run never leaves the spinner up; an image sized for the GPU is shrunk for the CPU if
  the GPU fails on upload or on processing; settings saved before 1.1 with the old 30 px
  default move to Auto (`PREFS_VERSION`).
- A browser that refuses the 2× canvas gets 1×, never a blank result.
- f-strings with a backslash inside `{}` need Python 3.12; the CLI stays 3.8-compatible.
- `sw.js` must stay at the root (Pages cannot set `Service-Worker-Allowed`).
- Award wording: SIGWEB DocEng Best Paper Award (the Engelbart award is Hypertext's).
- IntelliJ builds into `out/`; it stays in `.gitignore`.

## Releasing a version

1. Change the three ports together; `python tools/parity.py`.
2. Version in `ports/zigzag.py` (`__version__`), `ports/ZigZag.java` (`VERSION`),
   `js/zigzag.js` (`VERSION`), `CITATION.cff`; CHANGELOG entry saying how to reproduce
   the previous output when the default changes.
3. Regenerate `examples/*_ZZ.png` with `python ports/zigzag.py examples/02_04.jpg
   examples/10_18.jpg -o examples/`.
4. Touching the app: bump `CACHE` in `sw.js`; `python tools/app_check.py`.
5. Push to `main` (this publishes the app). The account skill's evaluation tool keeps a
   verbatim copy of `ports/zigzag.py`: re-copy it there, or it benchmarks an old version.

## Where this stands (2026-10-17)

Version 1.2.0: automatic size (1.1) and despeckle (1.2) are the defaults; the README's
weight advice is corrected. Both gates in CI. No open item from the September plan.
