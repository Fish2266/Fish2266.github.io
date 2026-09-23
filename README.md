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

Cost is almost all per-pixel shader work, so resolution is the main control.
The canvas starts from a pixel budget (about 1.25M pixels on desktop, 0.5M on
touch screens) and then adjusts continuously, between 0.5x and 1.25x of CSS
pixels, to keep frames on time. It reads the display's refresh interval from
the frames drawn while the shader compiles, steps down when frames run late or
fall behind on average, and climbs back in small steps when there is room,
staying clear of any scale that recently proved too slow. Where the browser
exposes GPU timers it uses them as a guard as well. Wave detail only gives way
once the resolution is already low.

The rings are intersected analytically (a ray-torus quartic) rather than
sphere-traced, and their normals are closed-form; the animals are still
marched. The float wakes are culled to a world-space box. On 120Hz and faster
screens it draws at most every other refresh. `prefers-reduced-motion` draws
one still frame and only redraws on resize.

The canvas stays hidden until its first frame is drawn, so the CSS gradient
stands in while the shader compiles. A lost WebGL context (common on iOS) is
rebuilt in place. Without WebGL2, or if the shader fails to build, the page
falls back to the CSS gradient; without JavaScript, a `<noscript>` column
lists the projects.

`og.jpg` is a `?still=10` frame at 1200x630, for link previews.
