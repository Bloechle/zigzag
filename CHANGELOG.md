# Changelog

Versions are shared by the three ports (Python, Java, JavaScript), which stay bit-identical. A minor version may change the default output; each entry says how to reproduce the previous one.

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
