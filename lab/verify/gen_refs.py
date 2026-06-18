#!/usr/bin/env python3
"""Generate deterministic test images, run the reference binarizers and
quality_metrics, dump everything as raw bytes + JSON for the JS port to match."""
import json, sys
from pathlib import Path
import numpy as np
import cv2

REF = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("refs")
SRC = Path("PUT_YOUR_PYTHON_SOURCES_DIR_HERE")
sys.path.insert(0, str(SRC))
import binarizers_native as B
import eval as E

REF.mkdir(parents=True, exist_ok=True)


def make_doc(seed=0, w=480, h=360):
    rng = np.random.default_rng(seed)
    img = np.full((h, w), 235.0)
    # illumination gradient + a soft shadow on the right
    yy, xx = np.mgrid[0:h, 0:w]
    img -= 40 * (xx / w)
    img -= 25 * np.exp(-((xx - w * 0.85) ** 2) / (2 * (w * 0.12) ** 2))
    # text-like strokes: rows of short dark dashes
    for r in range(6, h - 6, 18):
        x = 20
        while x < w - 40:
            ln = rng.integers(6, 22)
            img[r:r + 3, x:x + ln] = 35
            x += ln + rng.integers(3, 9)
    # a few vertical strokes + blobs
    for _ in range(40):
        cx, cy = rng.integers(20, w - 20), rng.integers(20, h - 20)
        img[cy:cy + rng.integers(4, 10), cx:cx + 2] = 40
    img = cv2.GaussianBlur(img, (0, 0), 0.8)            # camera PSF ramp
    img += rng.normal(0, 3, img.shape)                  # sensor noise
    return np.clip(img, 0, 255).astype(np.uint8)


def variants():
    doc = make_doc(0)
    flood = doc.copy()
    flood_bin = None
    # 'flood' source has a big dark region (binarizes to a solid block)
    f = doc.copy()
    f[40:200, 60:240] = 18
    # 'dropped' binary: take a good binary then wipe the bottom band to white
    return {"doc": doc, "flood": f}


METHOD_NAMES = ["otsu", "mean", "niblack", "sauvola", "wolf", "nick", "bradley",
                "wellner", "phansalkar", "feng", "wan", "bataineh", "bernsen",
                "trsingh", "su", "isauvola", "kapur", "kittler", "adaptive_gaussian"]

manifest = {"images": {}, "methods": METHOD_NAMES}

for name, gray in variants().items():
    h, w = gray.shape
    (REF / f"{name}.gray").write_bytes(gray.tobytes())
    entry = {"w": w, "h": h, "methods": {}}
    for m in METHOD_NAMES:
        b = B.binarize(m, gray)
        (REF / f"{name}.{m}.bin").write_bytes(b.tobytes())
        qm = E.quality_metrics(gray, b, compute_cpo=False)
        entry["methods"][m] = qm
    # synthetic 'dropped text' case: sauvola binary with the lower third erased
    sv = B.binarize("sauvola", gray)
    dropped = sv.copy(); dropped[int(h * 0.66):, :] = 255
    (REF / f"{name}.dropped.bin").write_bytes(dropped.tobytes())
    entry["methods"]["__dropped"] = E.quality_metrics(gray, dropped, compute_cpo=False)
    manifest["images"][name] = entry

(REF / "manifest.json").write_text(json.dumps(manifest))
print(f"wrote refs for {list(manifest['images'])} × {len(METHOD_NAMES)} methods → {REF}")
