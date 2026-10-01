// Outline entities in a sketch: the loops `outlinePartsRegions` made of an outline's paths (the
// glyphs of a text, laid out by `packages/text`), placed at the entity's anchor and angle and
// named, ready for `detectRegions` (its `outlines` option) and the kernel.
//
// Edge ids (ADR 0012 decision 7) are positional: the entity id, the glyph's position in the
// text, the contour within the glyph and the drawing command within the contour, then the piece
// the command was cut into by merging, as T0.5's final positional piece:
// `e5.g3.c0.s12#1`. The `#<digits>` makes every face built on them fragile, as faces of an
// imported file are: editing the text renumbers them. The kernel reads `e5.g3.c0.s12` as the
// ancestor of `e5.g3.c0.s12#2`, so a cut that splits a piece keeps a reference resolving.

import type { OutlineEntity, Vec2 } from './model';
import type { OutlinePartLoop, OutlinePartSegment, OutlinePartsResult } from './outline';
import type { OutlineShape, RegionCurve, RegionLoop } from './regions';

/** The edge id of an outline segment; `glyph` is the glyph's position in the text. */
export function outlineEdgeId(
  entityId: string,
  glyph: number,
  segment: OutlinePartSegment,
): string {
  const piece = segment.piece > 0 ? `.p${segment.piece}` : '';
  return `${entityId}.g${glyph}.c${segment.contour}.s${segment.index}${piece}#${segment.split + 1}`;
}

/** `anchor` plus `p` turned by `angle` (radians, counter-clockwise). */
function placer(anchor: Vec2, angle: number): (p: Vec2) => Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (p) => [anchor[0] + cos * p[0] - sin * p[1], anchor[1] + sin * p[0] + cos * p[1]];
}

/**
 * The regions of an outline entity in the sketch. `result` is `outlinePartsRegions` of the
 * entity's paths in its own frame (anchor at the origin, unturned), and `glyphs` gives, per path
 * (`part`), the glyph's position in the text, which edge ids and keys are built from.
 */
export function placeOutline(
  entity: Pick<OutlineEntity, 'id' | 'anchor' | 'angle'>,
  glyphs: readonly number[],
  result: OutlinePartsResult,
): OutlineShape[] {
  const at = placer(entity.anchor, entity.angle);
  const glyphOf = (part: number) => glyphs[part] ?? part;

  const curve = (s: OutlinePartSegment): RegionCurve => {
    const info = {
      edgeId: outlineEdgeId(entity.id, glyphOf(s.part), s),
      entityId: entity.id,
      fragile: true,
      reversed: s.reversed,
    };
    switch (s.kind) {
      case 'line':
        return { ...info, kind: 'line', start: at(s.start), end: at(s.end) };
      case 'bezier': {
        const points = s.points.map(at);
        return {
          ...info,
          kind: 'bezier',
          points,
          start: points[0]!,
          end: points[points.length - 1]!,
        };
      }
      case 'arc': {
        const center = at(s.center);
        const start = at(s.start);
        const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
        return {
          ...info,
          reversed: s.clockwise,
          kind: 'arc',
          center,
          radius,
          start,
          end: at(s.end),
        };
      }
    }
  };
  const loop = (l: OutlinePartLoop): RegionLoop => ({
    curves: l.segments.map(curve),
    area: l.area,
  });
  const keyOf = (l: OutlinePartLoop) => `${entity.id}.g${glyphOf(l.part)}.c${l.contour}`;

  // Keys of loops that merging made from one contour are numbered in loop order (fragile).
  const unique = (keys: string[]): { key: string; fragile: boolean }[] => {
    const count = new Map<string, number>();
    for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
    const seen = new Map<string, number>();
    return keys.map((k) => {
      if (count.get(k) === 1) return { key: k, fragile: false };
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      return { key: `${k}#${n}`, fragile: true };
    });
  };
  const outers = unique(result.regions.map((r) => keyOf(r.outer)));
  const holes = unique(result.regions.flatMap((r) => r.holes.map(keyOf)));
  let h = 0;
  return result.regions.map((r, i) => ({
    entityId: entity.id,
    key: outers[i]!.key,
    fragile: outers[i]!.fragile,
    outer: loop(r.outer),
    holes: r.holes.map((hole) => ({ ...loop(hole), key: holes[h++]!.key })),
  }));
}
