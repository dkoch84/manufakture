# @manufakture/render

Views of a regen result as PNG images, without a browser: what the review bundle (T8.3a) and the
MCP server's `render` tool (T8.4a) show an agent or a reviewer. It is the TypeScript software
rasteriser the T8.0b spike chose ([docs/spikes/T8.0b-render.md](../../docs/spikes/T8.0b-render.md)):
plain TypeScript plus fflate for the PNG, no native code, byte-identical output on every run.

## Use

```ts
import { buildScene, render } from '@manufakture/render';

const scene = buildScene({ result, memberMeshes, document });
if (!scene.ok) return scene; // { code: 'missing-mesh', message }
const view = render(scene.value, {
  camera: { view: 'isometric', fit: ['extension#7:*'] },
  highlight: ['extension#7:*'],
  only: 'members',
});
if (view.ok) writeFile('door.png', view.value.png);
```

- `buildScene({ result, memberMeshes, document, bodyMeshes, memberInstances })` turns a
  `RegenResult` into what is drawn: every part's body meshes, with their face and edge names from
  the result's name table, and framing members as instances of shared meshes. `memberMeshes` is
  every shape `memberMeshes.added` has sent, less those `removed` dropped. A result reports
  unchanged bodies and member sets without meshes; pass those in `bodyMeshes` (by
  `<part id>/<body id>`, with the name table of the result that carried them) and
  `memberInstances` (by `<part id>/<group>`), or get a `missing-mesh` error. Assemblies are not
  drawn yet.
- `render(scene, options)` gives `{ png, width, height, mmPerPixel, unmatched }`;
  `renderRgb` the raw RGB bytes instead; `renderViews(scene, [options...])` several images of
  one scene, at most `MAX_IMAGES_PER_CALL` (8).
- Every failure is data, `{ ok: false, error: { code, message } }`, never a throw:
  `too-large` (a side over `MAX_IMAGE_SIDE`, 2048 px, or more than 8 images), `invalid-options`,
  `invalid-camera`, `unknown-name` (a `fit` name that matches nothing drawn), `empty`,
  `missing-mesh`.

## Options

| Option        | Default     | What it does                                                                                                                                                                         |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `camera`      | `isometric` | A standard view by name (core's `STANDARD_VIEWS`), `{ view }`, `{ direction, up }` or `{ position, target, up }`; all orthographic. `fit` frames names, `extent` fixes the mm across |
| `width`       | 1024        | Pixels, 1 to 2048                                                                                                                                                                    |
| `height`      | 768         | Pixels, 1 to 2048                                                                                                                                                                    |
| `highlight`   | none        | Names drawn in the highlight colour: bodies, members, faces, edges                                                                                                                   |
| `hide`        | none        | Bodies and members not drawn                                                                                                                                                         |
| `only`        | both        | `bodies` or `members`: the framing without its layer bodies, say                                                                                                                     |
| `section`     | none        | `{ origin, normal }`: cuts away the side the normal points to and fills the cut                                                                                                      |
| `supersample` | 2           | Per axis, 1 to 3                                                                                                                                                                     |
| `edges`       | true        | B-rep edges of bodies, crease edges (over 20 degrees) of members                                                                                                                     |
| `outlines`    | true        | Silhouettes from depth jumps                                                                                                                                                         |

Names are regen's: a body id (`extrude#1`), a member's full id (`extension#7:king-1`), a face or
edge name from the name table (`extrude#1:side:e3`). Each may carry its part (`part#1/extrude#1`)
and a trailing `*` matches any suffix (`extension#7:*`). Highlight names that match nothing come
back in `unmatched`; `fit` names that match nothing are an error.

Without `extent`, the image is fitted to what it frames (the `fit` names, else everything drawn)
with a 24 px margin. A section does not change the framing, so a cut view lines up with the
whole one. With `extent`, the image is `extent` mm across its shorter side, centred on the
camera's `target` (or on what it would have fitted).

## Design (from T8.0b)

| Decision        | Value                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Projection      | Orthographic; standard views as core's `STANDARD_VIEWS` (third angle, Z up)                       |
| Scan conversion | Per-row spans from the edge functions, a `Float32Array` depth buffer                              |
| Shading         | Flat per triangle; lights fixed in view space: ambient 0.42, key light 0.4, headlight 0.2         |
| Edge visibility | The plane of the surface in front, tested at the edge point over 3 x 3 pixels (0.05 px); no bias  |
| Silhouettes     | Depth jumps over 4 pixels' worth, inked on the nearer side                                        |
| Section         | A per-pixel clip; where the back of a surface is seen, the pixel is cut face at the plane's depth |
| Colours         | A body's own colour, else the one it inherits, else the app's palette; members by role            |
| PNG             | RGB, adaptive row filters, zlib level 6                                                           |

Determinism: the pipeline uses only exactly rounded operations (`+ - * /`, `Math.sqrt`, `floor`,
`ceil`, `round`, `abs`, `min`, `max`) in a fixed order, and no clock, thread or transcendental
function; a PNG has no timestamp or text chunk. Images can only be as stable as the meshes regen
makes.

The default colours (`BODY_PALETTE`, the member role tones) copy the app's
(`apps/web/src/model/bodies.ts`, `apps/web/src/viewport/members.ts`); change them together.

Memory: about 12 bytes per supersampled pixel while rendering (depth, front triangle, colour,
marks), so 38 MiB at 1024 x 768 and 2 x 2, about 200 MiB at 2048 x 2048.

## Tests

`render.test.ts` covers cameras, limits, highlight, section, fit, hide and instances on hand-made
boxes. `fixtures.test.ts` regenerates the bracket, a cabinet built like the M4 bookshelf and the
M6 shed on the real kernel in Node, and compares PNGs with `src/test/goldens` byte for byte. After
a deliberate change to the renderer or to regen's meshes, rewrite them and look at them:

```sh
UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run --project packages packages/render
```

The shed's four views at 1024 x 768 must render and encode within T8.0b's budget of 1.5 s on CI;
the test logs the time and fails only at four times that, for loaded machines.
