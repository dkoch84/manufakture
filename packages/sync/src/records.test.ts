import { describe, expect, it } from 'vitest';
import {
  CreateBranchSchema,
  CreateVersionSchema,
  ServerBranchSchema,
  ServerVersionSchema,
  ProvenanceSchema,
  ReviewChangeSchema,
  sameBranch,
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
    expect(sameBranch(branch, { ...branch, name: 'Other' })).toBe(false);
    expect(sameBranch(branch, { ...branch })).toBe(true);
  });
});

describe('agent branch provenance (T8.4b)', () => {
  const provenance = {
    origin: 'agent',
    sessionId: 'c0ffee00-1111-4222-8333-444455556666',
    clientName: 'Claude Code',
    review: 'open',
  };

  it('rides on a branch record, comment included', () => {
    const agent = { ...branch, provenance: { ...provenance, comment: 'Wider.\nThanks' } };
    expect(ServerBranchSchema.parse(agent)).toEqual(agent);
    expect(CreateBranchSchema.safeParse({ branch: agent, commentFrom: branch.id }).success).toBe(
      true,
    );
  });

  it.each([
    ['another origin', { ...provenance, origin: 'person' }],
    ['an unknown review state', { ...provenance, review: 'merged' }],
    ['a session id that is a path', { ...provenance, sessionId: '../x' }],
    ['an empty client name', { ...provenance, clientName: '' }],
    ['a padded client name', { ...provenance, clientName: ' x' }],
    ['a bidi override in the client name', { ...provenance, clientName: 'Claude\u202e' }],
    ['a lone surrogate in the client name', { ...provenance, clientName: 'C\ud800' }],
    ['a long client name', { ...provenance, clientName: 'x'.repeat(201) }],
    ['a comment with a control character', { ...provenance, comment: 'a\u0007' }],
    ['a blank comment', { ...provenance, comment: '  ' }],
    ['a long comment', { ...provenance, comment: 'x'.repeat(4001) }],
    ['an extra field', { ...provenance, extra: 1 }],
  ])('refuses %s', (_what, p) => {
    expect(ProvenanceSchema.safeParse(p).success).toBe(false);
    expect(ServerBranchSchema.safeParse({ ...branch, provenance: p }).success).toBe(false);
  });

  it('a resend keeps its origin: a person cannot become an agent, nor the reverse', () => {
    const agent = { ...branch, provenance: provenance as never };
    expect(sameBranch(agent, { ...agent })).toBe(true);
    // The review state may have moved since: still a resend.
    expect(
      sameBranch(agent, { ...agent, provenance: { ...provenance, review: 'submitted' } as never }),
    ).toBe(true);
    expect(sameBranch(agent, branch)).toBe(false);
    expect(sameBranch(branch, agent)).toBe(false);
    expect(
      sameBranch(agent, { ...agent, provenance: { ...provenance, sessionId: 'other' } as never }),
    ).toBe(false);
  });

  it('checks review changes', () => {
    expect(ReviewChangeSchema.safeParse({ review: 'submitted', expected: 'open' }).success).toBe(
      true,
    );
    expect(
      ReviewChangeSchema.safeParse({ review: 'open', expected: ['submitted', 'changes-requested'] })
        .success,
    ).toBe(true);
    expect(ReviewChangeSchema.safeParse({ review: 'approved', comment: null }).success).toBe(true);
    expect(ReviewChangeSchema.safeParse({ review: 'merged' }).success).toBe(false);
    expect(ReviewChangeSchema.safeParse({ review: 'open', comment: '\u202e' }).success).toBe(false);
    expect(ReviewChangeSchema.safeParse({ review: 'open', by: 'agent' }).success).toBe(false);
  });
});
