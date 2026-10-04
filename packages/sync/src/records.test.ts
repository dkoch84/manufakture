import { describe, expect, it } from 'vitest';
import {
  CreateBranchSchema,
  CreateVersionSchema,
  ServerBranchSchema,
  ServerVersionSchema,
  sameRecord,
} from './records';

const version = {
  id: 'b0b7f1f6-4d0a-4f61-9a3e-1f0a9e0c2d11',
  name: 'Before the walls',
  description: '',
  branch: 'main',
  rev: 4,
  createdAt: '2026-10-04T12:00:00.000Z',
};
const branch = {
  id: '6a1f9c2e-0d4b-4b5e-8f3a-2c1d0e9f8a7b',
  name: 'Taller',
  fromVersion: version.id,
  createdAt: '2026-10-04T12:01:00.000Z',
};

describe('server version and branch records', () => {
  it('accept what the app makes', () => {
    expect(ServerVersionSchema.parse(version)).toEqual(version);
    expect(ServerBranchSchema.parse(branch)).toEqual(branch);
    expect(CreateVersionSchema.safeParse({ version }).success).toBe(true);
    expect(CreateBranchSchema.safeParse({ branch }).success).toBe(true);
  });

  it.each([
    ['an extra field', { ...version, extra: 1 }],
    ['an id with a slash', { ...version, id: 'a/b' }],
    ['an empty name', { ...version, name: '' }],
    ['a padded name', { ...version, name: ' x ' }],
    ['a long name', { ...version, name: 'x'.repeat(201) }],
    ['a long description', { ...version, description: 'x'.repeat(2001) }],
    ['a negative revision', { ...version, rev: -1 }],
    ['a fractional revision', { ...version, rev: 1.5 }],
    ['a date that is not one', { ...version, createdAt: 'yesterday' }],
    ['a branch id that is not one', { ...version, branch: '../x' }],
  ])('refuse a version with %s', (_what, v) => {
    expect(ServerVersionSchema.safeParse(v).success).toBe(false);
  });

  it('refuse a record for the main branch', () => {
    expect(ServerBranchSchema.safeParse({ ...branch, id: 'main' }).success).toBe(false);
  });

  it('tell a resend from a conflict', () => {
    expect(sameRecord(version, { ...version })).toBe(true);
    expect(sameRecord(version, { ...version, rev: 5 })).toBe(false);
    expect(sameRecord(branch, { ...branch, name: 'Other' })).toBe(false);
  });
});
