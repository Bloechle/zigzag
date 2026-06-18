# Fidelity check (optional)

Reproduces the JS↔Python parity test. Needs Python with numpy + opencv and your
reference sources (`binarizers_native.py`, `eval.py`, `zigzag.py`).

1. Edit `gen_refs.py` → set `SRC` to the folder holding those Python files.
2. Generate references and compare:
   ```sh
   python gen_refs.py            # writes refs/ (gray + per-method binaries + ZQS json)
   node check.mjs                # compares ../web/{binarizers,zqs}.js against them
   ```
Expected: committee 100.000 % pixel agreement; ZQS scalar + gates error 0.0000
(only the diagnostic `q_stroke` may drift ≤0.1 on flood cases).
