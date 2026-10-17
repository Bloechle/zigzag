#!/usr/bin/env python3
"""
Cross-port parity check — proves that zigzag.py, ZigZag.java and zigzag.js
produce bit-identical output.

The three ports share the same float64 arithmetic, so any divergence is a bug.
This harness generates synthetic documents (non-uniform lighting, several pixel
formats, degenerate sizes), runs every port over a matrix of parameters and
compares the results pixel by pixel. It also checks that the automatic window
size rule gives the same integer in all three ports over a large sample of
image dimensions.

The JS port is fed pixels decoded by OpenCV: in the browser the canvas does the
decoding, so what is proven here for JS is the computation, not the decoder.

    python tools/parity.py              # all ports available on this machine
    python tools/parity.py --keep       # keep the working directory

Requires numpy + opencv (always), a JDK 11+ and node 18+ (optional — a missing
runtime is reported as skipped, not as a failure).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ports"))
from zigzag import auto_size  # noqa: E402  (the reference rule)

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "ports", "zigzag.py")
JAVA = os.path.join(ROOT, "ports", "ZigZag.java")
JS = os.path.join(ROOT, "js", "zigzag.js")

MODES = ["binary", "gray", "color"]
# (size, weight, threshold offset, 2x upsample, despeckle) — "auto" is the
# default rule; (30, 90, 0, True, 0) is the 1.0 default output
PARAMS = [("auto", 90, 0, True, "auto"), (30, 90, 0, True, 0), (45, 60, -15, True, "auto"),
          (12, 100, 25, True, "auto"), (100, 75, 0, True, 50), (30, 90, 0, False, "auto")]


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
    # specks of 1 to 60 px (diagonal pairs, blobs, some on the borders) on the
    # lit page: component areas straddle every despeckle threshold used below
    sp = gray.copy()
    for k in range(400):
        y, x = int(rng.integers(0, h)), int(rng.integers(0, w))
        if k % 50 == 0:
            y = 0 if k % 100 == 0 else h - 2               # touch the borders
        if k % 4 == 0:                                     # diagonal pair: one 8-component
            sp[y, x] = 20
            sp[min(y + 1, h - 1), min(x + 1, w - 1)] = 20
        else:
            bh, bw = int(rng.integers(1, 7)), int(rng.integers(1, 11))
            sp[y:y + bh, x:x + bw] = 25
    put("specks_png", sp)
    # A4 proportions, large enough that the automatic size is not clamped (35)
    put("a4_jpg", cv2.resize(bgr, (900, 1273), interpolation=cv2.INTER_LINEAR), "jpg",
        [cv2.IMWRITE_JPEG_QUALITY, 92])
    return out


# ── runners: each returns a HxW or HxWx3 uint8 array in RGB order ────────────

def run_python(src, mode, size, weight, off, up, ds, d):
    dst = os.path.join(d, "py.png")
    subprocess.run([sys.executable, PY, src, "-m", mode, "-s", str(size),
                    "-w", str(weight), "-T", str(off), "-d", str(ds), "-o", dst]
                   + ([] if up else ["--no-upsample"]),
                   check=True, capture_output=True)
    return read(dst)


JAVA_CP = None   # compiled once by main(); `java ZigZag.java` recompiles every call


def run_java(src, mode, size, weight, off, up, ds, d):
    dst = os.path.join(d, "java.png")
    subprocess.run(["java", "-cp", JAVA_CP, "ZigZag", src, f"--mode={mode}", f"--size={size}",
                    f"--weight={weight}", f"--threshold-offset={off}", f"--despeckle={ds}",
                    f"--output={dst}"] + ([] if up else ["--no-upsample"]),
                   check=True, capture_output=True)
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


def run_js(src, mode, size, weight, off, up, ds, d):
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
                       "thresholdOffset": off, "upsample": up, "despeckle": ds})
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


# ── automatic size rule: same integer in every port ──────────────────────────

AUTO_JS = r"""
import { autoSize } from '%s';
import fs from 'fs';
const pairs = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
fs.writeFileSync(process.argv[3], pairs.map(l => { const [w, h] = l.split(' ').map(Number);
    return autoSize(w, h); }).join('\n'));
"""

AUTO_JAVA = r"""
import java.nio.file.*;
import java.util.stream.Collectors;
public class AutoCheck {
    public static void main(String[] a) throws Exception {
        Files.writeString(Path.of(a[1]), Files.readAllLines(Path.of(a[0])).stream().map(l -> {
            String[] p = l.split(" ");
            return String.valueOf(ZigZag.autoSize(Integer.parseInt(p[0]), Integer.parseInt(p[1])));
        }).collect(Collectors.joining("\n")));
    }
}
"""


def auto_pairs():
    """Dimensions around the clamps, plus the random sample whose diagonal/45
    lands closest to a .5 rounding boundary — where a sloppy port would slip."""
    rng = np.random.default_rng(11)
    pairs = {(w, h) for w in range(1, 120, 7) for h in range(1, 12000, 97)}
    wh = rng.integers(1, 20001, size=(400000, 2))
    x = np.sqrt(wh[:, 0].astype(float) ** 2 + wh[:, 1].astype(float) ** 2) / 45
    near = np.argsort(np.abs(x - np.floor(x) - 0.5))[:4000]
    pairs |= {(int(w), int(h)) for w, h in wh[near]}
    pairs |= {(int(w), int(h)) for w, h in wh[:4000]}
    return sorted(pairs)


def check_auto(runners, d):
    pairs = auto_pairs()
    ref = [auto_size(w, h) for w, h in pairs]
    src = os.path.join(d, "pairs.txt")
    with open(src, "w") as f:
        f.write("\n".join(f"{w} {h}" for w, h in pairs))
    fails = 0
    for name in runners:
        if name == "python":
            continue
        dst = os.path.join(d, f"auto_{name}.txt")
        if name == "js":
            drv = os.path.join(d, "auto.mjs")
            with open(drv, "w") as f:
                f.write(AUTO_JS % JS.replace("\\", "/"))
            subprocess.run(["node", drv, src, dst], check=True, capture_output=True)
        else:
            subprocess.run(["java", "-cp", JAVA_CP, "AutoCheck", src, dst],
                           check=True, capture_output=True)
        got = [int(v) for v in open(dst).read().split()]
        bad = sum(a != b for a, b in zip(ref, got)) + abs(len(ref) - len(got))
        print(f"  {'OK  ' if not bad else 'FAIL'} auto size rule, {name}: "
              f"{len(pairs)} dimensions, {bad} disagreements")
        fails += bad > 0
    return fails


def main():
    ap = argparse.ArgumentParser(description="ZigZag cross-port parity check")
    ap.add_argument("--keep", action="store_true", help="keep the working directory")
    args = ap.parse_args()

    runners = {"python": run_python}
    if have("java") and have("javac"):
        runners["java"] = run_java
    else:
        print("! java/javac not found — Java port skipped")
    if have("node"):
        runners["js"] = run_js
    else:
        print("! node not found — JS port skipped")

    d = tempfile.mkdtemp(prefix="zigzag-parity-")
    if "java" in runners:
        global JAVA_CP
        JAVA_CP = os.path.join(d, "classes")
        drv = os.path.join(d, "AutoCheck.java")
        with open(drv, "w") as f:
            f.write(AUTO_JAVA)
        subprocess.run(["javac", "-d", JAVA_CP, JAVA, drv], check=True,
                       capture_output=True)
    images = corpus(d)
    ref = "python"
    others = [k for k in runners if k != ref]
    checks = fails = 0

    print(f"\nautomatic size rule vs {ref}:")
    auto_fails = check_auto(runners, d)

    print(f"\n{len(images)} images x {len(MODES)} modes x {len(PARAMS)} parameter sets "
          f"vs {ref}: {', '.join(others) or '(nothing to compare)'}\n")
    for name, src in images:
        sub = os.path.join(d, name)
        os.makedirs(sub, exist_ok=True)
        worst = []
        for mode in MODES:
            for size, weight, off, up, ds in PARAMS:
                tag = other_tag(mode, size, weight, off, up, ds)
                a = runners[ref](src, mode, size, weight, off, up, ds, sub)
                for other in others:
                    b = runners[other](src, mode, size, weight, off, up, ds, sub)
                    checks += 1
                    if a.shape != b.shape:
                        worst.append(f"{other} {tag}: shape {a.shape} vs {b.shape}")
                        fails += 1
                    elif not (a == b).all():
                        n = int((a != b).sum())
                        dmax = int(np.abs(a.astype(int) - b.astype(int)).max())
                        worst.append(f"{other} {tag}: {n} px differ, max delta {dmax}")
                        fails += 1
        status = "OK  " if not worst else "FAIL"
        print(f"  {status} {name}")
        for line in worst[:4]:
            print(f"         {line}")

    if not args.keep:
        shutil.rmtree(d, ignore_errors=True)
    fails += auto_fails
    print(f"\n{checks} comparisons, {fails} failures — "
          f"{'ALL PORTS BIT-IDENTICAL' if not fails else 'DIVERGENCE'}")
    return 1 if fails else 0


def other_tag(mode, size, weight, off, up, ds):
    return f"{mode} {size}/{weight}/{off} despeckle {ds}{'' if up else ' 1x'}"


if __name__ == "__main__":
    sys.exit(main())
