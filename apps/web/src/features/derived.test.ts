import { createHash } from 'node:crypto';
import {
  deserialize,
  serialize,
  type DerivedFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import { describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../model/demo';
import { SECOND_BODY, twoBodyDocument } from '../model/twoBodies.test-fixture';
import {
  buildDerived,
  derivedFormOf,
  newDerivedForm,
  newerVersions,
  openSourceAt,
  pinLabel,
  pinOf,
  readPin,
  readUpdate,
  sourceBodies,
  updatePin,
  type DerivedForm,
} from './derived';
import { apply, derivedOf, deriving, fakeLibrary, version } from './derived.test-fixture';

const V1 = version('v-1', '6 mm', 1);
const V2 = version('v-2', '8 mm', 2);
const V3 = version('v-3', '10 mm', 3);

function source(name = 'Bracket'): ManufaktureDocument {
  return { ...demoDocument('doc-a'), name };
}

describe('pinning a version', () => {
  it('stores the canonical text of the version with its UTF-8 size and SHA-256', async () => {
    const doc = { ...source(), name: 'Bracket ✓' };
    const r = await pinOf(doc, V1, 'part#1');
    if (!r.ok) throw new Error(r.message);
    const data = serialize(doc);
    expect(r.value).toEqual({
      documentId: 'doc-a',
      documentName: 'Bracket ✓',
      versionId: 'v-1',
      versionName: '6 mm',
      partId: 'part#1',
      size: Buffer.byteLength(data, 'utf8'),
      sha256: createHash('sha256').update(data).digest('hex'),
      data,
    });
    // The pinned text reads back as the document.
    const back = deserialize(r.value.data);
    expect(back.ok && back.value.document).toEqual(doc);
  });

  it('names the document as given, carries a configuration row, and refuses a missing part', async () => {
    const r = await pinOf(source(), V1, 'part#1', {
      documentName: 'Renamed since',
      configuration: 'cfg#2',
    });
    expect(r.ok && r.value).toMatchObject({
      documentName: 'Renamed since',
      configuration: 'cfg#2',
    });
    expect(await pinOf(source(), V1, 'part#9')).toEqual({
      ok: false,
      message: 'The version "6 mm" has no part studio part#9.',
    });
  });

  it('reads the version from the library and pins it', async () => {
    const lib = fakeLibrary([
      { document: source(), versions: [{ version: V1, document: source('Bracket at 6') }] },
    ]);
    const r = await readPin(lib, 'doc-a', V1, 'part#1');
    if (!r.ok) throw new Error(r.message);
    expect(r.value.document.name).toBe('Bracket at 6');
    expect(r.value.source).toMatchObject({ versionId: 'v-1', documentName: 'Bracket at 6' });
    expect(lib.calls).toEqual(['readVersion doc-a v-1']);
    expect(await readPin(lib, 'gone', V1, 'part#1')).toEqual({
      ok: false,
      message: 'There is no document "gone".',
    });
    const throwing = { ...lib, readVersion: vi.fn().mockRejectedValue(new Error('disk')) };
    expect(await readPin(throwing, 'doc-a', V1, 'part#1')).toEqual({
      ok: false,
      message: 'disk',
    });
  });
});

describe('the bodies a source offers', () => {
  it('lists the new bodies of active features, with the names the part gives them', () => {
    expect(sourceBodies(demoDocument(), 'part#1')).toEqual([
      { bodyId: 'extrude#1', name: 'Extrude 1' },
    ]);
    const two = apply(twoBodyDocument(), {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#3',
      props: { name: 'Lid' },
    });
    expect(sourceBodies(two, 'part#1')).toEqual([
      { bodyId: 'extrude#1', name: 'Extrude 1' },
      { bodyId: 'extrude#3', name: 'Lid' },
    ]);
    // Suppressed or rolled back: not offered.
    const suppressed = apply(two, {
      type: 'editFeature',
      partId: 'part#1',
      feature: { ...SECOND_BODY, suppressed: true },
    });
    expect(sourceBodies(suppressed, 'part#1').map((b) => b.bodyId)).toEqual(['extrude#1']);
    expect(sourceBodies(two, 'part#9')).toEqual([]);
  });

  it('offers the bodies a derived feature of the source makes, through its own pin', async () => {
    const inner = await derivedOf(twoBodyDocument(), V1);
    const middle = deriving(inner, 'doc-m');
    expect(sourceBodies(middle, 'part#1')).toEqual([
      { bodyId: 'derived#1:from/extrude#1', name: 'Derived 1: extrude#1' },
      { bodyId: 'derived#1:from/extrude#3', name: 'Derived 1: extrude#3' },
    ]);
    const some = deriving({ ...inner, bodies: ['extrude#3'] }, 'doc-m');
    expect(sourceBodies(some, 'part#1').map((b) => b.bodyId)).toEqual(['derived#1:from/extrude#3']);
  });
});

describe('the derived part form', () => {
  it('adds a derived part at the rollback bar with its placement, as one command', async () => {
    const pinned = await pinOf(source(), V1, 'part#1');
    if (!pinned.ok) throw new Error(pinned.message);
    const doc = demoDocument('doc-b');
    const form: DerivedForm = {
      ...newDerivedForm(),
      source: pinned.value,
      bodies: ['extrude#1'],
      translation: ['10', '0', '#gap'],
      rotation: ['0', '0', '90'],
    };
    const withGap = apply(doc, {
      type: 'setVariable',
      name: 'gap',
      expression: { source: '5', lengthUnit: 'mm', angleUnit: 'deg' },
    });
    const r = buildDerived(form, { doc: withGap, partId: 'part#1' });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.label).toBe('Add Derived 1');
    expect(r.command.type).toBe('addFeature');
    expect(r.feature).toMatchObject({
      id: 'derived#1',
      name: 'Derived 1',
      bodies: ['extrude#1'],
      operation: 'new',
      placement: {
        translation: [{ source: '10' }, { source: '0' }, { source: '#gap' }],
        rotation: [{ source: '0' }, { source: '0' }, { source: '90' }],
      },
    });
    expect('scope' in r.feature).toBe(false);
    const added = apply(withGap, r.command);
    expect(added.parts[0]!.features.at(-1)).toEqual(r.feature);

    // Edited back into the same form; editing keeps its id and name.
    const again = derivedFormOf(r.feature);
    expect(again).toEqual(form);
    const edited = buildDerived(
      { ...again, operation: 'cut', scope: ['extrude#1'] },
      { doc: added, partId: 'part#1', existing: r.feature },
    );
    if (!edited.ok) throw new Error(JSON.stringify(edited.errors));
    expect(edited.label).toBe('Edit Derived 1');
    expect(edited.command.type).toBe('editFeature');
    expect(edited.feature).toMatchObject({
      id: 'derived#1',
      operation: 'cut',
      scope: ['extrude#1'],
    });
  });

  it('says what is missing or wrong, field by field', () => {
    const r = buildDerived(
      {
        ...newDerivedForm(),
        bodies: [],
        translation: ['1', '#nope', '2'],
        rotation: ['0', '5 mm', '0'],
      },
      { doc: demoDocument(), partId: 'part#1' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual([
      'bodies',
      'rotation-y',
      'source',
      'translation-y',
    ]);
    expect(r.errors.source).toBe('Choose a document, a version and a part studio.');
  });
});

describe('updating a pin', () => {
  it('knows the versions named after the pinned one', () => {
    expect(newerVersions([V1, V2, V3], 'v-1')).toEqual([V2, V3]);
    expect(newerVersions([V1, V2, V3], 'v-3')).toEqual([]);
    expect(newerVersions([V2, V3], 'v-1')).toBeNull();
  });

  it('moves the pin to another version of the same part as one edit', async () => {
    const a6 = source();
    const a8 = { ...source(), name: 'Bracket at 8' };
    const pinned = await derivedOf(a6, V1);
    const feature: DerivedFeature = {
      ...pinned,
      source: { ...pinned.source, configuration: 'cfg#1' },
      bodies: ['extrude#1'],
    };
    const lib = fakeLibrary([
      {
        document: a8,
        versions: [
          { version: V1, document: a6 },
          { version: V2, document: a8 },
        ],
      },
    ]);
    const r = await readUpdate(lib, 'part#1', feature, V2);
    if (!r.ok) throw new Error(r.message);
    const at8 = await pinOf(a8, V2, 'part#1');
    if (!at8.ok) throw new Error(at8.message);
    expect(r.value.label).toBe('Update Derived 1 to "8 mm"');
    expect(r.value.command).toMatchObject({
      type: 'editFeature',
      partId: 'part#1',
      feature: {
        id: 'derived#1',
        bodies: ['extrude#1'],
        source: {
          documentName: 'Bracket',
          versionId: 'v-2',
          versionName: '8 mm',
          partId: 'part#1',
          configuration: 'cfg#1',
          sha256: at8.value.sha256,
        },
      },
    });
    const doc = deriving(feature);
    expect(apply(doc, r.value.command).parts[0]!.features[0]).toMatchObject({
      source: { versionId: 'v-2' },
    });
    expect(updatePin('part#1', feature, feature.source).label).toBe('Update Derived 1 to "6 mm"');
    expect(pinLabel(feature.source)).toBe('Bracket at 6 mm');
  });
});

describe('opening a source', () => {
  const host = (current: string, versions = [V1, V2]) => {
    const opened: string[] = [];
    const viewed: string[] = [];
    return {
      opened,
      viewed,
      currentId: () => current,
      open: vi.fn(async (id: string) => {
        opened.push(id);
        current = id;
        return { ok: true, message: '' };
      }),
      listVersions: vi.fn(async (id: string) =>
        id === 'doc-a'
          ? { ok: true as const, value: versions }
          : { ok: false as const, message: 'There is no document.' },
      ),
      view: vi.fn((v: (typeof versions)[number]) => {
        viewed.push(`${current} ${v.name}`);
      }),
    };
  };
  const pin = {
    documentId: 'doc-a',
    documentName: 'Bracket',
    versionId: 'v-1',
    versionName: '6 mm',
  };

  it('opens the source document, then views the pinned version', async () => {
    const h = host('doc-b');
    expect(await openSourceAt(h, pin)).toEqual({ ok: true, value: V1 });
    expect(h.opened).toEqual(['doc-a']);
    expect(h.viewed).toEqual(['doc-a 6 mm']);
  });

  it('views it in place when the source is the open document', async () => {
    const h = host('doc-a');
    expect((await openSourceAt(h, pin)).ok).toBe(true);
    expect(h.opened).toEqual([]);
    expect(h.viewed).toEqual(['doc-a 6 mm']);
  });

  it('opens nothing when the source or the version is not here', async () => {
    const gone = host('doc-b');
    expect(await openSourceAt(gone, { ...pin, documentId: 'doc-x' })).toEqual({
      ok: false,
      message: 'Bracket at "6 mm" is not in this browser\'s documents.',
    });
    const noVersion = host('doc-b', [V2]);
    expect((await openSourceAt(noVersion, pin)).ok).toBe(false);
    expect([...gone.opened, ...noVersion.opened]).toEqual([]);
  });

  it('says why opening failed', async () => {
    const h = host('doc-b');
    h.open.mockResolvedValueOnce({ ok: false, message: 'Changes are not saved.' });
    expect(await openSourceAt(h, pin)).toEqual({ ok: false, message: 'Changes are not saved.' });
    expect(h.viewed).toEqual([]);
  });
});
