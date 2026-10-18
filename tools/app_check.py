#!/usr/bin/env python3
"""
Web app check — the gate for index.html, the browser ports and the service worker.

Pushing to main publishes the app (GitHub Pages), so this runs in CI on every
change to them. It serves the repository, opens it in headless Chromium with a
software WebGPU adapter (SwiftShader), and checks:

  1. WebGPU accelerator vs CPU port on the example photo, every mode, despeckle
     on and off: binary output identical, gray/color within the documented
     float32 tolerance (a handful of pixels off by one gray level).
  2. The app itself: example photo processed, automatic window, the badge's
     parameters behind ?, mode switch, Specks switch, Reset, settings migrated from an older version, no errors;
     then the same photo in a browser without WebGPU (CPU port in its worker).
  3. Installed: an image shared to the app (share_target) opens; then the page
     reloads with the server stopped (offline).

    pip install playwright && python -m playwright install chromium
    python tools/app_check.py
"""

import asyncio
import functools
import http.server
import os
import sys
import threading

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEBGPU = ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"]
GRAY_TOLERANCE = 1e-4          # fraction of pixels allowed to differ, by one level

GPU_VS_CPU = """async () => {
    const { ZigZag } = await import('./js/zigzag.js');
    const { ZigZagGPU } = await import('./js/zigzag-gpu.js');
    if (!ZigZagGPU.isSupported()) return null;
    const bmp = await createImageBitmap(await (await fetch('examples/01_letter.jpg')).blob());
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const gpu = new ZigZagGPU();
    await gpu.init();
    await gpu.uploadImage(img);
    const rows = [];
    for (const mode of ['binary', 'gray', 'color']) for (const despeckle of ['auto', 0]) {
        const a = ZigZag.process(img, { mode, despeckle });
        const b = await gpu.process({ mode, despeckle });
        let diff = 0, dmax = 0;
        for (let i = 0; i < a.data.length; i++) {
            const d = Math.abs(a.data[i] - b.data[i]);
            if (d) { diff++; dmax = Math.max(dmax, d); }
        }
        rows.push({ mode, despeckle, shape: a.width === b.width && a.height === b.height,
                    frac: diff / a.data.length, dmax,
                    info: JSON.stringify(a.info) === JSON.stringify(b.info) });
    }
    return rows;
}"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


class Checks:
    def __init__(self):
        self.failures = 0

    def ok(self, cond, label):
        print(f"  {'OK  ' if cond else 'FAIL'} {label}")
        self.failures += not cond


# The binary result on screen against the CPU port run on the same source.
SAME_AS_PORT = """async () => {
    const { ZigZag } = await import('./js/zigzag.js');
    const src = document.getElementById('canvasOriginal');
    const img = src.getContext('2d').getImageData(0, 0, src.width, src.height);
    const ref = ZigZag.process(img, { mode: 'binary' });
    const out = document.getElementById('canvasResult');
    if (out.width !== ref.width || out.height !== ref.height) return false;
    const got = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
    return got.every((v, i) => v === ref.data[i]);
}"""


SHARE_FORM = """() => {
    const form = Object.assign(document.createElement('form'), {
        id: 'shareForm', method: 'post', enctype: 'multipart/form-data', action: './?share' });
    form.append(Object.assign(document.createElement('input'), { type: 'file', name: 'image' }));
    document.body.append(form);
}"""


async def badge_with(page, text):
    await page.wait_for_function(
        f"document.getElementById('infoBadge').textContent.includes({text!r})", timeout=120000)
    return await page.evaluate("document.getElementById('infoBadge').textContent")


async def main():
    httpd, url = serve()
    c = Checks()
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=WEBGPU)

        print("WebGPU accelerator vs CPU port:")
        page = await browser.new_page()
        await page.goto(url + "index.html")
        rows = await page.evaluate(GPU_VS_CPU)
        if rows is None:
            c.ok(False, "WebGPU available in headless Chromium")
        for r in rows or []:
            tol = 0 if r["mode"] == "binary" else GRAY_TOLERANCE
            c.ok(r["shape"] and r["info"] and r["frac"] <= tol and r["dmax"] <= 1,
                 f"{r['mode']:6} despeckle {r['despeckle']}: "
                 f"{r['frac']:.2e} of samples differ, max delta {r['dmax']}")
        await page.close()

        print("App:")
        ctx = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        await page.goto(url + "index.html")
        # settings saved by 1.1 (Window still on the old 30 px default) move to Auto;
        # a Color mode saved before 1.3.6 (the app no longer offers it) opens in B&W;
        # Specks saved On (the default before 1.4) starts Off
        await page.evaluate("localStorage.setItem('zigzag.prefs', JSON.stringify("
                            "{mode: 'color', size: 30, weight: 90, thr: 0, specks: true}))")
        await page.reload()
        await page.wait_for_function("document.getElementById('gpuStatus').textContent !== ''")
        c.ok("WebGPU" in await page.inner_text("#gpuStatus"), "GPU backend detected")
        c.ok(await page.inner_text("#valSize") == "Auto", "old default Window migrated to Auto")
        c.ok(await page.get_attribute(".mode-btn.active", "data-mode") == "binary"
             and not await page.query_selector("[data-mode=color]"), "saved Color mode opens in B&W")
        c.ok(not await page.is_checked("#swSpecks"), "Specks saved On before 1.4 starts Off")
        c.ok(await page.get_attribute("#slWeight", "aria-valuetext") == "90 %"
             and await page.get_attribute("[data-mode=binary]", "aria-pressed") == "true",
             "sliders and mode buttons tell assistive tech their state")

        await page.click("#btnExample")
        badge = await badge_with(page, " ms")
        c.ok("(auto)" in badge and "gpu" in badge, f"example processed: {badge}")
        c.ok("otsu" not in await page.inner_text("#infoBadge"), "badge shows the summary only")

        await page.click("[data-mode=gray]")
        await page.wait_for_function(       # gray is never upsampled: 1x once it has run
            "document.getElementById('canvasResult').width === "
            "document.getElementById('canvasOriginal').width", timeout=120000)
        c.ok(True, "gray mode rendered at 1x")

        await page.click("#btnTune")
        await page.wait_for_timeout(400)
        await page.click("#btnHints")
        c.ok("otsu" in await page.inner_text("#infoBadge"), "the ? button shows the run's parameters")
        await page.click("#btnHints")
        await page.click("#swSpecks")
        badge = await badge_with(page, "removed")
        c.ok(await page.inner_text("#valSpecks") == "On", "Specks switch turns the despeckle on")

        await page.click("#btnReset")
        await page.wait_for_function(
            "!document.getElementById('infoBadge').textContent.includes('removed')", timeout=120000)
        c.ok(not await page.is_checked("#swSpecks"), "Reset restores the defaults")

        prefs = await page.evaluate("localStorage.getItem('zigzag.prefs')")
        c.ok('"v":3' in prefs and '"specks":false' in prefs, f"settings saved: {prefs}")
        c.ok(not errors, "no page errors" + (f": {errors}" if errors else ""))

        print("App without WebGPU (the CPU port in its worker):")
        plain = await p.chromium.launch()
        cpu_page = await plain.new_page()
        cpu_errors = []
        cpu_page.on("pageerror", lambda e: cpu_errors.append(str(e)))
        await cpu_page.goto(url + "index.html")
        await cpu_page.click("#btnExample")
        badge = await badge_with(cpu_page, " ms")
        c.ok("(auto)" in badge and "cpu" in badge, f"example processed: {badge}")
        c.ok(await cpu_page.evaluate(SAME_AS_PORT), "worker result = ZigZag.process, pixel for pixel")

        await cpu_page.click("#btnNew")     # New, then a new image, while a run is in flight
        await cpu_page.click("#btnExample")
        await cpu_page.wait_for_function("!document.getElementById('spinner').classList.contains('hidden')")
        await cpu_page.click("#btnNew")
        await cpu_page.click("#btnExample")
        badge = await badge_with(cpu_page, " ms")
        c.ok("cpu" in badge, "New during a run: the next image still processes")
        c.ok(not cpu_errors, "no page errors" + (f": {cpu_errors}" if cpu_errors else ""))
        await plain.close()

        print("Installed:")
        await page.wait_for_function("navigator.serviceWorker.controller !== null || "
                                     "(location.reload(), false)", timeout=30000, polling=1000)
        await page.wait_for_timeout(1500)
        # what Android's share sheet does: a multipart POST to the share_target action
        await page.evaluate(SHARE_FORM)
        await page.set_input_files("#shareForm input", os.path.join(ROOT, "examples", "02_timetable.jpg"))
        await page.evaluate("document.getElementById('shareForm').submit()")
        badge = await badge_with(page, " ms")
        c.ok(badge.startswith("1318×1898") and page.url.endswith("/"), f"shared image opens: {badge}")
        c.ok(await page.evaluate(
            "caches.open('zigzag-shared').then(c => c.keys()).then(k => k.length)") == 0,
            "the parked image is released")
        httpd.shutdown()                  # a real outage: the server is gone
        httpd.server_close()
        await page.goto(url + "?source=pwa")
        c.ok(await page.title() == "ZigZag — Document Image Binarizer", "page reloads offline")
        await browser.close()

    print(f"\n{c.failures} failure(s)" if c.failures else "\nweb app OK")
    return 1 if c.failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
