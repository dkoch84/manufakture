import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { CommandSchema, applyCommand, fontUsers, type Command } from './commands';
import { deserialize, serialize } from './format';
import { featureExpressions } from './features';
import type { CoreErrorCode } from './result';
import {
  DocumentSchema,
  FontSchema,
  MAX_FONT_TOTAL_BYTES,
  MAX_OUTLINE_TEXT,
  MAX_SKETCH_OUTLINE_TEXT,
  SketchEntitySchema,
  codePointLength,
  fontBytes,
  type DocumentFont,
  type ManufaktureDocument,
  type OutlineEntity,
  type SketchFeature,
} from './schema';
import { validateDocument } from './validate';
import { renameVariable } from './variables';
import { PART, bracket, clone, mm, unwrap } from './test-helpers';

/** Fonts and the outline sketch entity (format v9, ADR 0012 decisions 7 and 8). */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const bundled = (id = 'font#1', sha256 = SHA_A): DocumentFont => ({
  id,
  family: 'Inter',
  style: 'Bold',
  source: { kind: 'bundled', id: 'inter-bold', sha256 },
});

/** A user font of four bytes, "abcd". */
const userFont = (id = 'font#2'): DocumentFont => ({
  id,
  family: 'My Font',
  style: 'Regular',
  source: { kind: 'file', fileName: 'my.ttf', size: 4, sha256: SHA_B, data: 'YWJjZA==' },
});

const label = (id = 'e10', font = 'font#1', text = 'M3'): OutlineEntity => ({
  id,
  kind: 'outline',
  construction: false,
  anchor: [20, 10],
  angle: 0,
  source: {
    kind: 'text',
    text,
    font,
    size: mm('#size'),
    align: { horizontal: 'center', vertical: 'middle' },
  },
});

/** The bracket with font#1 and a text in its hole sketch, and a `size` variable. */
function labelled(): ManufaktureDocument {
  let doc = bracket();
  const run = (c: Command) => (doc = unwrap(applyCommand(doc, c)).document);
  run({ type: 'setVariable', name: 'size', expression: mm('6mm') });
  run({ type: 'addFont', font: bundled() });
  const sketch = clone(doc.parts[0]!.features[2] as SketchFeature);
  sketch.entities.push(label());
  sketch.constraints.push({
    id: 'k7',
    kind: 'coincident',
    a: { entity: 'e10', at: 'anchor' },
    b: { entity: 'e5', at: 'center' },
  });
  run({ type: 'editFeature', partId: PART, feature: sketch });
  return doc;
}

describe('schema', () => {
  it('accepts an outline entity and fonts of both kinds', () => {
    expect(SketchEntitySchema.safeParse(label()).success).toBe(true);
    const spaced = label();
    spaced.source.letterSpacing = mm('0.2');
    spaced.source.lineSpacing = { source: '1.2', lengthUnit: 'mm', angleUnit: 'deg' };
    expect(SketchEntitySchema.safeParse(spaced).success).toBe(true);
    expect(FontSchema.safeParse(bundled()).success).toBe(true);
    expect(FontSchema.safeParse(userFont()).success).toBe(true);
  });

  it('refuses malformed outlines', () => {
    const bad: [
      string,
      (e: Record<string, unknown> & { source: Record<string, unknown> }) => void,
    ][] = [
      ['an unknown source kind', (e) => (e.source.kind = 'svg')],
      ['a font that is not a font id', (e) => (e.source.font = 'inter-bold')],
      ['a missing size', (e) => delete e.source.size],
      [
        'an alignment that is not one',
        (e) => (e.source.align = { horizontal: 'middle', vertical: 'top' }),
      ],
      ['an undefined spacing', (e) => (e.source.letterSpacing = undefined)],
      ['a non-finite angle', (e) => (e.angle = Number.NaN)],
      ['a missing anchor', (e) => delete e.anchor],
      ['an extra key', (e) => (e.source.bold = true)],
      ['too long a text', (e) => (e.source.text = 'x'.repeat(MAX_OUTLINE_TEXT + 1))],
      [
        'too long a text in astral characters',
        (e) => (e.source.text = '😀'.repeat(MAX_OUTLINE_TEXT + 1)),
      ],
    ];
    for (const [what, change] of bad) {
      const e = clone(label()) as unknown as Record<string, unknown> & {
        source: Record<string, unknown>;
      };
      change(e);
      expect([what, SketchEntitySchema.safeParse(e).success]).toEqual([what, false]);
    }
    const longest = label();
    longest.source.text = '😀'.repeat(MAX_OUTLINE_TEXT);
    expect(SketchEntitySchema.safeParse(longest).success).toBe(true);
    expect(codePointLength('a😀\ud800b')).toBe(4);
  });

  it('refuses malformed fonts', () => {
    const bad: [string, DocumentFont | Record<string, unknown>][] = [
      ['an id that is not font#n', { ...bundled(), id: 'font1' }],
      ['an empty family', { ...bundled(), family: '' }],
      [
        'a bundled id with capitals',
        { ...bundled(), source: { kind: 'bundled', id: 'Inter', sha256: SHA_A } },
      ],
      [
        'a hash in capitals',
        { ...bundled(), source: { kind: 'bundled', id: 'inter-bold', sha256: 'A'.repeat(64) } },
      ],
      [
        'bytes on a bundled font',
        { ...bundled(), source: { ...bundled().source, data: 'YWJjZA==' } },
      ],
      [
        'data that does not hold size bytes',
        { ...userFont(), source: { ...userFont().source, size: 5 } },
      ],
      [
        'data that is not base64',
        { ...userFont(), source: { ...userFont().source, data: 'ab$d' } },
      ],
      [
        'a file over 20 MiB',
        { ...userFont(), source: { ...userFont().source, size: 21 * 1024 * 1024 } },
      ],
    ];
    for (const [what, font] of bad) {
      expect([what, FontSchema.safeParse(font).success]).toEqual([what, false]);
    }
  });

  it('keeps fonts after the print section and saves them in schema order', () => {
    const doc = labelled();
    expect(DocumentSchema.safeParse(doc).success).toBe(true);
    const keys = Object.keys(JSON.parse(serialize(doc)));
    expect(keys.indexOf('fonts')).toBe(keys.indexOf('print') + 1);
    const back = unwrap(deserialize(serialize(doc)));
    expect(back.document).toEqual(doc);
    expect(back.migrated).toBe(false);
  });
});

describe('validation', () => {
  const codes = (doc: ManufaktureDocument) =>
    validateDocument(doc).map((e): [CoreErrorCode, (string | number)[]] => [e.code, [...e.path]]);

  it('passes a document whose outlines use its fonts', () => {
    expect(validateDocument(labelled())).toEqual([]);
  });

  it('refuses an outline whose font is not in the document', () => {
    const doc = labelled();
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    (sketch.entities[1] as OutlineEntity).source.font = 'font#7';
    expect(codes(doc)).toEqual([
      ['dependency', ['parts', 0, 'features', 2, 'entities', 1, 'source', 'font']],
    ]);
    expect(validateDocument(doc)[0]!.blockers).toEqual(['font#7']);
  });

  it('refuses font ids that were never allocated or are used twice', () => {
    const doc = labelled();
    doc.fonts.push({ ...userFont('font#1') });
    doc.fonts.push(userFont('font#9'));
    expect(codes(doc)).toEqual([
      ['invalid-id', ['fonts', 2, 'id']],
      ['duplicate', ['fonts', 1, 'id']],
    ]);
  });

  it('refuses an outline with a split id, and a point reference to an outline without "anchor"', () => {
    const doc = labelled();
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    sketch.entities[1] = { ...label('e10#a'), source: label().source };
    const k7 = sketch.constraints[1]!;
    if (k7.kind === 'coincident') k7.a = { entity: 'e10#a', at: 'center' };
    expect(codes(doc)).toEqual([
      ['invalid-id', ['parts', 0, 'features', 2, 'entities', 1, 'id']],
      ['sketch', ['parts', 0, 'features', 2, 'constraints', 1, 'a']],
    ]);
  });

  it('caps the text of all the outlines of one sketch together', () => {
    const doc = labelled();
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    const n = MAX_SKETCH_OUTLINE_TEXT / MAX_OUTLINE_TEXT;
    sketch.entities = [
      ...sketch.entities.slice(0, 1),
      ...Array.from({ length: n + 1 }, (_, i) =>
        label(`e${20 + i}`, 'font#1', 'x'.repeat(MAX_OUTLINE_TEXT)),
      ),
    ];
    sketch.constraints = sketch.constraints.slice(0, 1);
    doc.parts[0]!.nextIds.e = 100;
    expect(codes(doc)).toEqual([['sketch', ['parts', 0, 'features', 2, 'entities']]]);
    sketch.entities.pop();
    expect(codes(doc)).toEqual([]);
  });

  it('checks the size and spacing expressions like any other', () => {
    const doc = labelled();
    const sketch = doc.parts[0]!.features[2] as SketchFeature;
    const outline = sketch.entities[1] as OutlineEntity;
    expect(featureExpressions(sketch).map((s) => [s.path, s.expected])).toEqual([
      [['constraints', 0, 'value'], 'length'],
      [['entities', 1, 'source', 'size'], 'length'],
    ]);
    outline.source.letterSpacing = mm('#nope');
    outline.source.lineSpacing = mm('1.2 +');
    expect(codes(doc)).toEqual([
      [
        'unknown-variable',
        ['parts', 0, 'features', 2, 'entities', 1, 'source', 'letterSpacing', 'source'],
      ],
      ['expression', ['parts', 0, 'features', 2, 'entities', 1, 'source', 'lineSpacing', 'source']],
    ]);
  });
});

describe('commands', () => {
  it('adds a font with a fresh id, and undoes it', () => {
    const doc = bracket();
    const add = unwrap(applyCommand(doc, { type: 'addFont', font: bundled() }));
    expect(add.document.fonts).toEqual([bundled()]);
    expect(add.document.nextIds.font).toBe(2);
    expect(add.inverse).toEqual({ type: 'deleteFont', fontId: 'font#1' });
    const undone = unwrap(applyCommand(add.document, add.inverse));
    expect(undone.document.fonts).toEqual([]);
    // The counter does not go back, so the id is never handed out again.
    expect(undone.document.nextIds.font).toBe(2);
    const again = applyCommand(undone.document, { type: 'addFont', font: bundled() });
    expect(again.ok ? null : again.error.code).toBe('id-reused');
    const redone = unwrap(applyCommand(undone.document, undone.inverse));
    expect(redone.document.fonts).toEqual([bundled()]);
  });

  it('refuses a second copy of the same bytes, a bad id, and a duplicate id', () => {
    const doc = labelled();
    const cases: [Command, CoreErrorCode][] = [
      [{ type: 'addFont', font: bundled('font#2') }, 'duplicate'],
      [{ type: 'addFont', font: { ...userFont(), id: 'font#1' } }, 'duplicate'],
      [{ type: 'addFont', font: { ...userFont(), id: 'font#03' } }, 'schema'],
      [{ type: 'addFont', font: userFont('font#2'), index: 5 }, 'invalid-index'],
      [{ type: 'deleteFont', fontId: 'font#9' }, 'not-found'],
      [{ type: 'restoreFont', font: userFont('font#5'), index: 0 }, 'invalid-id'],
    ];
    for (const [command, code] of cases) {
      const r = applyCommand(doc, command);
      expect([command.type, r.ok ? null : r.error.code]).toEqual([command.type, code]);
    }
    expect(
      unwrap(applyCommand(doc, { type: 'addFont', font: userFont() })).document.fonts,
    ).toHaveLength(2);
  });

  it('refuses to delete a font an outline uses, naming the outlines', () => {
    const doc = labelled();
    expect(fontUsers(doc, 'font#1')).toEqual(['part#1/sketch#2/e10']);
    const r = applyCommand(doc, { type: 'deleteFont', fontId: 'font#1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('dependency');
      expect(r.error.blockers).toEqual(['part#1/sketch#2/e10']);
    }
    // Nor can a sketch edit leave an outline without its font.
    const sketch = clone(doc.parts[0]!.features[2] as SketchFeature);
    (sketch.entities[1] as OutlineEntity).source.font = 'font#2';
    const edit = applyCommand(doc, { type: 'editFeature', partId: PART, feature: sketch });
    expect(edit.ok ? null : edit.error.code).toBe('dependency');
  });

  it('deletes an unused font and restores it in place', () => {
    let doc = labelled();
    doc = unwrap(applyCommand(doc, { type: 'addFont', font: userFont() })).document;
    const del = unwrap(applyCommand(doc, { type: 'deleteFont', fontId: 'font#2' }));
    expect(del.document.fonts.map((f) => f.id)).toEqual(['font#1']);
    expect(del.inverse).toEqual({ type: 'restoreFont', font: userFont(), index: 1 });
    expect(unwrap(applyCommand(del.document, del.inverse)).document).toEqual(doc);
    expect(CommandSchema.safeParse(del.inverse).success).toBe(true);
  });

  it('renames a variable a text size reads', () => {
    const doc = labelled();
    const batch = unwrap(renameVariable(doc, 'size', 'label'));
    const renamed = unwrap(applyCommand(doc, batch)).document;
    const outline = (renamed.parts[0]!.features[2] as SketchFeature).entities[1] as OutlineEntity;
    expect(outline.source.size.source).toBe('#label');
  });

  it('reports a font change apart from the parts', () => {
    const doc = labelled();
    const added = unwrap(applyCommand(doc, { type: 'addFont', font: userFont() })).document;
    const change = diffDocuments(doc, added);
    expect(change.fontsChanged).toBe(true);
    expect(change.parts).toEqual([]);
    expect(diffDocuments(doc, doc).fontsChanged).toBe(false);
  });
});

describe('the total size of fonts', () => {
  /** A user font of `mib` MiB (zero bytes), told apart by its SHA-256. */
  const big = (id: string, mib: number, sha: string): DocumentFont => {
    const size = mib * 1024 * 1024;
    return {
      id,
      family: 'Big',
      style: 'Regular',
      source: { kind: 'file', fileName: `${id}.ttf`, size, sha256: sha, data: zeros(size) },
    };
  };
  const cache = new Map<number, string>();
  const zeros = (size: number) => {
    let data = cache.get(size);
    if (data === undefined) {
      // Base64 of `size` zero bytes (`size` a multiple of 3 needs no padding; else pad).
      const whole = Math.floor(size / 3);
      const rest = size % 3;
      data = 'A'.repeat(whole * 4) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=');
      cache.set(size, data);
    }
    return data;
  };

  it('counts only user fonts, by their size', () => {
    expect(fontBytes([bundled(), userFont(), userFont('font#3')])).toBe(8);
    expect(MAX_FONT_TOTAL_BYTES).toBe(64 * 1024 * 1024);
  });

  it('refuses a font that takes the document past 64 MiB of fonts, in the command and the schema', () => {
    let doc = bracket();
    for (const [i, sha] of [SHA_A, SHA_B, 'c'.repeat(64)].entries()) {
      doc = unwrap(
        applyCommand(doc, { type: 'addFont', font: big(`font#${i + 1}`, 20, sha) }),
      ).document;
    }
    expect(fontBytes(doc.fonts)).toBe(60 * 1024 * 1024);
    const r = applyCommand(doc, { type: 'addFont', font: big('font#4', 5, 'd'.repeat(64)) });
    expect(r.ok ? null : [r.error.code, r.error.message]).toEqual([
      'schema',
      expect.stringMatching(/fonts would hold 65\.0 MiB; at most 64\.0 MiB/),
    ]);
    // Within the limit is fine.
    expect(applyCommand(doc, { type: 'addFont', font: big('font#4', 4, 'd'.repeat(64)) }).ok).toBe(
      true,
    );
    // A document that holds more anyway (a crafted file) does not load.
    const crafted = { ...doc, fonts: [...doc.fonts, big('font#4', 5, 'd'.repeat(64))] };
    crafted.nextIds = { ...crafted.nextIds, font: 5 };
    const parsed = DocumentSchema.safeParse(crafted);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/fonts hold \d+ bytes; at most/);
  });
});
