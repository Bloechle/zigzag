#!/usr/bin/env python3
"""
Cross-port parity check — proves that zigzag.py, ZigZag.java and zigzag.js
produce bit-identical output.

The three ports share the same float64 arithmetic, so any divergence is a bug.
This harness generates synthetic documents (non-uniform lighting, several pixel
formats, degenerate sizes), runs every port over a matrix of parameters and
compares the results pixel by pixel.

    python tools/parity.py              # all ports available on this machine
    python tools/parity.py --keep       # keep the working directory

Requires numpy + opencv (always), java 11+ and node 18+ (optional — a missing
runtime is reported as skipped, not as a failure).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "ports", "zigzag.py")
JAVA = os.path.join(ROOT, "ports", "ZigZag.java")
JS = os.path.join(ROOT, "js", "zigzag.js")

MODES = ["binary", "gray", "color"]
PARAMS = [(30, 90, 0), (45, 60, -15), (12, 100, 25), (100, 75, 0)]


# ── test corpus ──────────────────────────────────────────────────────────────

def corpus(d):
    """Write the test images; returns [(name, path)]."""
    rng = np.random.default_rng(7)
    h, w = 431, 613
    yy, xx = np.mgrid[0:h, 0:w]
    bg = (235 - 90 * (xx / w) - 55 * ((yy / h) ** 1.6)
          + 40 * np.exp(-(((xx - 120) ** 2 + (yy - 90) ** 2) / 9000)))
    ink = np.zeros((h, w))
    for i in range(28):
        y0 = 14 + i * 15
        ink[y0:y0 + 6, 20 + (i % 3) * 7: w - 25] = 120
    ink[:, ::9] *= 0.3
    img = np.clip(bg - ink, 0, 255)
    rgb = np.clip(np.stack([img, img * .94, img * .88], -1)
                  + rng.normal(0, 2.5, (h, w, 3)), 0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    out = []
    def put(name, data, ext="png", *a):
        p = os.path.join(d, f"{name}.{ext}")
        cv2.imwrite(p, data, *a)
        out.append((name, p))

    put("color_png", bgr)
    put("color_jpg", bgr, "jpg", [cv2.IMWRITE_JPEG_QUALITY, 95])
    put("gray_png", gray)                                    # linear-gray trap in Java
    put("gray_jpg", gray, "jpg", [cv2.IMWRITE_JPEG_QUALITY, 95])
    put("rgba_png", cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA))
    # 16-bit samples: every reader must map them to 8-bit the same way (>> 8)
    to16 = lambda a: np.minimum(65535, a.astype(np.uint32) * 257 + 200).astype(np.uint16)
    put("gray16_png", to16(gray))
    put("color16_png", to16(bgr))
    put("tiny", np.array([[10, 200], [250, 5]], dtype=np.uint8))
    put("row", np.arange(60, dtype=np.uint8).reshape(1, 60))  # window wider than image
    put("column", np.arange(60, dtype=np.uint8).reshape(60, 1))
    put("flat", np.full((40, 40), 128, np.uint8))
    return out


# ── runners: each returns a HxW or HxWx3 uint8 array in RGB order ────────────

def run_python(src, mode, size, weight, off, d):
    dst = os.path.join(d, "py.png")
    subprocess.run([sys.executable, PY, src, "-m", mode, "-s", str(size),
                    "-w", str(weight), "-T", str(off), "-o", dst],
                   check=True, capture_output=True)
    return read(dst)


def run_java(src, mode, size, weight, off, d):
    dst = os.path.join(d, "java.png")
    subprocess.run(["java", JAVA, src, f"--mode={mode}", f"--size={size}",
                    f"--weight={weight}", f"--threshold-offset={off}",
                    f"--output={dst}"], check=True, capture_output=True)
    return read(dst)


JS_DRIVER = r"""
import { ZigZag } from '%s';
import fs from 'fs';
const buf = fs.readFileSync(process.argv[2]);
const hdr = new Int32Array(buf.buffer, buf.byteOffset, 2);
const img = { width: hdr[0], height: hdr[1],
    data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, hdr[0] * hdr[1] * 4) };
const o = JSON.parse(process.argv[3]);
const r = ZigZag.process(img, o);
fs.writeFileSync(process.argv[4], Buffer.concat([
    Buffer.from(new Int32Array([r.width, r.height]).buffer), Buffer.from(r.data.buffer)]));
"""


def run_js(src, mode, size, weight, off, d):
    raw = os.path.join(d, "in.rgba")
    if not os.path.exists(raw):
        bgr = cv2.imread(src, cv2.IMREAD_COLOR)
        rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA)
        with open(raw, "wb") as f:
            f.write(np.array([rgba.shape[1], rgba.shape[0]], np.int32).tobytes())
            f.write(rgba.tobytes())
    drv = os.path.join(d, "drv.mjs")
    with open(drv, "w") as f:
        f.write(JS_DRIVER % JS.replace("\\", "/"))
    dst = os.path.join(d, "js.raw")
    opts = json.dumps({"mode": mode, "size": size, "weight": weight,
                       "thresholdOffset": off})
    subprocess.run(["node", drv, raw, opts, dst], check=True, capture_output=True)
    blob = open(dst, "rb").read()
    w, h = np.frombuffer(blob[:8], np.int32)
    a = np.frombuffer(blob[8:], np.uint8).reshape(h, w, 4)
    return a[:, :, :3] if mode == "color" else a[:, :, 0]


def read(path):
    a = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    return cv2.cvtColor(a, cv2.COLOR_BGR2RGB) if a.ndim == 3 else a


def have(cmd):
    return shutil.which(cmd) is not None


def main():
    ap = argparse.ArgumentParser(description="ZigZag cross-port parity check")
    ap.add_argument("--keep", action="store_true", help="keep the working directory")
    args = ap.parse_args()

    runners = {"python": run_python}
    if have("java"):
        runners["java"] = run_java
    else:
        print("! java not found — Java port skipped")
    if have("node"):
        runners["js"] = run_js
    else:
        print("! node not found — JS port skipped")

    d = tempfile.mkdtemp(prefix="zigzag-parity-")
    images = corpus(d)
    ref = "python"
    others = [k for k in runners if k != ref]
    checks = fails = 0

    print(f"\n{len(images)} images x {len(MODES)} modes x {len(PARAMS)} parameter sets "
          f"vs {ref}: {', '.join(others) or '(nothing to compare)'}\n")
    for name, src in images:
        sub = os.path.join(d, name)
        os.makedirs(sub, exist_ok=True)
        worst = []
        for mode in MODES:
            for size, weight, off in PARAMS:
                a = runners[ref](src, mode, size, weight, off, sub)
                for other in others:
                    b = runners[other](src, mode, size, weight, off, sub)
                    checks += 1
                    if a.shape != b.shape:
                        worst.append(f"{other} {mode} {size}/{weight}/{off}: "
                                     f"shape {a.shape} vs {b.shape}")
                        fails += 1
                    elif not (a == b).all():
                        n = int((a != b).sum())
                        dmax = int(np.abs(a.astype(int) - b.astype(int)).max())
                        worst.append(f"{other} {mode} {size}/{weight}/{off}: "
                                     f"{n} px differ, max delta {dmax}")
                        fails += 1
        status = "OK  " if not worst else "FAIL"
        print(f"  {status} {name}")
        for line in worst[:4]:
            print(f"         {line}")

    if not args.keep:
        shutil.rmtree(d, ignore_errors=True)
    print(f"\n{checks} comparisons, {fails} failures — "
          f"{'ALL PORTS BIT-IDENTICAL' if not fails else 'DIVERGENCE'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
