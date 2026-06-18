<p align="center"><img src="assets/zigzag-logo.png" alt="ZigZag logo" width="220"></p>

# ZigZag

**ZigZag** is a robust, machine-learning-free algorithm for **document image binarization** and **background removal**, designed for photos captured under difficult, non-uniform lighting. Built around integral images, it is fast, accurate, and simple â€” and it won the **ACM DocEng 2024 binarization competition**.

**[â–¶ Try the live demo](https://bloechle.github.io/zigzag/)** â€” runs entirely in your browser, no upload.

ðŸ“„ Published at ACM DocEng 2024: [*ZigZag: A Robust Adaptive Approach to Non-Uniformly Illuminated Document Image Binarization*](https://doi.org/10.1145/3685650.3685661).

## Repository layout

| File / folder | Content |
|---|---|
| [`zigzag.py`](ports/zigzag.py) | Reference implementation â€” single file, CPU/GPU backends, full CLI |
| [`ZigZag.java`](ports/ZigZag.java) | Java implementation â€” single file, multi-threaded, same CLI |
| [`zigzag.js`](zigzag.js) | Browser implementation â€” dependency-free ES module |
| [`zigzag-gpu.js`](zigzag-gpu.js) | Optional WebGPU accelerator â€” same pipeline as WGSL compute shaders |
| [`index.html`](index.html) | Web app & demo â€” single self-contained page built on `zigzag.js` |
| [`examples/`](examples/) | Sample input images and their binarized outputs |

## Algorithm

ZigZag is a two-pass local mean filter. **Pass A** classifies likely background pixels: a pixel is background when its value reaches the weighted local mean (`weight`, in percent, over a `size`Ã—`size` window). **Pass B** normalizes each pixel against the local mean of background-only pixels, which equalizes non-uniform illumination and makes the foreground histogram cleanly bimodal; a single global Otsu threshold then suffices. See the paper for the details.

Two parameters: `size` (window, default 30 px) and `weight` (mean percentage, default 90 â€” lower it to ~60 for degraded historical documents). A third, optional knob, `threshold-offset` (default 0), manually shifts the auto Otsu threshold up or down â€” automatic detection is preserved, the offset just nudges the cut; it is effective in all three modes.

Output modes: `binary` (thresholded, 2Ã— upsampled by default for detail preservation), `gray` (normalized foreground; the background, at or above the Otsu threshold, is cleaned to pure white â€” the cutoff is thresholded at 2Ã— and averaged back, i.e. antialiased for free), `color` (same antialiased cleanup, with the original colors re-applied to the foreground â€” luminance-guided, hue-preserving).

The three ports share the same float64 arithmetic and produce **bit-identical outputs** across languages, using separable rolling box sums in O(n).

## Python (reference implementation)

One file; requires NumPy and OpenCV:

```sh
pip install numpy opencv-python
python zigzag.py photo.jpg                          # binary, size 30, weight 90
python zigzag.py -m color photo.jpg                 # color foreground
python zigzag.py -s 40 -w 60 old_letter.jpg         # historical documents
python zigzag.py -t *.jpg -o cleaned/               # batch into a directory, with timings
```

The result is written next to each input as `<name>_ZZ.png`. Options: `-o` output file â€” or directory when batching; `-T` threshold offset; `-t` separate load / process / save timings plus a batch summary; `--csv path` per-image metrics (parameters, thresholds, dimensions, timings) as CSV; `--no-upsample` to skip the binary 2Ã—. `*`, `?` and `**` (recursive) patterns are expanded even where the shell does not (Windows) â€” e.g. `"scans/**/*.jpg"`, whose folder tree is mirrored under the output directory. Batching is noticeably faster per image: the first image pays the warm-up (NumPy/CuPy), the rest run at full speed.

**Optional NVIDIA GPU acceleration** â€” install CuPy and the GPU backend is auto-detected; the whole pipeline then runs in VRAM (exact integral-image sums, outputs identical to the CPU backend):

```sh
pip install cupy-cuda12x
python zigzag.py photo.jpg                          # gpu when available
python zigzag.py -b cpu photo.jpg                   # force a backend (auto|gpu|cpu)
```

## Java

One file, no dependencies, multi-threaded across all cores. Works on **Java 11+** and runs directly â€” no compilation step. The same file runs unmodified on every newer JDK, and noticeably faster: **JDK 25 processes ~25% faster than JDK 21** on identical bytecode (measured: 1130 â†’ 845 ms/image on a single core; the JIT auto-vectorizes the pixel loops better) â€” use the latest JDK you have. It deliberately sticks to stable APIs â€” no incubator modules (e.g. the Vector API) â€” so the flag-free launch below always works:

```sh
java ZigZag.java photo.jpg                          # binary, size 30, weight 90
java ZigZag.java photo.jpg --mode=color             # color foreground
java ZigZag.java old_letter.jpg --size=40 --weight=60 --output=clean.png
java ZigZag.java *.jpg --output=cleaned/ --time     # batch into a directory, with timings
```

Options: `--mode=binary|gray|color` Â· `--size=N` Â· `--weight=N` Â· `--threshold-offset=N` Â· `--output=path|dir` Â· `--no-upsample` Â· `--time` (separate load / process / save timings plus a batch summary) Â· `--csv=path` (per-image metrics as CSV, same columns as the Python CLI). Accepts multiple inputs; `*`, `?` and `**` (recursive) patterns are expanded even where the shell does not (Windows) â€” e.g. `"scans/**/*.jpg"`, whose folder tree is mirrored under the output directory.

### API

```java
ZigZag.Options opts = new ZigZag.Options();   // mode, size, weight, upsample, thresholdOffset
opts.mode = "binary";
ZigZag.Result res = ZigZag.process(image, opts);
// res.image (BufferedImage), res.info (parameters used, auto Otsu, applied threshold)
```

## JavaScript & web demo

[`zigzag.js`](zigzag.js) is a dependency-free ES module operating on canvas `ImageData`:

```html
<script type="module">
  import { ZigZag } from './zigzag.js';

  const { data, width, height, info } = ZigZag.process(imageData, { mode: 'binary' });
  // info: parameters used, auto Otsu and applied threshold
</script>
```

Like the Python and Java ports, `thresholdOffset` (default 0) shifts the auto Otsu threshold; `info` reports both the auto and the applied values.

[`zigzag-gpu.js`](zigzag-gpu.js) is an optional WebGPU accelerator running the same pipeline as compute shaders â€” typically 10-50 ms where the CPU port takes around a second. The foreground is cached on the GPU, so switching the output mode, the 2Ã— upsample or the threshold offset is near-instant. WebGPU uses float32 (no f64), so a handful of boundary pixels may differ from the CPU output by Â±1 gray level â€” visually identical:

```js
import { ZigZagGPU } from './zigzag-gpu.js';

if (ZigZagGPU.isSupported()) {
    const gpu = new ZigZagGPU();
    await gpu.init();
    await gpu.uploadImage(imageData);                    // once per image
    const res = await gpu.process({ mode: 'binary' });   // same result shape
}
```

[`index.html`](index.html) turns the repository into a mobile-first web app: shoot with the camera, pick, drop, or paste a document photo, switch between B&W / Gray / Color, tune **Detail** (analysis window) and **Intensity** (threshold shift), pinch-zoom and pan the full-width preview (double-tap to reset), swipe the comparison slider against the original (tap to toggle), and save or copy the result â€” everything runs on-device, on the GPU when WebGPU is available (Chrome, Edge) with transparent CPU fallback otherwise â€” the status line shows which backend ran. The page is an installable PWA: add it to your home screen and it works fully offline (`manifest.json` + `sw.js`, stale-while-revalidate). It is published with GitHub Pages at **[bloechle.github.io/zigzag](https://bloechle.github.io/zigzag/)**. To run it locally, serve the folder (ES modules don't load from `file://`):

```sh
python -m http.server   # then open http://localhost:8000
```

## Examples

[`examples/`](examples/) contains sample document photos taken under poor lighting and their binarized outputs, generated with the implementations above:

| Input | Output |
|---|---|
| `02_04.jpg` | `02_04_ZZ.png` |
| `10_18.jpg` | `10_18_ZZ.png` |

## Citation

If you use ZigZag in your research, please cite:

```bibtex
@inproceedings{10.1145/3685650.3685661,
  author    = {Bloechle, Jean-Luc and Hennebert, Jean and Gisler, Christophe},
  title     = {ZigZag: A Robust Adaptive Approach to Non-Uniformly Illuminated Document Image Binarization},
  booktitle = {Proceedings of the ACM Symposium on Document Engineering 2024},
  series    = {DocEng '24},
  year      = {2024},
  publisher = {Association for Computing Machinery},
  address   = {New York, NY, USA},
  doi       = {10.1145/3685650.3685661},
  url       = {https://doi.org/10.1145/3685650.3685661},
  isbn      = {9798400711695},
  articleno = {3},
  numpages  = {10},
  keywords  = {OCR, binarization, image processing, image thresholding},
  location  = {San Jose, CA, USA}
}
```

## License

ZigZag is released under the **GNU AGPL v3** (see [LICENSE](LICENSE)) â€” a copyleft license: any derivative work must remain open source under a compatible license.
