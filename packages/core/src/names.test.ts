import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { featureIdsInName } from './features';
import { mapName, parseName, printName, subIdsInName, type NamePart } from './names';
import { FEATURE_KINDS } from './schema';
import { Rng } from './sync-test-generator';

const feature = (id: string): NamePart => ({ kind: 'feature', id });
const text = (t: string): NamePart => ({ kind: 'text', text: t });
const sub = (id: string, suffix = ''): NamePart => ({ kind: 'sub', id, suffix });
const source = (t: string): NamePart => ({ kind: 'source', text: t });

describe('parseName: every naming form', () => {
  it.each<[string, string, NamePart[]]>([
    ['born, role only', 'extrude#1:cap', [feature('extrude#1'), text(':cap')]],
    ['born, text tail', 'extrude#1:cap:end', [feature('extrude#1'), text(':cap:end')]],
    ['born, sub-id tail', 'extrude#1:side:e2', [feature('extrude#1'), text(':side:'), sub('e2')]],
    [
      'born, sketch split',
      'extrude#1:side:e2#a#b',
      [feature('extrude#1'), text(':side:'), sub('e2', '#a#b')],
    ],
    [
      'born, region edge (positional sub-id)',
      'extrude#1:side:e2#1',
      [feature('extrude#1'), text(':side:'), sub('e2', '#1')],
    ],
    [
      'born, split region edge',
      'extrude#1:side:e2#a#3',
      [feature('extrude#1'), text(':side:'), sub('e2', '#a#3')],
    ],
    [
      'born, reference tail',
      'fillet#3:round:r1',
      [feature('fillet#3'), text(':round:'), sub('r1')],
    ],
    ['hole point', 'hole#6:wall:e5', [feature('hole#6'), text(':wall:'), sub('e5')]],
    ['region cap', 'extrude#1:cap:start#2', [feature('extrude#1'), text(':cap:start#2')]],
    [
      'nested name',
      'shell#5:offset:extrude#1:cap:end',
      [feature('shell#5'), text(':offset:'), feature('extrude#1'), text(':cap:end')],
    ],
    ['kernel piece', 'extrude#1:cap:end#1', [feature('extrude#1'), text(':cap:end#1')]],
    [
      'merge with a piece',
      '(extrude#1:cap:end+extrude#2:side:e5)#2',
      [
        text('('),
        feature('extrude#1'),
        text(':cap:end+'),
        feature('extrude#2'),
        text(':side:'),
        sub('e5'),
        text(')#2'),
      ],
    ],
    [
      'corner of three faces',
      'fillet#3:corner:extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2',
      [
        feature('fillet#3'),
        text(':corner:'),
        feature('extrude#1'),
        text(':cap:end&'),
        feature('extrude#1'),
        text(':side:'),
        sub('e1'),
        text('&'),
        feature('extrude#1'),
        text(':side:'),
        sub('e2'),
      ],
    ],
    [
      'pattern instance',
      'pattern#7:i2/extrude#1:side:e7#a',
      [feature('pattern#7'), text(':i2/'), feature('extrude#1'), text(':side:'), sub('e7', '#a')],
    ],
    [
      'mirror image',
      'mirror#8:image/hole#5:wall:e5',
      [feature('mirror#8'), text(':image/'), feature('hole#5'), text(':wall:'), sub('e5')],
    ],
    ['pattern body id', 'pattern#2:i3', [feature('pattern#2'), text(':i3')]],
    ['imported face', 'import#9:face:4', [feature('import#9'), text(':face:4')]],
    ['placeholder', '?face3', [text('?face3')]],
    ['wrapped placeholder', 'hole#2:?face3', [feature('hole#2'), text(':?face3')]],
    [
      'derived prefix',
      'derived#1:from/extrude#1:cap:end',
      [feature('derived#1'), text(':from/'), source('extrude#1:cap:end')],
    ],
    [
      'derived merge member',
      '(derived#1:from/(extrude#1:a+extrude#2:b)#2+extrude#3:side:e1)',
      [
        text('('),
        feature('derived#1'),
        text(':from/'),
        source('(extrude#1:a+extrude#2:b)#2'),
        text('+'),
        feature('extrude#3'),
        text(':side:'),
        sub('e1'),
        text(')'),
      ],
    ],
    ['thread turn', 'thread#5:thread:root:3', [feature('thread#5'), text(':thread:root:3')]],
    ['tools face', 'extension#7:t2:xmax', [feature('extension#7'), text(':t2:xmax')]],
    [
      'edge name',
      'extrude#1:side:e1|extrude#1:side:e2[extrude#1:cap:end]#1',
      [
        feature('extrude#1'),
        text(':side:'),
        sub('e1'),
        text('|'),
        feature('extrude#1'),
        text(':side:'),
        sub('e2'),
        text('['),
        feature('extrude#1'),
        text(':cap:end]#1'),
      ],
    ],
    ['bare body id is text', 'extrude#3', [text('extrude#3')]],
    ['unknown kind is text', 'cut#4:side:s3', [text('cut#4:side:s3')]],
  ])('%s: %s', (_form, name, parts) => {
    expect(parseName(name)).toEqual(parts);
    expect(printName(parseName(name))).toBe(name);
  });

  it('treats a sub-id-looking role as a role, not a tail', () => {
    expect(subIdsInName('extension#7:e2:xmax')).toEqual([]);
    expect(subIdsInName('extrude#1:side:e7:more')).toEqual([]);
    expect(subIdsInName('extrude#1:side:e7')).toEqual(['e7']);
  });
});

/** Every string literal in a source file that looks like a face name. */
function namesIn(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\\n]*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? '';
    if (/[a-z]#[0-9]+[:/]|\?face|#[0-9]+:/.test(s)) out.push(s);
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|json)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('round trips over the test goldens', () => {
  const packages = fileURLToPath(new URL('../../', import.meta.url));
  const dirs = ['kernel/src', 'kernel/test', 'regen/src', 'core/src/fixtures'].map((d) =>
    join(packages, d),
  );
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const file of filesUnder(dir)) {
      for (const n of namesIn(readFileSync(file, 'utf8'))) names.add(n);
    }
  }

  it('finds the goldens', () => {
    // The kernel and regen tests name hundreds of faces; a drop means the scan broke.
    expect(names.size).toBeGreaterThan(200);
  });

  it('prints back every name in the kernel, regen and core test goldens', () => {
    const bad = [...names].filter((n) => printName(parseName(n)) !== n);
    expect(bad).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    // Names taken from the goldens, with frozen expected outputs: feature ids, then sub-ids.
    ['(extrude#1:cap:end+extrude#2:side:e5)#2', ['extrude#1', 'extrude#2'], ['e5']],
    ['(fillet#3:corner:A&B+extrude#2:c)', ['fillet#3', 'extrude#2'], []],
    ['(cut#4:side:s3#1+x)', [], []],
    ['derived#2:from/fillet#3:corner:A&derived#2:from/B', ['derived#2'], []],
    ['derived#4:from/extrude#1:side:e2#1', ['derived#4'], []],
    ['e#1:side:e2#a', [], []],
    ['extension#1:layer/sheathing', ['extension#1'], []],
    ['extension#1:r0', ['extension#1'], []],
    ['extrude#1:cap.b:end', ['extrude#1'], []],
    ['extrude#1:cap:end&extrude#1:side:e1&extrude#1:side:e2', ['extrude#1'], ['e1', 'e2']],
    ['extrude#1:cap:start|extrude#1:side:e1', ['extrude#1'], ['e1']],
    ['extrude#2:side:c1|extrude#2:side:c1', ['extrude#2'], []],
    ['extrude#1:side:e2#1', ['extrude#1'], ['e2']],
    ['extrude#1:side:e2#a', ['extrude#1'], ['e2']],
    ['extrude#1:', ['extrude#1'], []],
    ['chamfer#2:bevel:r1', ['chamfer#2'], ['r1']],
  ])('golden %s', (name, features, subs) => {
    expect(names.has(name), 'still in the goldens').toBe(true);
    expect(featureIdsInName(name)).toEqual(features);
    expect(subIdsInName(name)).toEqual(subs);
  });
});

/** A random name of every form, nested a few levels. */
function randomName(rng: Rng, depth = 0): string {
  const fid = () => `${rng.pick(FEATURE_KINDS)}#${1 + rng.int(30)}`;
  const subId = () =>
    `${rng.pick(['e', 'k', 'r'])}${1 + rng.int(40)}${rng.pick(['', '#a', '#a#b', '#1', '#a#2'])}`;
  const leaf = () =>
    rng.pick([
      () => `${fid()}:side:${subId()}`,
      () => `${fid()}:cap:${rng.pick(['start', 'end', 'start#2', 'end#1'])}`,
      () => `${fid()}:face:${1 + rng.int(9)}`,
      () => `?face${1 + rng.int(9)}`,
      () => `${fid()}:thread:root:${rng.int(5)}`,
      () => `${fid()}:t${rng.int(3)}:xmax`,
      () => fid(),
    ])();
  if (depth >= 3) return leaf();
  const inner = () => randomName(rng, depth + 1);
  return rng.pick([
    leaf,
    () => `${fid()}:round:${inner()}`,
    () => `${fid()}:corner:${inner()}&${inner()}&${inner()}`,
    () => `(${inner()}+${inner()})${rng.pick(['', '#2'])}`,
    () => `${fid()}:i${rng.int(5)}/${inner()}`,
    () => `${fid()}:image/${inner()}`,
    () => `derived#${1 + rng.int(3)}:from/${inner()}`,
    () => `${inner()}#${1 + rng.int(3)}`,
    () => `${inner()}|${inner()}`,
  ])();
}

describe('round trips over generated names', () => {
  it('prints back 5,000 random names of every form', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const n = randomName(rng);
      expect(printName(parseName(n))).toBe(n);
    }
  });

  it('prints back arbitrary strings, junk included', () => {
    const rng = new Rng(11);
    const alphabet = ['(', ')', '+', '&', ':', '/', '#', '|', 'e', '1', 'extrude#1:', 'from/', '?'];
    for (let i = 0; i < 2000; i++) {
      let s = '';
      for (let k = rng.int(30); k > 0; k--) s += rng.pick(alphabet);
      expect(printName(parseName(s))).toBe(s);
    }
  });

  it('is linear on hostile input', () => {
    const start = performance.now();
    const deep = `${'('.repeat(100_000)}extrude#1:cap:end${')'.repeat(100_000)}`;
    expect(printName(parseName(deep))).toBe(deep);
    const chain = 'shell#1:offset:'.repeat(50_000) + 'extrude#1:side:e1';
    expect(printName(parseName(chain))).toBe(chain);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('mapName', () => {
  const maps = {
    feature: (id: string) =>
      ({ 'extrude#1': 'extrude#4', 'fillet#3': 'fillet#9', 'derived#1': 'derived#2' })[id] ?? id,
    sub: (id: string) => ({ e7: 'e9', r1: 'r5' })[id] ?? id,
  };

  it.each([
    ['extrude#1:side:e7#a', 'extrude#4:side:e9#a'],
    ['extrude#1:side:e7#1', 'extrude#4:side:e9#1'],
    ['fillet#3:round:r1', 'fillet#9:round:r5'],
    ['(extrude#1:side:e7+extrude#1:side:e2)#2', '(extrude#4:side:e9+extrude#4:side:e2)#2'],
    ['derived#1:from/extrude#1:side:e7', 'derived#2:from/extrude#1:side:e7'],
    ['extension#3:layer/sheathing', 'extension#3:layer/sheathing'],
    ['?face', '?face'],
  ])('%s', (from, to) => {
    expect(mapName(from, maps)).toBe(to);
  });

  it('returns the very same string when nothing changes', () => {
    const name = 'extrude#2:side:e2';
    expect(mapName(name, maps)).toBe(name);
  });
});
