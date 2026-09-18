# Creature tracing

The shark and dolphin in the ocean shader are built from measurements traced
off reference silhouettes, not modelled by eye. This folder regenerates
`js/creatures.data.js`.

## Sources

All three references are CC0 (public domain) on PhyloPic:

| File | Species | View | Contributor |
| --- | --- | --- | --- |
| `refs/shark_carcharhinus.png` | *Carcharhinus obscurus* (dusky shark) | side | Margot Michaud |
| `refs/dolphin_b.png` | *Tursiops truncatus* (bottlenose) | side | Kai Caspar |
| `refs/dolphin_top1.png` | *Tursiops truncatus* (bottlenose) | top | Guillaume Dera |

## How it works

1. `pngmask.py` decodes each PNG to a binary mask (pure Python, no dependencies).
2. `trace_side.py` orients the silhouette (PCA, then nose-to-tail normalised to
   x ∈ [-1, 1]), takes the top and bottom contours, and strips fins out with a
   morphological opening/closing. What is left is the body profile; what was
   stripped becomes fin polygons, boundary-traced and Douglas–Peucker simplified.
   It writes an `_overlay.png` of the reconstruction over the reference.
3. `build_glsl.py` combines the side and top traces — dolphin body height from
   the side, width from the top, flippers and flukes from the top — and emits
   the GLSL tables.

The shark has no top-view reference, so its width is estimated from its height.

## Regenerate

```bash
cd tools/creatures/refs
python3 ../pngmask.py shark_carcharhinus dolphin_b dolphin_top1
python3 ../trace_side.py shark_carcharhinus 44:44 -0.70 -0.35 shark.json
python3 ../trace_side.py dolphin_b 42:72 -0.75 -0.40 dolphin_side.json side_left
python3 ../trace_side.py dolphin_top1 48:48 -0.80 -0.55 dolphin_top.json top_up
python3 ../build_glsl.py ../../../js/creatures.data.js
```

The two numbers after each name are the fin-stripping window for the upper and
lower contours. The dolphin needs a much wider lower window: its two flippers sit
side by side and act as one feature, and a narrow window leaves them fused into
the belly.
