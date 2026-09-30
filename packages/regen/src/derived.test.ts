import { MAX_DERIVED_DEPTH, featureIdsInName, type Part } from '@manufakture/core';
import { derivedName } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { DerivedSources, carriedProps, effectiveProps, sourceNamespace } from './derived';
import { PART, add, block, build, derivedOf, pin, pinText } from './test-helpers';

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
