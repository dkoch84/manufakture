// What a new script starts as: the parametric box of the user guide (docs/user/scripting.md),
// so a new script builds something at once and shows the shape of every script: parameters
// declared as data, and `run(ctx, params)` calling operations by id.

/** The script API version new scripts are written against (`CURRENT_SCRIPT_API_VERSION`). */
export const SCRIPT_API_VERSION = 1;

/** The source of a new script. */
export const NEW_SCRIPT_SOURCE = `// A box with rounded vertical edges. Lengths are in millimetres, angles in radians.
export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  depth: { kind: 'length', default: 30, min: 1, label: 'Depth' },
  height: { kind: 'length', default: 20, min: 1, label: 'Height' },
  radius: { kind: 'length', default: 2, min: 0, label: 'Corner radius' },
};

export function run(ctx, p) {
  const base = ctx.sketch('base', {
    plane: 'XY',
    loops: [[
      { kind: 'line', id: 'front', start: [0, 0], end: [p.width, 0] },
      { kind: 'line', id: 'right', start: [p.width, 0], end: [p.width, p.depth] },
      { kind: 'line', id: 'back', start: [p.width, p.depth], end: [0, p.depth] },
      { kind: 'line', id: 'left', start: [0, p.depth], end: [0, 0] },
    ]],
  });
  const box = ctx.extrude('box', base, { distance: p.height });
  if (p.radius > 0) ctx.fillet('round', ctx.edges(box, { direction: [0, 0, 1] }), p.radius);
}
`;

/** A name for a new script that the document does not use yet: Script 1, Script 2, ... */
export function newScriptName(taken: readonly string[]): string {
  for (let n = 1; ; n++) {
    const name = `Script ${n}`;
    if (!taken.includes(name)) return name;
  }
}
