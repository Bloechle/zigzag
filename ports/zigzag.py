#!/usr/bin/env python3
"""
ZigZag — adaptive document image binarization and background removal.

Implementation of the original algorithm published at ACM DocEng 2024:
Bloechle, Hennebert, Gisler — "ZigZag: A Robust Adaptive Approach to
Non-Uniformly Illuminated Document Image Binarization"
(DOI 10.1145/3685650.3685661).

Two-pass local mean filtering: Pass A classifies likely background pixels
against the weighted local mean; Pass B normalizes each pixel against the
local mean of background-only pixels, equalizing illumination before a
single global Otsu threshold.

Backends (auto-detected): CuPy (NVIDIA GPU, optional `pip install cupy-cuda12x`)
or OpenCV (CPU, SIMD box filters). Exact integer sums in float64 — outputs are
identical across backends and across the Java/JS ports.

CLI:
  python zigzag.py photo.jpg                     # binary, size 30, weight 90
  python zigzag.py -m color photo.jpg            # color foreground
  python zigzag.py -s 40 -w 60 old_letter.jpg    # historical documents
"""

import argparse
import csv
import glob
import os
import time

import cv2
import numpy as np

try:
    import cupy as cp
    HAS_GPU = cp.cuda.runtime.getDeviceCount() > 0
except Exception:
    cp = None
    HAS_GPU = False

OTSU_CAP = 250


# ── helpers ──────────────────────────────────────────────────────────────────

def to_gray(rgb, xp=np):
    """Rec. 601 luma, round-half-up — identical across the three ports."""
    g = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    return xp.floor(g + 0.5).clip(0, 255)


def box_sum_cv(src, r):
    """CPU: windowed sum over [x-r..x+r]^2, zero-padded (OpenCV separable filter)."""
    side = 2 * r + 1
    return cv2.boxFilter(src, cv2.CV_64F, (side, side), normalize=False,
                         borderType=cv2.BORDER_CONSTANT)


def box_sum_integral(src, r, xp=np):
    """GPU/generic: same zero-padded windowed sum via an integral image.
    Integer values summed in float64 stay exact, so results match box_sum_cv
    bit for bit."""
    h, w = src.shape
    ii = xp.zeros((h + 1, w + 1), dtype=xp.float64)
    ii[1:, 1:] = src.cumsum(axis=0).cumsum(axis=1)
    ys = xp.arange(h)
    xs = xp.arange(w)
    y1 = xp.maximum(ys - r, 0)
    y2 = xp.minimum(ys + r + 1, h)
    x1 = xp.maximum(xs - r, 0)
    x2 = xp.minimum(xs + r + 1, w)
    return (ii[y2][:, x2] - ii[y1][:, x2] - ii[y2][:, x1] + ii[y1][:, x1])


def window_counts(w, h, r, xp=np):
    """True pixel count of the clamped window at each position (separable)."""
    cx = xp.minimum(xp.arange(w) + r, w - 1) - xp.maximum(xp.arange(w) - r, 0) + 1
    cy = xp.minimum(xp.arange(h) + r, h - 1) - xp.maximum(xp.arange(h) - r, 0) + 1
    return cy[:, None] * cx[None, :]


def otsu(hist):
    """Standard Otsu, first-maximum tie-break, capped at OTSU_CAP."""
    total = int(hist.sum())
    if total == 0:
        return 127
    s = float(np.dot(np.arange(256), hist))
    sum_b, w_b, max_var, thr = 0.0, 0, -1.0, 127
    for t in range(256):
        w_b += int(hist[t])
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * float(hist[t])
        m_b = sum_b / w_b
        m_f = (s - sum_b) / w_f
        v = w_b * w_f * (m_b - m_f) * (m_b - m_f)
        if v > max_var:
            max_var, thr = v, t
    return min(OTSU_CAP, thr)


def upsample2x(src, xp=np):
    """Center-aligned 2x bilinear upsampling (vertical then horizontal pass)."""
    h, w = src.shape
    s = (xp.arange(2 * w) + 0.5) * 0.5 - 0.5
    x0 = xp.floor(s).astype(int)
    fx = s - x0
    xa, xb = xp.clip(x0, 0, w - 1), xp.clip(x0 + 1, 0, w - 1)
    s = (xp.arange(2 * h) + 0.5) * 0.5 - 0.5
    y0 = xp.floor(s).astype(int)
    fy = (s - y0)[:, None]
    ya, yb = xp.clip(y0, 0, h - 1), xp.clip(y0 + 1, 0, h - 1)
    rows = src[ya] * (1 - fy) + src[yb] * fy          # vertical pass (2h, w)
    return rows[:, xa] * (1 - fx) + rows[:, xb] * fx  # horizontal pass (2h, 2w)


# ── core pipeline (Algorithm 1 of the paper) ─────────────────────────────────

def process(rgb, mode='binary', size=30, weight=90, upsample=True, backend=None,
            threshold_offset=0):
    """
    rgb: HxWx3 uint8 (RGB). Returns (output_uint8, info_dict).
    threshold_offset: manual shift of the auto Otsu threshold (0 = auto)
    binary → HxW (2x if upsample) · gray → HxW · color → HxWx3
    backend: None (auto) | 'gpu' (CuPy) | 'cpu' (OpenCV)
    """
    if backend is None or backend == 'auto':
        backend = 'gpu' if HAS_GPU else 'cpu'
    if backend == 'gpu' and not HAS_GPU:
        raise RuntimeError("GPU backend requested but CuPy/CUDA is not available")
    gpu = backend == 'gpu'
    xp = cp if gpu else np
    box = (lambda s, r: box_sum_integral(s, r, xp)) if gpu else box_sum_cv

    h, w = rgb.shape[:2]
    rgb = cp.asarray(rgb) if gpu else rgb
    gray = to_gray(rgb, xp)

    r = size // 2
    wf = weight / 100.0

    # Pass A — background classification against the weighted local mean
    sum_all = box(gray, r)
    cnt_all = window_counts(w, h, r, xp)
    mask = gray >= wf * sum_all / cnt_all

    # Pass B — normalization against the local mean of background-only pixels
    cnt_bg = box(mask.astype(xp.float64), r)

    def normalize(channel):
        """fg = 255 if v >= mean_bg else v*256/mean_bg; all-foreground windows → 255."""
        mean_bg = box(channel * mask, r) / xp.maximum(cnt_bg, 1.0)
        out = xp.where((channel >= mean_bg) | (cnt_bg < 0.5), 255.0,
                       xp.minimum(255.0, channel * 256.0 / xp.maximum(1.0, mean_bg)))
        return out

    info = {'size': size, 'weight': weight, 'otsu': None, 'threshold': None,
            'backend': backend}

    def host(a):
        return cp.asnumpy(a) if gpu else a

    fg = normalize(gray)

    # Otsu threshold on the foreground histogram (10% margin crop)
    mh, mw = h * 10 // 100, w * 10 // 100
    region = fg[mh:h - mh, mw:w - mw]
    hist = xp.bincount(xp.clip(region, 0, 255).astype(xp.uint8).ravel(), minlength=256)
    auto = otsu(cp.asnumpy(hist) if gpu else hist)
    thr = min(255, max(0, auto + threshold_offset))
    info['otsu'] = auto
    info['threshold'] = thr

    if mode in ('gray', 'color'):
        # antialiased background cleanup: threshold the 2x-upsampled foreground,
        # then average each 2x2 block back to 1x (coverage in {0, .25, .5, .75, 1})
        # and blend toward white — free antialiasing at the cutoff, sharp text
        m = (upsample2x(fg, xp) >= thr).astype(xp.float64)
        cov = (m[0::2, 0::2] + m[0::2, 1::2] + m[1::2, 0::2] + m[1::2, 1::2]) * 0.25

    if mode == 'gray':
        out = cov * 255.0 + (1.0 - cov) * fg
        return host(xp.clip(out, 0, 255).astype(xp.uint8)), info

    if mode == 'color':
        # luminance-guided: normalize once on luma, re-apply the original colors
        ratio = fg / xp.maximum(1.0, gray)
        tc = xp.minimum(255.0, rgb.astype(xp.float64) * ratio[..., None])
        out = cov[..., None] * 255.0 + (1.0 - cov[..., None]) * tc
        return host(xp.clip(out, 0, 255).astype(xp.uint8)), info

    # binary — threshold, 2x upsample by default for detail preservation
    src = upsample2x(fg, xp) if upsample else fg
    return host(xp.where(src >= thr, 255, 0).astype(xp.uint8)), info


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="ZigZag — adaptive document image binarization (ACM DocEng 2024).")
    parser.add_argument("images", nargs="+", help="input image file(s)")
    parser.add_argument("-m", "--mode", choices=["binary", "gray", "color"],
                        default="binary", help="output mode (default: binary)")
    parser.add_argument("-s", "--size", type=int, default=30,
                        help="window size in px, typically 10-100 (default: 30)")
    parser.add_argument("-w", "--weight", type=int, default=90,
                        help="mean weight in percent, typically 50-100 (default: 90)")
    parser.add_argument("-T", "--threshold-offset", type=int, default=0,
                        help="manual shift of the auto Otsu threshold (default: 0 = auto)")
    parser.add_argument("-b", "--backend", choices=["auto", "gpu", "cpu"],
                        default="auto", help="processing backend (default: auto)")
    parser.add_argument("-o", "--output",
                        help="output file, or output directory when batching")
    parser.add_argument("-t", "--time", action="store_true",
                        help="show separate load / process / save timings and a batch summary")
    parser.add_argument("--csv", metavar="PATH",
                        help="write per-image metrics (parameters, otsu, timings) to a CSV file")
    parser.add_argument("--no-upsample", action="store_true",
                        help="binary mode: skip the 2x upsampling")
    args = parser.parse_args()

    if args.backend == "gpu" and not HAS_GPU:
        parser.error("GPU backend requested but CuPy/CUDA is not available")

    out_dir = None
    if args.output and (len(args.images) > 1 or os.path.isdir(args.output)
                        or args.output.endswith(os.sep)):
        out_dir = args.output
        os.makedirs(out_dir, exist_ok=True)

    # expand *, ? and ** patterns even where the shell does not (Windows);
    # each entry carries its path relative to the pattern's fixed prefix,
    # so batch output mirrors the input folder tree
    items = []
    for a in args.images:
        if ("*" in a or "?" in a) and not os.path.exists(a):
            wc = min(a.index(c) for c in "*?" if c in a)
            slash = max(a.rfind("/", 0, wc), a.rfind("\\", 0, wc))
            base = a[:slash] if slash >= 0 else "."
            for p in sorted(glob.glob(a, recursive=True)):
                items.append((p, os.path.relpath(p, base)))
        else:
            items.append((a, os.path.basename(a)))

    if not items:
        print("No input images found.")
        return

    rows = []
    totals, count = {"load": 0.0, "proc": 0.0, "save": 0.0}, 0
    for path, rel in items:
        if not os.path.exists(path):
            print(f"File not found: {path}")
            continue
        t0 = time.perf_counter()
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"Cannot read image: {path}")
            continue
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        t_load = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        out, info = process(rgb, mode=args.mode, size=args.size,
                            weight=args.weight, upsample=not args.no_upsample,
                            backend=args.backend,
                            threshold_offset=args.threshold_offset)
        t_proc = (time.perf_counter() - t0) * 1000

        if out_dir:
            dst = os.path.join(out_dir, os.path.splitext(rel)[0] + "_ZZ.png")
            os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        else:
            dst = args.output or os.path.splitext(path)[0] + "_ZZ.png"
        t0 = time.perf_counter()
        cv2.imwrite(dst, out if out.ndim == 2 else cv2.cvtColor(out, cv2.COLOR_RGB2BGR))
        t_save = (time.perf_counter() - t0) * 1000

        totals["load"] += t_load
        totals["proc"] += t_proc
        totals["save"] += t_save
        count += 1
        oh, ow = out.shape[:2]
        rows.append([path, dst, args.mode, info['size'], info['weight'],
                     info['otsu'] if info['otsu'] is not None else '',
                     info['threshold'] if info['threshold'] is not None else '',
                     info['backend'],
                     rgb.shape[1], rgb.shape[0], ow, oh,
                     round(t_load, 1), round(t_proc, 1), round(t_save, 1)])
        otsu_s = (f"thr={info['threshold']} (otsu={info['otsu']}) · "
                  if info['threshold'] != info['otsu'] else f"otsu={info['otsu']} · ")
        timing = (f"load {t_load:.0f} · proc {t_proc:.0f} · save {t_save:.0f} ms"
                  if args.time else f"{t_proc:.0f} ms")
        print(f"{path} → {dst}  [size={info['size']} weight={info['weight']} "
              f"· {otsu_s}{info['backend']} · {timing}]")

    if args.csv and rows:
        with open(args.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["input", "output", "mode", "size", "weight", "otsu", "threshold",
                        "backend",
                        "in_width", "in_height", "out_width", "out_height",
                        "load_ms", "proc_ms", "save_ms"])
            w.writerows(rows)
        print(f"metrics → {args.csv}")

    if args.time and count > 1:
        print(f"— {count} images · load {totals['load'] / 1000:.2f} s "
              f"· proc {totals['proc'] / 1000:.2f} s ({totals['proc'] / count:.0f} ms/image) "
              f"· save {totals['save'] / 1000:.2f} s")


if __name__ == "__main__":
    main()
