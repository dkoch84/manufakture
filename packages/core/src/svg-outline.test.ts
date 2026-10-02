import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from './commands';
import { deserialize, serialize } from './format';
import { featureExpressions } from './features';
import {
  MAX_SKETCH_SVG_COMMANDS,
  MAX_SVG_OUTLINE_COMMANDS,
  SketchEntitySchema,
  type ManufaktureDocument,
  type OutlineEntity,
  type SketchFeature,
} from './schema';
import { validateDocument } from './validate';
import { renameVariable } from './variables';
import { PART, bracket, clone, unwrap } from './test-helpers';

/** The `svg` source of the outline sketch entity (format v13, M5 T5.8). */

const square = (s: number) => [
  { kind: 'moveTo' as const, to: [0, 0] as const },
  { kind: 'lineTo' as const, to: [s, 0] as const },
  {
    kind: 'cubicTo' as const,
    control1: [s, 1] as const,
    control2: [s, 2] as const,
    to: [s, s] as const,
  },
  { kind: 'quadTo' as const, control: [s / 2, s + 1] as const, to: [0, s] as const },
  { kind: 'close' as const },
];

const artwork = (id = 'e10', commands = square(10), paths = 1): OutlineEntity => ({
  id,
  kind: 'outline',
  construction: false,
  anchor: [5, 5],
  angle: 0,
  source: {
    kind: 'svg',
    fileName: 'sign.svg',
    paths: Array.from({ length: paths }, (_, i) => ({
      fillRule: i % 2 === 0 ? 'nonzero' : 'evenodd',
      commands: clone(commands),
    })),
    scale: { source: '#k', lengthUnit: 'mm', angleUnit: 'deg' },
  },
});

/** The bracket with SVG artwork in its hole sketch, and a `k` variable for its scale. */
function withArtwork(entity = artwork()): ManufaktureDocument {
  let doc = bracket();
  const run = (c: Command) => (doc = unwrap(applyCommand(doc, c)).document);
  run({
    type: 'setVariable',
    name: 'k',
    expression: { source: '2', lengthUnit: 'mm', angleUnit: 'deg' },
  });
  const sketch = clone(doc.parts[0]!.features[2] as SketchFeature);
  sketch.entities.push(entity);
  run({ type: 'editFeature', partId: PART, feature: sketch });
  return doc;
}

describe('the svg outline source', () => {
  it('is a sketch entity source that round-trips through a file', () => {
    expect(SketchEntitySchema.safeParse(artwork()).success).toBe(true);
    const doc = withArtwork();
    expect(validateDocument(doc)).toEqual([]);
    const again = unwrap(deserialize(serialize(doc))).document;
    expect(again).toEqual(doc);
  });

  it('refuses bad paths: unknown commands and fill rules, extra keys, too many commands', () => {
    const bad = (patch: (e: OutlineEntity & { source: { kind: 'svg' } }) => void) => {
      const e = clone(artwork()) as OutlineEntity & { source: { kind: 'svg' } };
      patch(e);
      return SketchEntitySchema.safeParse(e).success;
    };
    expect(bad((e) => ((e.source.paths[0]!.commands[1] as { kind: string }).kind = 'arcTo'))).toBe(
      false,
    );
    expect(bad((e) => ((e.source.paths[0] as { fillRule: string }).fillRule = 'odd'))).toBe(false);
    expect(bad((e) => Object.assign(e.source, { text: 'x' }))).toBe(false);
    expect(
      bad(
        (e) => ((e.source.paths[0]!.commands[0] as unknown as { to: number[] }).to = [Infinity, 0]),
      ),
    ).toBe(false);
    const many = Array.from({ length: MAX_SVG_OUTLINE_COMMANDS + 1 }, () => ({
      kind: 'lineTo' as const,
      to: [0, 0] as const,
    }));
    expect(SketchEntitySchema.safeParse(artwork('e10', many)).success).toBe(false);
    // Spread over many paths too.
    const half = many.slice(0, MAX_SVG_OUTLINE_COMMANDS / 2 + 1);
    expect(SketchEntitySchema.safeParse(artwork('e10', half, 2)).success).toBe(false);
  });

  it('caps the commands of every SVG outline of a sketch together', () => {
    const half = Array.from({ length: MAX_SKETCH_SVG_COMMANDS / 2 + 1 }, () => ({
      kind: 'lineTo' as const,
      to: [0, 0] as const,
    }));
    const doc = withArtwork(artwork('e10', half));
    expect(validateDocument(doc)).toEqual([]);
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    sketch.entities.push(artwork('e11', half));
    doc.parts[0]!.nextIds = { ...doc.parts[0]!.nextIds, e: 12 };
    expect(validateDocument(doc).map((e) => e.message)).toEqual([
      expect.stringMatching(/SVG artwork of sketch#2 has 100002 path commands together/),
    ]);
  });

  it('has its scale as a plain-number expression, renamed with its variable, and no font', () => {
    const doc = withArtwork();
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    expect(
      featureExpressions(sketch)
        .filter((x) => x.path[0] === 'entities')
        .map((x) => [x.path, x.expected]),
    ).toEqual([[['entities', 1, 'source', 'scale'], 'number']]);
    const renamed = unwrap(applyCommand(doc, unwrap(renameVariable(doc, 'k', 'size')))).document;
    const outline = (renamed.parts[0]!.features[2] as SketchFeature).entities[1] as OutlineEntity;
    expect(outline.source.kind === 'svg' && outline.source.scale?.source).toBe('#size');
  });
});
