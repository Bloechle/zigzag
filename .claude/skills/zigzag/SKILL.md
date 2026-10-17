---
name: zigzag
description: "Develop Jean-Luc Bloechle's ZigZag repository (Bloechle/zigzag, public, AGPL): the document binarization algorithm of DocEng 2024 in three bit-identical ports (ports/zigzag.py, ports/ZigZag.java on Java 11+, js/zigzag.js), the WebGPU accelerator (js/zigzag-gpu.js), the PWA web app (index.html, sw.js) published by GitHub Pages, and its two gates (tools/parity.py, tools/app_check.py). Use it for any change to a port, the app, the gates, the defaults (automatic size, despeckle, weight), a release or the docs of this repo. Benchmarking ZigZag against other methods (binbench, db50, the sweeps behind the defaults, DocEng/ICDAR competitions) is NOT here: it lives in the private repository Bloechle/UniFR (skill zigzag-eval)."
---

# ZigZag — working on the repository

Read `AGENTS.md` first (map, rules, gates). This skill carries what the card does not:
how the ports stay identical, the defaults and why, the pitfalls already paid for,
and the release procedure. It lives in the repo and is updated by commit, in the same
commit as the change it records. The evaluation (binbench, the db50 results, the sweeps
behind each default, competition notes) lives in the private repository `Bloechle/UniFR`
(`research/zigzag/`, skill `zigzag-eval`).

**What is public**: what anyone can check from this repository alone — the algorithm, the
defaults and their rules, a one-line reason for each, speed, parity. **What is not**:
anything that compares ZigZag with other methods or rests on our own test pages (scores,
sweeps, the measured gain of a default, rankings, competition remarks). Moving a fact
across that line is Jean-Luc's decision, never a side effect of a commit.

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

- **size: automatic**, `clamp(floor(sqrt(w² + h²) / 45 + 0.5), 20, 250)`. A window in
  pixels is right at one resolution only; the rule follows the image. A size computed
  from the content (the stroke width) is ruled out: the output would depend on the
  content, and parity and reproducibility with it.
- **weight: 90.** 85–90 suits clean and degraded pages alike; 100 is too strict. The old
  advice to lower it to ~60 for degraded documents is withdrawn — do not reintroduce it.
- **despeckle: `round(size² / 225)`**, written `(2·size² + 225) div 450` in integers. An
  area, so it scales as the square of the window (2 px at size 20, 4 at 30, 12 at 52,
  26 at 77): dark, noisy pages lose their salt-and-pepper (normalising by a small
  background amplifies sensor noise, and the global Otsu cannot tell it from faint ink),
  while a fixed constant would eat i-dots and punctuation at low resolution.
  `despeckle=0` turns it off (music, dotted scripts).

The measurements behind these choices are in `Bloechle/UniFR` (private); quote none of
them here.

## How the ports stay identical

`tools/parity.py` is the proof (13 images × 3 modes × 6 parameter sets × 2 ports = 468
comparisons, plus the size rule on ~10 000 dimensions; CI runs it on JDK 11, 21 and 25).
What it relies on:

- **Same float64 operations, same order** wherever the values are not integers:
  `a*(1-f) + b*f` with the vertical pass before the horizontal one; the 2× upsampling at
  fixed weights 0.25 / 0.75 (two output rows per source row in Java/JS, gathered around
  the ink in Python) keeps exactly those products; never a fused multiply-add.
- **Box sums are integers.** Inputs are bytes (gray levels, 0/1 flags, masked gray),
  sums int32 (OpenCV `CV_32S` in Python, `int[]` / `Int32Array` elsewhere): exact in any
  order, so the summation order is free — optimise it at will. `255 × (2r+1)²` must fit
  an int32, hence `MAX_SIZE = 2048` in the three ports. They convert to exactly the
  doubles the old float64 sums gave.
- **Rounding written out.** `floor(x + 0.5)`, never a language's `round` (they differ
  on .5); `sqrt(w*w + h*h)`, never `hypot` (not correctly rounded everywhere); the
  despeckle area in integers (Java in `long`).
- **Integers exact in float64.** Box sums of integer samples stay exact, so OpenCV's
  separable filter, CuPy's integral image and the Java/JS running sums agree.
- **The GPU is float32**: box sums exact up to a 255 px window (`(2r+1)² × 255 < 2²⁴`);
  divisions differ, so a handful of gray/color pixels may be off by one level.
  `tools/app_check.py` measures it (binary identical on the example; gray/color ~10⁻⁷).
  The GPU imports `resolveOptions`, Otsu and `despeckle` from `zigzag.js`: one copy.
- Connected components are unique whatever the algorithm: OpenCV in Python (on the
  host even for CuPy); in Java/JS a union-find over horizontal runs of ink (a run per
  node, joined to the touching runs of the row above), the size stored negative at the
  root — 1.7× faster than a node per pixel on a text page.

## Speed: what is done, and where it is (1.3)

`examples/01_letter.jpg` (5.4 MP), binary output, two cores: Python 0.47 s, JS 0.33 s, Java 0.14 s
(the 1.3 CHANGELOG figures were measured on the former 5.6 MP example).

- **No incubator or preview code, in any port** (Jean-Luc's rule). The Java port had
  Vector API kernels in 1.3.0–1.3.1 (Pass A, Pass B, the 2× binarization, the coverage):
  about 1.3× in Java on AVX2 / AVX-512, nothing on ARM. Removed in 1.3.2 while the API
  incubates (it waits for Valhalla to reach preview); they are in commit `e0f6fa4` (1.3.1), bit-identical
  to the scalar loops, and can return once the API is final. When they do: species as
  `static final` constants (built at run time, every operation leaves the intrinsic path
  and the loop runs 3–30× slower than scalar); kernels only with 4–8 double lanes
  (slower than plain loops below 256 bits); no fused multiply-add; measure each kernel
  against its scalar twin, and run parity with `-XX:UseAVX=0` too.
- **Java**: integer box sums sharing their scratch buffers, rows in parallel
  (`IntStream.parallel`), gray straight from the JPEG raster bytes, the color output
  written into the raster.
- **Python**: the 2× samples only around the ink. A sample reads the 3×3 neighbourhood;
  when all nine values are ≥ the (integer) threshold the sample is too — T/4 and 3T/4 are
  exact and rounding is monotonic — so paper needs no arithmetic. The converse does not
  hold (values all below T can round up to T): never skip the ink side.
- **JS**: no SIMD (WebAssembly would be a rewrite); int32 sums with `| 0`, the vertical
  pass as "row y-1 plus the entering row minus the leaving row", per-column window
  counts. Its remaining time is the divisions of Pass A and Pass B.
- **Web app, CPU path** (1.3.1): `zigzag-worker.js` coordinates helper workers (the same
  file) that each compute `ZigZag.foreground` for a band of rows `[y0, y1)` from the rows
  `ZigZag.bandRows` gives, `[y0-2r, y1+2r)` — Pass A needs r rows of mask around Pass B's
  window, which needs r more — plus its histogram; bands assemble into exactly the
  whole-image values. `finish` (Otsu, despeckle, output) stays serial: components cross
  bands. 1 MP minimum, eight cores at most. Helpers are stateless (1.3.4): each run slices
  a band's rows and transfers them, so no helper keeps a copy of the image (before, each
  kept a full one: 7 × 4 B/px on eight cores). Measured on two cores in Chromium, median
  of 9: serial 750–1080 ms, bands 600–790 ms in binary (the VM is noisy); worth keeping
  for browsers without WebGPU on multi-core phones. `parity.py` checks the bands, sliced
  rows included; `app_check.py` compares the worker's result with `ZigZag.process`.
- Measured and rejected: computing the Pass B division only on pixels darker than their
  background (53 % of a page are, no gain); a full 16 MB RGB→gray lookup table; a
  WebAssembly Pass B (about 1.5× the JS loop, and WASM SIMD has no float64 division to
  gain on — not worth a fourth port).
- The speed figures are measured with `research/zigzag/speed.py` of `Bloechle/UniFR` (best of six
  runs per mode, the three ports of a clone of this repo).

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
  run never leaves the spinner up. One run at a time (`running`); a new source, a rotation
  or New waits for it (`idle()`) before touching the GPU buffers or the worker's copy, and
  a result for an image no longer shown is dropped — uploading mid-run destroyed the
  buffers of the job in flight, and New mid-run left the worker's bands waiting forever
  (`app_check.py` clicks New during a run). The worker fails its bands in flight before
  terminating helpers, and a helper error makes it serial for good; an image sized for the GPU is shrunk for the CPU if
  the GPU fails on upload or on processing; settings saved before 1.1 with the old 30 px
  default move to Auto (`PREFS_VERSION`).
- A browser that refuses the 2× canvas gets 1×, never a blank result.
- `toImageData` floors the downscaled size: rounded, 1968×2730 into 4 MP gave 1698×2356 =
  4 000 488 px, still over the CPU budget, so `setSource` shrank it again, forever (the page
  froze without WebGPU). `01_letter.jpg` has exactly those dimensions: `app_check.py` covers it.
- f-strings with a backslash inside `{}` need Python 3.12: keep them out of the port (CI
  runs 3.12 only, so nothing else checks it).
- CLI output stays ASCII (`->`, not `→`): a Windows console or a redirect in cp1252 raises
  `UnicodeEncodeError` mid-batch. OpenCV 5's `imwrite` raises instead of returning False;
  Java's `ImageIO.write(img, fmt, File)` prints a stack trace on a bad path, so the CLI
  writes through its own stream. A write error fails that image, never the batch.
- Options are validated alike in the three ports: an integer threshold offset (added in
  `long` in Java), `auto` only for size and despeckle, empty images rejected, the size
  bounded to 2048 when the CLI parses it.
- The browser canvas stores premultiplied alpha, so a transparent pixel reads back as
  black ink: `toImageData` paints white under the image.
- Java lambdas only capture effectively-final locals: do not null an array (to free it)
  that a lambda in the same method reads.
- The Java port must compile with `javac --release 11`: check it after any Java change
  (CI's JDK 11 job does too).
- `sw.js` must stay at the root (Pages cannot set `Service-Worker-Allowed`).
- Award wording: DocEng '24 Best Paper Award, linked to ACM's list
  (acm.org/conferences/best-paper-awards-2024); sigweb.org/awards is Hypertext's Engelbart
  page. The 2024 competition is cited for what its abstract states (23 new and 75 classical
  algorithms assessed); no ranking is claimed here — that is evaluation, see UniFR.
- IntelliJ builds into `out/`; it stays in `.gitignore`.

## Releasing a version

1. Change the three ports together; `python tools/parity.py`.
2. Version in `ports/zigzag.py` (`__version__`), `ports/ZigZag.java` (`VERSION`),
   `js/zigzag.js` (`VERSION`), `CITATION.cff`; CHANGELOG entry saying how to reproduce
   the previous output when the default changes.
3. Regenerate `examples/*_ZZ.png` with `python ports/zigzag.py "examples/*.jpg" -o examples/`
   (quote the pattern: the CLI expands it, also on Windows).
4. Touching the app: bump `CACHE` in `sw.js`; `python tools/app_check.py`.
5. Push to `main` (this publishes the app). The private benchmark loads the port from a
   clone, so nothing needs copying; a default change is measured there before it ships.

## Where this stands (2026-10-17)

Version 1.3.5: automatic size (1.1) and despeckle (1.2) are the defaults; 1.3 is the same
output, faster in all ports, 1.3.1 spreads the app's CPU path over the cores, and 1.3.2
removes the incubating Vector API (Java 11+ again); 1.3.3 is an audit's fixes, 1.3.4 stateless band helpers, 1.3.5 our own examples. Both gates in CI. Open option: band-parallel output stage (the
serial remainder, ~134 ms binary on a 5.6 MP photo).

The six examples (1.3.5) are synthetic photos of original pages, generated by `research/zigzag/examples.py`
in `Bloechle/UniFR` (binbench's renderer and camera model, fixed seeds). The former two came
from a third-party dataset (WEZUT, ZUT Szczecin) and are gone; never add third-party images.
An example must lose no text and leave no shadow black in its default output (Jean-Luc's bar:
ten were made, six kept).
