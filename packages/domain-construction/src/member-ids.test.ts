import { describe, expect, it } from 'vitest';
import {
  formatOpeningMemberId,
  formatWallMemberId,
  memberFullId,
  memberIds,
  parseOpeningMemberId,
  parseWallMemberId,
  splitMemberFullId,
} from './member-ids';

// One id per wall form (ADR 0015 decision 6), with and without the segment prefix.
const WALL_FORMS: Array<[string, ReturnType<typeof parseWallMemberId>]> = [
  ['s0', { form: 'slot', segment: 1, slot: 0 }],
  ['s12', { form: 'slot', segment: 1, slot: 12 }],
  ['seg2/s12', { form: 'slot', segment: 2, slot: 12 }],
  ['top1:2', { form: 'plate', segment: 1, plate: 'top', course: 1, piece: 2 }],
  ['bottom1:1', { form: 'plate', segment: 1, plate: 'bottom', course: 1, piece: 1 }],
  ['seg3/top2:1', { form: 'plate', segment: 3, plate: 'top', course: 2, piece: 1 }],
  ['block1:4', { form: 'block', segment: 1, row: 1, n: 4 }],
  ['start:corner', { form: 'corner', segment: 1, end: 'start', name: 'corner' }],
  ['end:corner-2', { form: 'corner', segment: 1, end: 'end', name: 'corner-2' }],
  ['seg2/end:backing3', { form: 'corner', segment: 2, end: 'end', name: 'backing3' }],
  ['t1:corner-l', { form: 'tee', segment: 1, tee: 1, name: 'corner-l' }],
  ['t2:backing1', { form: 'tee', segment: 1, tee: 2, name: 'backing1' }],
];

// One id per opening form.
const OPENING_FORMS: Array<[string, ReturnType<typeof parseOpeningMemberId>]> = [
  ['king-l', { form: 'king', side: 'l', n: 1 }],
  ['king-r2', { form: 'king', side: 'r', n: 2 }],
  ['jack-r', { form: 'jack', side: 'r', n: 1 }],
  ['jack-l12', { form: 'jack', side: 'l', n: 12 }],
  ['header', { form: 'header', n: 1 }],
  ['header-2', { form: 'header', n: 2 }],
  ['spacer', { form: 'spacer' }],
  ['sill', { form: 'sill' }],
  ['cripple-a2', { form: 'cripple', where: 'above', n: 2 }],
  ['cripple-b1', { form: 'cripple', where: 'below', n: 1 }],
];

describe('wall member ids', () => {
  it.each(WALL_FORMS)('parses and formats %s back to itself', (id, parsed) => {
    expect(parseWallMemberId(id)).toEqual(parsed);
    expect(formatWallMemberId(parsed!)).toBe(id);
  });

  it('rejects ids of no wall form, opening members and non-canonical spellings', () => {
    for (const id of [
      '',
      's',
      's01',
      'seg1/s2',
      'seg02/s2',
      'top0:1',
      'top1:0',
      'top01:1',
      'start:backing0',
      'start:backing01',
      'middle:corner',
      't1:corner',
      // Opening members belong to the opening, never to the wall.
      'king-l',
      'header',
      'extension#7:king-l',
      'seg2/extension#7:king-l',
    ])
      expect(parseWallMemberId(id), id).toBeUndefined();
  });
});

describe('opening member ids', () => {
  it.each(OPENING_FORMS)('parses and formats %s back to itself', (id, parsed) => {
    expect(parseOpeningMemberId(id)).toEqual(parsed);
    expect(formatOpeningMemberId(parsed!)).toBe(id);
  });

  it('rejects non-canonical spellings, so one member has one id', () => {
    for (const id of [
      'king-l1',
      'jack-r1',
      'king-l01',
      'header-1',
      'header-0',
      'header-02',
      'header2',
      'cripple-a0',
      'cripple-a01',
      'cripple-c1',
      'king',
      'king-x',
      'sill1',
      'extension#7:king-l',
      's12',
    ])
      expect(parseOpeningMemberId(id), id).toBeUndefined();
  });
});

describe('full member ids', () => {
  it('puts the owner in front and splits at the first colon only', () => {
    expect(memberFullId({ owner: 'extension#7', id: 'king-l' })).toBe('extension#7:king-l');
    expect(memberFullId({ owner: 'extension#3', id: 'top1:2' })).toBe('extension#3:top1:2');
    expect(splitMemberFullId('extension#3:top1:2')).toEqual({ owner: 'extension#3', id: 'top1:2' });
    expect(splitMemberFullId('extension#7:king-l')).toEqual({ owner: 'extension#7', id: 'king-l' });
    for (const full of ['s12', 'extension#3:', 'door:king-l', 'extension#0:sill', ':s1'])
      expect(splitMemberFullId(full), full).toBeUndefined();
  });

  it('builds the same ids the parsers read', () => {
    expect(memberIds.slot(1, 12)).toBe('s12');
    expect(memberIds.slot(2, 0)).toBe('seg2/s0');
    expect(memberIds.plate(1, 'top', 1, 2)).toBe('top1:2');
    expect(memberIds.block(1, 2, 3)).toBe('block2:3');
    expect(memberIds.corner(1, 'start', 'backing2')).toBe('start:backing2');
    expect(memberIds.tee(4, 1, 'corner-c')).toBe('seg4/t1:corner-c');
    expect(memberIds.opening({ form: 'king', side: 'l', n: 1 })).toBe('king-l');
    expect(memberIds.opening({ form: 'header', n: 1 })).toBe('header');
    expect(memberIds.opening({ form: 'header', n: 3 })).toBe('header-3');
  });
});
