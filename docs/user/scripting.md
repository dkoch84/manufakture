# Scripted features

A **scripted feature** is a feature whose geometry a script computes: a few lines of JavaScript or TypeScript that sketch, extrude, fillet and cut through the same operations the toolbar offers, from parameters you edit like any other feature's. It is the idea of Onshape's FeatureScript, with a language you may know already. Use one for what a sketch and a few features make awkward: a box whose corner radius follows its height, a bolt circle with a variable number of holes, a spiral of holes placed with `Math.cos`.

Scripts are kept in the document, in its **script library**. A scripted feature names one script and stores its parameter values; several features (in several part studios) can run the same script with different values.

## Writing a script

The **Scripts** panel is in the side panel, under Variables. It lists the document's scripts, each with its language and the features that run it.

- **New script** opens the script editor on a new script. It starts as the box below, so it builds something at once.
- **Edit** opens a script in the editor. **Delete** removes a script that no feature runs (change or delete those features first).

The editor floats over the viewport. At the top are the script's **Name** and **Language** (JavaScript or TypeScript); below is the code, with line numbers, highlighting and undo of its own: click in it and type, as in any code editor. A line under the code names the language and says where errors appear; an empty code area says what to write. **Save** writes the script to the document as one step (the document's **Undo** takes it back), and every feature that runs it is rebuilt. **Close** (or Escape) closes the editor; with changes not saved, it asks first.

When a feature that runs the script fails because of it, the editor marks the place: a red dot in the margin and an underline at the line and column the error points to, with the message on hover, and a list of the problems under the code, such as `Scripted 1 (line 10, column 18): Error: no box today`. The marks belong to the saved script: edit the code and they go until you save again.

## Inserting a scripted feature

**Scripted** in the feature toolbar opens the dialog. Choose the **Script**; the dialog then reads the parameters the script declares and shows one field per parameter, with its label and default:

- numbers, lengths and angles are expression fields like every other numeric field, so `#width / 2` or `30 deg` work, in the document's units (see [Variables](variables.md));
- a check box for a true or false parameter, a list for a choice;
- faces or edges to pick in the viewport for a reference parameter (a parameter that takes a body asks you to pick any face of it).

Values outside the bounds the script declares are refused in the dialog. **Seed** (default 0) seeds the script's `Math.random`: change it for another variant of a script that uses randomness. **Edit the script** opens it in the editor.

**OK** adds the feature at the rollback bar as one step. Double-clicking its row in the feature tree (or **Edit**) opens the dialog again. A parameter the script stops declaring is ignored; a new one takes its default until you set it.

In the feature tree a scripted feature shows a code icon and the script it runs: **Script: Box**. Its status works as for other features: a failed script shows the message, with its line and column, when you hover the status.

## Running scripts from other people

A script is code written by whoever wrote the document. It runs in a sandbox with no access to the network, your files, your other documents or the page, under limits on time and memory. Even so, until that sandbox has passed its security review, manufakture does not run a document's scripts until you allow them:

- A document whose scripts you have not allowed on this device, however it arrived (a `.mfk` file, a link, sync), is built **without running any script**. Each scripted feature shows **Scripts not run** as its error, and a banner over the part lists the scripted features and the scripts they run. Scripts in a [derived part](derived.md)'s source document do not run either: the derived part is built without those features (its row warns which), and the banner lists it too. They run only when you allow the whole document with **Run scripts**; saving one of your own scripts in the editor does not allow them.
- **Run scripts** in the banner allows all of this document's scripts on this device, from now on, including scripts that sync or a merge bring into it later. They run, and the document opens without asking again.
- Scripts you write or edit in the script editor count as allowed, but only exactly as you saved them, in that document, and not the document's other scripts. If sync, a merge or another person later changes one of them, it does not run until you allow the document or save it yourself. Saving after any edit, even a one-character one, approves the whole script exactly as saved, including code you did not write: read a script you got from someone else before you save it.
- The choice is stored on this device, never in the document: sending the file or a link to someone does not allow its scripts for them. Deleting a document forgets the choice, and so does importing a file under its id.
- The setting **Run scripts in documents automatically**, at the bottom of the Scripts panel, runs every document's scripts without asking. Until the security sign-off of the script sandbox is recorded it is **locked off**: it cannot be ticked, and the panel says why, so the per-document choice above applies to every document. Once the sign-off is recorded, the setting can be changed and is on by default, and documents from other people run their scripts when they open, as other features build.

While a document's scripts are not allowed, the scripted feature's dialog does not read the script's parameters (that would run its top-level code); it keeps the stored values, and only the script and the seed can be changed.

## How a script looks

```js
// A box with rounded vertical edges. Lengths are in millimetres, angles in radians.
export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  depth: { kind: 'length', default: 30, min: 1, label: 'Depth' },
  height: { kind: 'length', default: 20, min: 1, label: 'Height' },
  radius: { kind: 'length', default: 2, min: 0, label: 'Corner radius' },
};

export function run(ctx, p) {
  const base = ctx.sketch('base', {
    plane: 'XY',
    loops: [
      [
        { kind: 'line', id: 'front', start: [0, 0], end: [p.width, 0] },
        { kind: 'line', id: 'right', start: [p.width, 0], end: [p.width, p.depth] },
        { kind: 'line', id: 'back', start: [p.width, p.depth], end: [0, p.depth] },
        { kind: 'line', id: 'left', start: [0, p.depth], end: [0, 0] },
      ],
    ],
  });
  const box = ctx.extrude('box', base, { distance: p.height });
  if (p.radius > 0) ctx.fillet('round', ctx.edges(box, { direction: [0, 0, 1] }), p.radius);
}
```

A script is a module with up to three exports, and nothing else is read:

- `params` (optional): the parameters, declared as data (below).
- `run(ctx, params)` (required): builds the geometry. `ctx` is the API below; `params` holds the values, each parameter's default where the feature stores none. Whatever `run` returns is ignored.
- `apiVersion` (optional): the script API version it is written for. The editor stamps new scripts with the current one; if a script declares one, it must agree with the stamp.

Units inside a script are always millimetres and radians, whatever the document shows: a `length` parameter typed as `2 in` arrives as `50.8`.

### Parameters

Each entry of `params` is `name: { kind, ... }`, with a name that is an identifier. Every kind takes an optional `label` (shown in the dialog instead of the name) and `description` (shown under the field). At most 64 parameters.

| Kind        | Fields                                                                          | The script receives                                                          |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `length`    | `default` (mm), optional `min`, `max`                                           | a number of millimetres                                                      |
| `angle`     | `default` (radians), optional `min`, `max`                                      | a number of radians                                                          |
| `number`    | `default`, optional `min`, `max`, `integer: true`                               | a number                                                                     |
| `boolean`   | `default`                                                                       | `true` or `false`                                                            |
| `choice`    | `options` (distinct strings), `default` (one of them)                           | the chosen string                                                            |
| `reference` | `select`: `'face'`, `'edge'` or `'body'`; optional `multiple`, `optional` flags | a face, edge or body handle (a list with `multiple`; `null` when left empty) |

An unknown field is an error, so a script never depends on something a later version adds.

### Operations

Every operation takes an **operation id** first: a lower-case letter followed by letters, digits or `_` (`'boss'`, `'hole1'`), unique within one run. It names what the operation makes: the body `scripted#2:boss` and its faces `scripted#2:boss/cap:end`, `scripted#2:boss/side:front` (the side's name is the sketch entity's id). Other features of the part refer to a scripted feature's faces by these names, so **renaming an operation id breaks references into it**, as deleting a sketch line would. Keep ids stable, and derive them from data (`'hole' + i`) rather than from counters that shift.

Each operation returns an **operation handle**, which the queries below accept.

- `ctx.sketch(id, { plane, loops })`: a profile, no geometry yet. `plane` is `'XY'` (the default), `'XZ'`, `'YZ'`, a planar face handle, or `{ origin, normal, xDir }`. `loops` is a list of closed loops, the first the outline and the rest holes; each loop is a list of entities: `{ kind: 'line', id, start, end }`, `{ kind: 'arc', id, center, start, end, clockwise }`, `{ kind: 'circle', id, center, radius }` or `{ kind: 'bezier', id, points }` (2 to 4 points), with 2D points `[x, y]`. Give `regions: [loops, loops, ...]` instead for several separate profiles.
- `ctx.extrude(id, sketch, { distance, symmetric, through, reverse, draft, mode, bodies })`: sweeps a sketch along its normal. `through: true` goes through everything (not for a new body). `mode` is `'new'` (the default), `'add'`, `'cut'` or `'intersect'`; `bodies` limits it to some bodies.
- `ctx.revolve(id, sketch, { axis: { origin, direction }, angle, symmetric, mode, bodies })`: turns a sketch about an axis (a full turn by default).
- `ctx.fillet(id, edges, radius)` and `ctx.chamfer(id, edges, distance)`: round or bevel edges.
- `ctx.shell(id, faces, thickness, { outward })`: hollows the part, removing `faces` (or none).
- `ctx.boolean(id, 'union' | 'subtract' | 'intersect', targets, tools)`: combines bodies.
- `ctx.pattern(id, source, { linear: { direction, count, spacing } })` or `{ circular: { axis, count, angle } }`: repeats extrudes and revolves (operation handles), or whole bodies (body handles, with `mode: 'new'` or `'add'`).
- `ctx.mirror(id, source, plane, { mode })`: mirrors operations or bodies about a planar face or `{ origin, normal }`.
- `ctx.transform(id, bodies, { translate: [x, y, z] })`, `{ rotate: { axis, angle } }` or `{ mirror: { origin, normal } }`: moves bodies.

A failed operation (a fillet too large for its edge, say) throws an ordinary `Error` naming the operation; catch it to try something else.

### Queries and measurements

- `ctx.bodies(op)`: the bodies an operation made or changed, or every body of the part without an argument.
- `ctx.faces(target, { surface, normal, role })`: faces born in an operation, of a body, or of every body; filtered by surface type (`'plane'`, `'cylinder'`, `'cone'`, `'sphere'`, `'torus'`, ...), by outward normal (planes), or by role (`'cap'`, `'side'`), sorted by name.
- `ctx.edges(target, { curve, direction })`: edges of an operation's faces, of a face, of a body or of every body; filtered by curve type (`'line'`, `'circle'`, ...) or by direction (straight edges parallel to it), sorted by name.
- `ctx.name(face | body)`: the name references store.
- `ctx.measure.volume(target)`, `ctx.measure.area(target)`, `ctx.measure.bounds(target)` (`{ min, max }`), `ctx.measure.face(face)` (`{ name, surface, area, centroid, normal, radius }`) and `ctx.measure.edge(edge)` (`{ curve, length, midpoint }`).

The part's bodies from the features before the scripted one are there from the start: query them with `ctx.bodies()` and build on them with `mode: 'add'` or `'cut'`.

### More examples

A plate with a bolt circle, the hole count a parameter:

```js
export const params = {
  count: { kind: 'number', default: 6, min: 1, max: 64, integer: true, label: 'Holes' },
  pitch: { kind: 'length', default: 30, label: 'Pitch radius' },
  hole: { kind: 'length', default: 3, label: 'Hole radius' },
};

export function run(ctx, p) {
  const disk = ctx.sketch('disk', {
    loops: [[{ kind: 'circle', id: 'rim', center: [0, 0], radius: 50 }]],
  });
  ctx.extrude('plate', disk, { distance: 10 });
  const spot = ctx.sketch('spot', {
    plane: { origin: [0, 0, 10], normal: [0, 0, 1] },
    loops: [[{ kind: 'circle', id: 'c', center: [p.pitch, 0], radius: p.hole }]],
  });
  const drill = ctx.extrude('drill', spot, { through: true, reverse: true, mode: 'cut' });
  ctx.pattern('circle', drill, {
    circular: { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: p.count },
  });
}
```

Holes on a spiral, cut into the part built so far (pick nothing: it cuts every body):

```ts
export const params = {
  turns: { kind: 'number', default: 1.5 },
  holes: { kind: 'number', default: 9, integer: true, min: 1, max: 40 },
};

export function run(ctx: any, p: { turns: number; holes: number }): void {
  for (let i = 0; i < p.holes; i++) {
    const t = (i / p.holes) * p.turns * 2 * Math.PI;
    const r = 10 + 30 * (i / p.holes);
    const at = ctx.sketch('at' + i, {
      plane: { origin: [0, 0, 5], normal: [0, 0, 1] },
      loops: [[{ kind: 'circle', id: 'c', center: [r * Math.cos(t), r * Math.sin(t)], radius: 2 }]],
    });
    ctx.extrude('hole' + i, at, { through: true, reverse: true, mode: 'cut' });
  }
}
```

### TypeScript

Choose **TypeScript** as the language and annotate as you like: the types are removed before the script runs, and errors still point at the line and column you wrote. `import type { ... } from '...'` is allowed (and removed); `namespace` blocks and `import x = require()` are not. Nothing checks the types: that is up to your own editor if you want it.

### What a script cannot do

A script sees the standard JavaScript built-ins and `ctx`, nothing else: no `import` of other modules, no network, no storage, no timers, no page. `Date` does not exist and `eval` and `new Function` throw. `run` must return directly: `async` functions, promises and `await` are refused.

Scripts are deterministic, so a document builds the same everywhere: the same script, parameters and seed give the same geometry in every browser and every session. `Math.random` is a generator seeded by the script's source and the feature's **Seed** (never by anything that changes when a document is synced or copied), so changing the source, even a comment, changes the random sequence.

### Limits

A script that runs away fails its own feature, never the app:

- **Time**: 2 seconds per run, then the feature fails with "The script ran longer than the 2 s limit". A run that somehow keeps going for 10 seconds stops the geometry worker, which restarts (the app stays responsive throughout); the feature then fails with a timeout until you change the script or its parameters.
- **Memory**: 64 MiB per document's scripts; **recursion**: about 680 levels.
- **Work**: 1,000 operations and 100,000 calls into `ctx` per run; a single string up to 1 MiB, a single list or object up to 100,000 items, crossing in or out.

Scripts run in an interpreter, roughly 30 to 45 times slower than the browser's own JavaScript on pure arithmetic. That rarely matters, since the time goes into the operations, but heavy number crunching in a script is slow.

## Script API versions

The functions above are **script API version 1**. Every script records the API version it was written against, and manufakture keeps a promise about it: **a script written against an API version runs unchanged, with the same results, in every later version of manufakture, forever.** It is the same promise the file format makes. New operations and options may be added to a version only where no existing script could see a difference; anything else becomes a new API version, and the old one stays. A document whose script needs an API version newer than your manufakture says so on the feature instead of failing to open.
