import { createDocument } from '@manufakture/core';
import { memberInstances, boxMesh, type MemberData } from '@manufakture/regen';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { createSelectionStore, geometryRef } from '../state/selection';
import { MemberInfo } from './MemberInfo';
import { shedFixture } from './memberFixtures';
import { memberRef } from './members';
import { createMemberStore } from './memberStore';

function setup() {
  const selection = createSelectionStore();
  const members = createMemberStore();
  const documents = createDocumentStore(createDocument({ id: 'doc', name: 'Shed' }));
  act(() => {
    documents.getState().execute({
      type: 'setDisplayUnits',
      units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
    });
  });
  const shed = shedFixture();
  members.getState().load(shed.partId, shed.view);
  render(<MemberInfo selection={selection} members={members} documents={documents} />);
  return { selection, members };
}

describe('MemberInfo', () => {
  it('shows nothing until a member is selected, and never for a face', () => {
    const t = setup();
    expect(screen.queryByTestId('member-info')).toBeNull();
    act(() => t.selection.getState().click(geometryRef('face', 'b', 'f1'), 'replace'));
    expect(screen.queryByTestId('member-info')).toBeNull();
  });

  it("shows a picked stud's stock, length and cuts in the document's units", () => {
    const t = setup();
    act(() => t.selection.getState().click(memberRef('wall-s:s1'), 'replace'));
    expect(screen.getByRole('heading').textContent).toBe('Stud');
    expect(screen.getByTestId('member-info-id').textContent).toBe('wall-s:s1');
    expect(screen.getByTestId('member-info-stock').textContent).toBe('2x4 (1-1/2" x 3-1/2")');
    expect(screen.getByTestId('member-info-length').textContent).toBe(`7' 8-5/8"`);
    expect(screen.getByTestId('member-info-cuts').textContent).toBe('None (square ends)');
    // The last member selected is the one shown.
    act(() => t.selection.getState().click(memberRef('door-1:header:1'), 'add'));
    expect(screen.getByRole('heading').textContent).toBe('Header');
    expect(screen.getByTestId('member-info-stock').textContent).toMatch(/^2x8 /);
  });

  it('lists cuts', () => {
    const t = setup();
    const rafter: MemberData = {
      id: 'r1',
      owner: 'roof#1',
      role: 'common-rafter',
      stock: { id: 'us-2x6', name: '2x6', width: 38.1, depth: 139.7 },
      length: 2000,
      placement: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] },
      cuts: [
        { kind: 'plane', n: [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)], k: 1900 },
        { kind: 'notch', a: { n: [-1, 0, 0], k: -300 }, b: { n: [0, 0, -1], k: -40 } },
      ],
    };
    const instances = memberInstances([rafter]);
    act(() => {
      t.members.getState().load('roof', {
        meshes: new Map([[instances[0]!.shape, boxMesh(2000, 38.1, 139.7)]]),
        sets: [
          {
            group: 'roof#1',
            namespace: 'construction',
            features: ['roof#1'],
            members: [rafter],
            instances,
          },
        ],
      });
      t.selection.getState().click(memberRef('roof#1:r1'), 'replace');
    });
    const items = [...screen.getByTestId('member-info-cuts').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^End cut, 30(\.0+)?° off square$/);
    expect(items[1]).toBe('Notch (birdsmouth)');
  });
});
