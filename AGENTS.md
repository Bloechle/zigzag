# ZigZag — project card

Document image binarization and background removal (ACM DocEng 2024, best paper).
One algorithm, three bit-identical ports (Python, Java, JavaScript), an optional
WebGPU accelerator, and a web app published on GitHub Pages. Public repository,
AGPL v3. Code, docs and skills are in English.

**Read next:** `.claude/skills/zigzag/SKILL.md` — the arithmetic rules that keep the
ports identical, the pitfalls already paid for, and the release procedure.

## Map

| Path | What |
|---|---|
| `ports/zigzag.py` | Reference port: NumPy + OpenCV, optional CuPy GPU backend, CLI |
| `ports/ZigZag.java` | Java 11+ port, single file, multi-threaded, same CLI |
| `js/zigzag.js` | Browser/Node port, dependency-free ES module; owns option resolution, Otsu and despeckle for the browser |
| `js/zigzag-gpu.js` | WebGPU accelerator (WGSL, float32); imports those from `zigzag.js` |
| `js/zigzag-worker.js` | Runs `zigzag.js` off the main thread; splits large images into row bands, one helper worker per core |
| `index.html`, `sw.js`, `manifest.json` | The web app (PWA); `sw.js` must stay at the root |
| `tools/parity.py` | Gate 1: the three ports agree pixel for pixel |
| `tools/app_check.py` | Gate 2: GPU vs CPU, the app's controls, offline reload (headless Chromium) |
| `examples/` | Two photos and their outputs at the current defaults |
| `CHANGELOG.md`, `CITATION.cff` | Version history; citation metadata |

## Rules never to break

- **The ports stay bit-identical.** Same float64 operations in the same order in all
  three; a change to one port is a change to the three, in the same commit.
- **Pushing to `main` publishes the web app** (GitHub Pages, no gate in between).
  Run both gates before pushing a change that reaches the browser.
- **A default output change is a minor version**: bump the version in the three ports
  and `CITATION.cff`, write the CHANGELOG entry with the options that reproduce the
  previous output, regenerate `examples/*_ZZ.png`.
- **Every release that touches the app bumps `CACHE` in `sw.js`**, or installed copies
  keep the old version.
- **No incubator or preview code** in any port (the Java port stays on Java 11+, no flag).
- **The repository is public.** It states what anyone can check from it alone (algorithm,
  defaults and their rules, speed, parity). Comparisons with other methods, scores, sweeps
  and competition notes live in the private `Bloechle/UniFR` (`zigzag/`); no personal data.

## Gates

```sh
pip install numpy opencv-python-headless playwright && python -m playwright install chromium
python tools/parity.py       # needs a JDK 11+ and Node 18+
python tools/app_check.py
```

Both run in CI (`.github/workflows/parity.yml`, `app.yml`).
