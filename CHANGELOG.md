# Changelog

Versions are shared by the three ports (Python, Java, JavaScript), which stay bit-identical. A minor version may change the default output; each entry says how to reproduce the previous one.

## 1.3.5 — 2026-10-17

**Same output as 1.3.4, bit for bit.** New examples.

- `examples/`: six document photos of our own replace the two former ones, which came from a third-party dataset. The pages carry original text (a letter, a timetable, a manual, a filled-in form, a highlighted revision sheet, a notice) and are photographed in simulation under different lights: cast shadow, flash, weak toner, crumpled paper. Each comes with its default output.
- Web app: "try an example" opens `01_letter.jpg`. Fixed: without WebGPU, a photo whose downscaled size rounded up past the 4 MP CPU budget (1968×2730, for one) was shrunk again and again and froze the page; the size is now rounded down.
- README: speed quoted on that photo (5.4 MP): about 0.14 s in Java, 0.33 s in JavaScript, 0.47 s in Python on two cores.

## 1.3.4 — 2026-10-17

**Same output as 1.3.3, bit for bit.**

- Web app: the CPU worker's helpers no longer keep a copy of the image. Each run hands every helper only the rows its band reads (its own plus a margin of twice the half-window, `ZigZag.bandRows`), transferred rather than copied, and freed with the run; on an eight-core phone the helpers held seven full copies of the image before. Same speed on two cores in Chromium.
- JS: `ZigZag.foreground` accepts the rows of a band alone (`rgbaTop`), and `ZigZag.bandRows` says which rows those are; the parity gate checks bands built that way.
- README: the award links to ACM's list of 2024 best papers, and the 2024 competition is cited for what its report states.

## 1.3.3 — 2026-10-17

**Same output as 1.3.2, bit for bit.** Fixes from a full audit.

- Web app: loading an image, rotating or tapping New while a run is in flight no longer hangs the app (New during a CPU run left it spinning for good) or turns the GPU off for the session; a result for an image no longer shown is dropped. The CPU worker cancels its bands before stopping its helpers, and runs serial for good if a helper fails. Transparent images read as white paper instead of black ink. WebGPU accepts a window of 255 px (still exact in float32).
- All ports: the same validation everywhere — an integer threshold offset (Java no longer overflows on a huge one), `auto` only for size and despeckle (JS accepted it for every option), empty images rejected.
- Command lines: `--size` above 2048 is refused when parsed instead of failing mid-batch; an image that cannot be written is reported and the batch goes on (Java stopped; Python crashed with OpenCV 5); the Python CLI picks an output folder for a quoted pattern (`"scans/*.jpg" -o out`), and its output is plain ASCII, so a Windows console or a redirect no longer raises an encoding error.
- Gates: `tools/parity.py` checks that the worker's row bands (2, 3, 7) assemble into exactly the whole image; `tools/app_check.py` compares the app's CPU result with `ZigZag.process` pixel for pixel, checks that gray renders at 1×, and taps New during a run.
- Code: the JS 2× vertical pass is shared (`verticalRows`, as in Java); the Java helpers left over from the vector kernels work on whole rows; stale comments fixed.

## 1.3.2 — 2026-10-17

**Same output as 1.3.1, bit for bit. No incubator code: the Java port runs on Java 11+ again, with no flag** (`java ZigZag.java …`).

- Java: the Vector API kernels are removed. The API is still incubating (eleventh round in JDK 26, twelfth in JDK 27) and will stay so until parts of Project Valhalla reach preview; a reference port should not ask its users for an incubator module and print a warning on every run. They gained about 1.3× in the Java port on AVX2 / AVX-512 hardware, nothing on ARM, and they come back unchanged (commit `e0f6fa4`, 1.3.1) once the API is final. 5.6 MP photo, binary output, two cores: 0.12 → 0.14 s, still the fastest port.
- CI: parity on JDK 11, 21 and 25 again.

## 1.3.1 — 2026-10-17

**Same output as 1.3.0, bit for bit.** The web app's CPU path uses every core.

- JS: `ZigZag.process` is now three exported stages — `foreground` (gray levels, box sums, Pass A, Pass B) for a band of rows, `histogram`, and `finish` (Otsu, despeckle, output). A band computed from its own rows plus a 2r margin on each side has exactly the whole-image values.
- Web app: from 1 MP up, the CPU worker splits the foreground into one band per core (up to eight), computed by helper workers, and finishes alone; below 1 MP, or where a worker cannot start workers, it runs as before. 5.6 MP photo in Chromium on two cores: binary 913 → 598 ms, gray 511 → 413, color 587 → 510. Despeckle and output stay on one core (an ink component can span bands), which bounds the gain to about 1.8× on four cores.
- The service worker cache is renewed (`zigzag-v12`).

## 1.3.0 — 2026-10-17

**Same output as 1.2, bit for bit — faster.** The Java port now needs JDK 25+ and the Vector API (`java --add-modules jdk.incubator.vector ZigZag.java …`).

- All ports: the box sums run on bytes in, integers out (gray levels and 0/1 flags have integer sums, exact in any order), a fraction of the memory traffic of float64. A window is now at most 2048 px, which keeps them inside an int32.
- Java: Vector API kernels for Pass A, Pass B, the 2× binarization and the gray/color coverage, bit-identical (same operations lane by lane, no fused multiply-add); they switch on with 256-bit vectors or wider, the scalar loops run elsewhere. Gray computed straight from the JPEG raster bytes; the box sums share their scratch buffers; the color output is written to the raster directly.
- Java and JS: the despeckle unites runs of ink instead of pixels — the same components, about 1.7× faster on a text page.
- Python: the 2× samples are computed only around the ink: away from it every sample is provably paper (the threshold is an integer and the 0.25 / 0.75 weights keep it exact).
- 5.6 MP photo, binary output, two cores: Python 0.79 → 0.53 s, JS 0.60 → 0.35 s, Java 0.23 → 0.12 s (JDK 25 for both).
- CI: JDK 25; the parity gate runs a second time with AVX disabled, so the Java scalar fallback is proven identical too.

## 1.2.0 — 2026-10-17

**Default output changed.** A despeckle runs after thresholding: 8-connected ink components smaller than `round(size² / 225)` pixels become paper — 4 px at size 30, 26 at 77. It removes the salt-and-pepper grain of dark, noisy photos at no visible cost elsewhere. To reproduce 1.1 results exactly, turn it off (`-d 0`, `--despeckle=0`, `despeckle: 0`); 1.0 results need a fixed size of 30 as well.

- Python, Java, JS: `despeckle` option (`auto`, the default, or an area in source pixels, 0 to keep every speck), reported in the result info and the CSV. `auto_despeckle` / `ZigZag.autoDespeckle` / `autoDespeckle` expose the rule. Java: `ZigZag.AUTO` is now -1 and serves both `size` and `despeckle`.
- WebGPU accelerator: the despeckle runs on the CPU with the CPU port's own function and is cached per threshold.
- Web app: a Specks switch in the settings, on by default.
- Faster, same pixels: the 2× bilinear upsampling uses its constant 0.25 / 0.75 weights directly instead of generic interpolation (Python, Java and JS), and the JS and Java horizontal box sum loses its per-pixel bounds tests. Default binary output of a 5.6 MP photo, despeckle included, on two cores: Python 1.11 → 0.76 s, JS 0.98 → 0.66 s, Java 0.41 → 0.27 s. Gray and color are faster in Python and a few tens of milliseconds slower in JS and Java, the cost of the despeckle.
- `tools/app_check.py`, a new gate run in CI: in headless Chromium with a software WebGPU adapter, the GPU accelerator against the CPU port, the app's controls, and an offline reload. Pushing to `main` publishes the app, so it must pass first.
- Parity harness: despeckle cases (automatic, explicit, off) and a page sown with specks of every size (468 comparisons).

## 1.1.0 — 2026-10-17

**Default output changed.** The window size is now automatic by default: one window per 45 px of image diagonal, `size = clamp(floor(diagonal / 45 + 0.5), 20, 250)`. The former fixed default of 30 px suited one resolution and degraded at the others. To reproduce 1.0 results exactly, pass a fixed size of 30 (`-s 30`, `--size=30`, `size: 30`).

- Python, Java, JS: `size` accepts `auto` (the default) or an integer ≥ 2; the result info reports the size used and whether it was automatic. `auto_size` / `ZigZag.autoSize` / `autoSize` expose the rule.
- Invalid options (a size below 2, a weight ≤ 0, a non-RGB array in the Python API) are rejected instead of producing a blank image.
- Both command lines: `--version`; exit status 0 on success, 1 when an input could not be read or written, 2 for a bad command line; errors go to stderr.
- Java: wildcards in folder names (`"scans/*/page*.jpg"`) are expanded, and a leading `**/` also matches the top-level folder, as in Python.
- Java and JS: the vertical pass of the box sum walks memory row by row, about four times faster on that pass, with bit-identical results.
- WebGPU accelerator: same option resolution as the CPU port; windows above 254 px, where float32 sums stop being exact, are refused.
- Web app: the Window setting has an Auto stop, now the default (saved settings still on the old 30 px default move to Auto). The app no longer waits for the GPU before responding, shrinks the image when the GPU fails on upload as well as on processing, and recovers from a failed run instead of leaving the spinner up.
- Documentation: the advice to lower the weight to about 60 % for degraded documents is withdrawn — 85–90 suits clean and degraded pages alike.
- Parity harness: automatic size, 1× binary output and an A4-sized page added (432 comparisons), plus a check that the size rule agrees across ports on some ten thousand dimensions; Java is compiled once per run. CI: JDK 11, 21 and 25, Node 22.

## 1.0.0

The repository before version numbers were introduced, named 1.0 retroactively: fixed default window of 30 px, weight 90.
