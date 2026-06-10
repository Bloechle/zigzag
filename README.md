<p align="center"><img src="assets/zigzag-logo.png" alt="ZigZag logo" width="220"></p>

# ZigZag

**ZigZag** is a robust, machine-learning-free algorithm for **document image binarization** and **background removal**, designed for photos captured under difficult, non-uniform lighting. Built around integral images, it is fast, accurate, and simple — and it won the **ACM DocEng 2024 binarization competition**.

**[▶ Try the live demo](https://bloechle.github.io/zigzag/)** — runs entirely in your browser, no upload.

📄 Published at ACM DocEng 2024: [*ZigZag: A Robust Adaptive Approach to Non-Uniformly Illuminated Document Image Binarization*](https://doi.org/10.1145/3685650.3685661).

## Repository layout

| File / folder | Content |
|---|---|
| [`zigzag.py`](zigzag.py) | Reference implementation — single file, CPU/GPU backends, full CLI |
| [`ZigZag.java`](ZigZag.java) | Java implementation — single file, multi-threaded, same CLI |
| [`zigzag.js`](zigzag.js) | Browser implementation — dependency-free ES module |
| [`zigzag-gpu.js`](zigzag-gpu.js) | Optional WebGPU accelerator — same pipeline as WGSL compute shaders |
| [`index.html`](index.html) | Web app & demo — single self-contained page built on `zigzag.js` |
| [`examples/`](examples/) | Sample input images and their binarized outputs |

## Algorithm

ZigZag is a two-pass local mean filter. **Pass A** classifies likely background pixels: a pixel is background when its value reaches the weighted local mean (`weight`, in percent, over a `size`×`size` window). **Pass B** normalizes each pixel against the local mean of background-only pixels, which equalizes non-uniform illumination and makes the foreground histogram cleanly bimodal; a single global Otsu threshold then suffices. See the paper for the details.

Two parameters: `size` (window, default 30 px) and `weight` (mean percentage, default 90 — lower it to ~60 for degraded historical documents).

Output modes: `binary` (thresholded, 2× upsampled by default for detail preservation), `gray` (normalized foreground; the background, at or above the Otsu threshold, is cleaned to pure white — the cutoff is thresholded at 2× and averaged back, i.e. antialiased for free), `color` (same antialiased cleanup, with the original colors re-applied to the foreground — luminance-guided, hue-preserving).

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

The result is written next to each input as `<name>_ZZ.png`. Options: `-o` output file — or directory when batching; `-t` separate load / process / save timings plus a batch summary; `--csv path` per-image metrics (parameters, Otsu, dimensions, timings) as CSV; `--no-upsample` to skip the binary 2×. `*`, `?` and `**` (recursive) patterns are expanded even where the shell does not (Windows) — e.g. `"scans/**/*.jpg"`, whose folder tree is mirrored under the output directory. Batching is noticeably faster per image: the first image pays the warm-up (NumPy/CuPy), the rest run at full speed.

**Optional NVIDIA GPU acceleration** — install CuPy and the GPU backend is auto-detected; the whole pipeline then runs in VRAM (exact integral-image sums, outputs identical to the CPU backend):

```sh
pip install cupy-cuda12x
python zigzag.py photo.jpg                          # gpu when available
python zigzag.py -b cpu photo.jpg                   # force a backend (auto|gpu|cpu)
```

## Java

One file, no dependencies, multi-threaded. With **Java 11+**, run it directly — no compilation step:

```sh
java ZigZag.java photo.jpg                          # binary, size 30, weight 90
java ZigZag.java photo.jpg --mode=color             # color foreground
java ZigZag.java old_letter.jpg --size=40 --weight=60 --output=clean.png
java ZigZag.java *.jpg --output=cleaned/ --time     # batch into a directory, with timings
```

Options: `--mode=binary|gray|color` · `--size=N` · `--weight=N` · `--output=path|dir` · `--no-upsample` · `--time` (separate load / process / save timings plus a batch summary) · `--csv=path` (per-image metrics as CSV, same columns as the Python CLI). Accepts multiple inputs; `*`, `?` and `**` (recursive) patterns are expanded even where the shell does not (Windows) — e.g. `"scans/**/*.jpg"`, whose folder tree is mirrored under the output directory.

### API

```java
ZigZag.Options opts = new ZigZag.Options();   // mode, size, weight, upsample
opts.mode = "binary";
ZigZag.Result res = ZigZag.process(image, opts);
// res.image (BufferedImage), res.info (parameters used, Otsu threshold)
```

## JavaScript & web demo

[`zigzag.js`](zigzag.js) is a dependency-free ES module operating on canvas `ImageData`:

```html
<script type="module">
  import { ZigZag } from './zigzag.js';

  const { data, width, height, info } = ZigZag.process(imageData, { mode: 'binary' });
  // info: parameters used and Otsu threshold
</script>
```

[`zigzag-gpu.js`](zigzag-gpu.js) is an optional WebGPU accelerator running the same pipeline as compute shaders — typically 10-50 ms where the CPU port takes around a second. The foreground is cached on the GPU, so switching the output mode or the 2× upsample is near-instant. WebGPU uses float32 (no f64), so a handful of boundary pixels may differ from the CPU output by ±1 gray level — visually identical:

```js
import { ZigZagGPU } from './zigzag-gpu.js';

if (ZigZagGPU.isSupported()) {
    const gpu = new ZigZagGPU();
    await gpu.init();
    await gpu.uploadImage(imageData);                    // once per image
    const res = await gpu.process({ mode: 'binary' });   // same result shape
}
```

[`index.html`](index.html) turns the repository into a mobile-first web app: shoot with the camera, pick, drop, or paste a document photo, switch between B&W / Gray / Color, adjust the window size and mean weight, swipe the comparison slider against the original (tap to toggle), and save or copy the result — everything runs on-device, on the GPU when WebGPU is available (Chrome, Edge) with transparent CPU fallback otherwise — the status line shows which backend ran. The page is an installable PWA: add it to your home screen and it works fully offline (`manifest.json` + `sw.js`, stale-while-revalidate). It is published with GitHub Pages at **[bloechle.github.io/zigzag](https://bloechle.github.io/zigzag/)**. To run it locally, serve the folder (ES modules don't load from `file://`):

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

ZigZag is released under the **GNU AGPL v3** (see [LICENSE](LICENSE)) — a copyleft license: any derivative work must remain open source under a compatible license.
