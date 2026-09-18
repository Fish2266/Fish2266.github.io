# fish2266.github.io

A landing page for my projects, built as a real-time ocean.

The sea is a WebGL2 fragment shader — a raymarched height field lit in linear
space, with analytic normals, a directional wave spectrum, sun specular that
widens with distance, wind foam, and a tropical shoreline. The project cards
ride on that surface: they enter from the left, surf across on the swell, and
head off to the right before coming round again.

## How it fits together

| File | What it does |
| --- | --- |
| `js/waves.js` | The sea, defined once. A directional spectrum of 26 sharpened sinusoids with per-component random phase, emitted as both JS and GLSL so the shader and the cards read the *same* surface. |
| `js/ocean.js` | The WebGL2 renderer: raymarch, shading, sky, clouds, foam, shoreline, tonemap. |
| `js/camera.js` | One camera shared by the shader and the DOM, so a card lands exactly on the water it is drawn sitting on. |
| `js/cards.js` | Projects each card onto the sea, rolls it with the local wave slope, and drives the procession. |
| `js/main.js` | Resize, the frame loop, and the `?still=` harness. |
| `css/site.css` | The cards, the title, and the column layout used on narrow screens. |

## Running it locally

```bash
python3 devserver.py 4892
```

Then open <http://localhost:4892>.

`?still=<seconds>` renders a single settled frame and stops — useful for
screenshots and for anything that can't run an animation loop.

**Debug keys:** press `S` to summon a shark and `D` to summon a dolphin.

## Layout

Above roughly 1.42 aspect ratio, and when a card would render at least 232px
wide, the cards surf across the water in 3D. Below that a card's copy would be
too small to read and drifting cards would hide half the work, so the page
falls back to a scrollable column over the same ocean.

## Performance

The renderer starts at up to 1.5x device pixel ratio and steps resolution down,
then drops the chop detail, if frames run long. `prefers-reduced-motion` freezes
the sea. Without WebGL2 the page falls back to a CSS gradient.
