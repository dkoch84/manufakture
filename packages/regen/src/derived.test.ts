import { MAX_DERIVED_DEPTH, deserialize, featureIdsInName, type Part } from '@manufakture/core';
import { derivedName } from '@manufakture/kernel';
import { describe, expect, it, vi } from 'vitest';
import { DerivedSources, carriedProps, effectiveProps, sourceNamespace } from './derived';
import { PART, add, block, build, derivedOf, pin, pinText, withRows } from './test-helpers';

// The real `deserialize`, wrapped so one test can make it throw.
vi.mock('@manufakture/core', async (original) => {
  const actual = await original<typeof import('@manufakture/core')>();
  return { ...actual, deserialize: vi.fn(actual.deserialize) };
});

describe('derived names as core reads them', () => {
  // Whatever the source name, the kernel's derived form depends on the deriving feature only.
  it.each([
    'extrude#1:cap:end',
    '(extrude#1:cap:end#2+extrude#2:cap:start)',
    '(extrude#1:cap:end+extrude#2:side:e5)#2',
    'fillet#3:corner:extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2',
    'fillet#3:corner:(extrude#1:a+extrude#2:b)&extrude#1:c&extrude#4:d',
    'fillet#3:round:import#2:face:7&extrude#1:cap:end',
    'pattern#7:i2/fillet#3:corner:extrude#1:a&extrude#2:b',
    'shell#2:offset:extrude#1:cap:end',
    'derived#2:from/fillet#3:corner:extrude#1:a&derived#2:from/extrude#1:b',
  ])('%s', (name) => {
    expect(featureIdsInName(derivedName(name, 'derived#1'))).toEqual(['derived#1']);
    // And inside a local merge or corner, the local members still count.
    const local = `fillet#9:corner:${derivedName(name, 'derived#1')}&extrude#5:side:e1`;
    expect(featureIdsInName(local)).toEqual(['fillet#9', 'derived#1', 'extrude#5']);
  });
});

describe('DerivedSources', () => {
  it('hashes a source object once, and reads a document once per hash', async () => {
    const sources = new DerivedSources();
    const source = pin(block());
    const first = await sources.open(source);
    expect(first.ok).toBe(true);
    // The same object is not hashed again: damaging it afterwards goes unseen, as for imports
    // (documents share unchanged objects between edits; an edit makes a new object).
    const damaged = Object.assign(source, { data: 'damaged' });
    const again = await sources.open(damaged);
    expect(again.ok && first.ok && again.document === first.document).toBe(true);
    // A new object is checked.
    expect((await sources.open({ ...damaged })).ok).toBe(false);
    // An equal copy of a good pin is hashed, then shares the document read by hash.
    const good = pin(block());
    const a = await sources.open(good);
    const b = await sources.open({ ...good });
    expect(a.ok && b.ok && a.document === b.document).toBe(true);
  });

  it('turns a source whose reading throws into a data error, not a failed regen', async () => {
    vi.mocked(deserialize).mockImplementationOnce(() => {
      throw new TypeError('a migration met a shape it did not expect');
    });
    const opened = await new DerivedSources().open(pin(block()));
    expect(opened).toMatchObject({
      ok: false,
      error: {
        code: 'source',
        field: ['source', 'data'],
        message: expect.stringMatching(/cannot be read: a migration met a shape/),
      },
    });
  });

  it('refuses a size that does not match, and forgets documents a regen did not use', async () => {
    const sources = new DerivedSources();
    const source = pin(block());
    expect(await sources.open({ ...source, size: source.size + 1 })).toMatchObject({
      ok: false,
      error: { code: 'source', field: ['source', 'sha256'] },
    });
    sources.begin();
    const first = await sources.open(source);
    sources.retain();
    const kept = await sources.open(source);
    sources.begin();
    sources.retain();
    const again = await sources.open(source);
    expect(first.ok && kept.ok && first.document === kept.document).toBe(true);
    expect(again.ok && first.ok && again.document !== first.document).toBe(true);
    expect(sourceNamespace(source)).toBe(`${source.sha256}\n${PART}`);
  });

  it('opens a source in the row it names, else its active row, each once, under a namespace per row', async () => {
    const sources = new DerivedSources();
    const doc = withRows(block(), 'radius', ['3mm', '5mm']);
    const source = { ...pin(doc), configuration: 'cfg#2' };
    const opened = await sources.open(source);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.row).toMatchObject({ id: 'cfg#2', name: '5mm' });
    expect(opened.namespace).toBe(`${source.sha256}\n${PART}\ncfg#2`);
    expect(opened.document.variables.find((v) => v.name === 'radius')!.expression.source).toBe(
      '5mm',
    );
    const again = await sources.open({ ...source });
    expect(again.ok && again.document === opened.document).toBe(true);
    // No row named and none active: the document as stored, under the plain namespace.
    const plain = await sources.open(pin(doc));
    expect(plain).toMatchObject({ ok: true, row: null, namespace: sourceNamespace(pin(doc)) });
    // A row it does not have.
    expect(await sources.open({ ...source, configuration: 'cfg#5' })).toMatchObject({
      ok: false,
      error: {
        code: 'source',
        field: ['source', 'configuration'],
        message: expect.stringMatching(/has no configuration row cfg#5/),
      },
    });
  });

  it('measures nesting without building, and a source it cannot open counts as one level', async () => {
    const sources = new DerivedSources();
    let doc = block();
    for (let n = 0; n < 3; n++) doc = build([add(derivedOf('derived#1', pin(doc)))]);
    // Four levels of sources: this one, the two it nests, and the block at the bottom.
    const four = pin(doc);
    expect(await sources.fits(four, 1)).toBe(true);
    expect(await sources.fits(four, MAX_DERIVED_DEPTH - 3)).toBe(true);
    expect(await sources.fits(four, MAX_DERIVED_DEPTH - 2)).toBe(false);
    const broken = build([add(derivedOf('derived#1', pinText('not json')))]);
    expect(await sources.fits(pin(broken), MAX_DERIVED_DEPTH - 1)).toBe(true);
  });
});

describe('body properties from a source', () => {
  const part = (bodies: Part['bodies'], material?: Part['material']): Part => ({
    id: PART,
    name: 'P',
    features: [],
    rollbackIndex: null,
    nextIds: {},
    bodies,
    ...(material === undefined ? {} : { material }),
  });

  it('a body shows its own settings, then what it inherited, then the part material', () => {
    const p = part([{ id: 'b', name: 'Own' }], 'pla');
    expect(effectiveProps(p, 'b', { name: 'Src', color: '#ff0000' })).toEqual({
      name: 'Own',
      color: '#ff0000',
      material: 'pla',
    });
    expect(effectiveProps(part([]), 'b', undefined)).toEqual({});
  });

  it('carries over only what the deriving part does not set', () => {
    const p = part([{ id: 'b', color: '#00ff00' }], 'petg');
    expect(carriedProps(p, 'b', { name: 'Src', color: '#ff0000', material: 'pla' })).toEqual({
      name: 'Src',
      material: 'pla',
    });
    expect(carriedProps(p, 'b', { color: '#ff0000' })).toBeUndefined();
    expect(carriedProps(p, 'b', undefined)).toBeUndefined();
  });
});
