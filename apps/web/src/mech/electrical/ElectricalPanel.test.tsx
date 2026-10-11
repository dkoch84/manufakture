import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { DISCLAIMER_SHORT, builtinRef, templateCommand } from '@manufakture/domain-mech';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../../state/document';
import { ElectricalPanel, MechElectricalButton } from './ElectricalPanel';

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** An assembly with a battery tray at the origin and a controller mount 500 mm away. */
function design(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Trainer' },
    ...(
      [
        ['inst#1', 'Battery tray', [0, 0, 0]],
        ['inst#2', 'Controller mount', [300, 400, 0]],
      ] as const
    ).map(([id, name, t]): Command => ({
      type: 'addInstance',
      assemblyId: 'assembly#1',
      instance: {
        id,
        name,
        source: { part: 'part#1' },
        fixed: true,
        suppressed: false,
        pose: { translation: [...t], rotation: [0, 0, 0, 1] },
      },
    })),
  );
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

function setup(doc = design()) {
  const documents = createDocumentStore(doc);
  render(<ElectricalPanel documents={documents} onClose={() => {}} />);
  return { documents };
}

const WORDS = /\b(safe|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*)\b/i;

describe('the electrical panel', () => {
  it('opens from the toolbar with the notice and counts the problems', () => {
    const documents = createDocumentStore(design());
    render(<MechElectricalButton documents={documents} disabled={false} />);
    expect(screen.getByTestId('el-open').textContent).toBe('Electrical');
    fireEvent.click(screen.getByTestId('el-open'));
    expect(screen.getByTestId('el-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    type('el-add-role', 'fuse');
    fireEvent.click(screen.getByTestId('el-add-component'));
    fireEvent.click(screen.getByTestId('el-save'));
    // A fuse with both terminals unconnected: two problems.
    expect(screen.getByTestId('el-open').textContent).toBe('Electrical (2)');
    fireEvent.click(screen.getByTestId('el-close'));
    expect(screen.queryByTestId('el-panel')).toBeNull();
  });

  it('builds a pack, a fuse and a connection, then lists what is not connected', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('el-add-component'));
    type('el-add-role', 'fuse');
    fireEvent.click(screen.getByTestId('el-add-component'));
    fireEvent.click(screen.getByTestId('el-add-connection'));
    type('el-connection-fromComponent-0', 'el#1');
    type('el-connection-fromTerminal-0', '+');
    type('el-connection-toComponent-0', 'el#2');
    type('el-connection-toTerminal-0', '1');
    type('el-connection-colour-0', 'red');
    fireEvent.click(screen.getByTestId('el-save'));
    expect(screen.getByTestId('el-message').textContent).toBe('Saved the electrical system.');
    expect(documents.getState().document.mech!.electrical).toEqual({
      components: [
        { id: 'el#1', name: 'Battery pack', role: 'pack' },
        { id: 'el#2', name: 'Fuse', role: 'fuse' },
      ],
      connections: [
        {
          id: 'conn#1',
          from: { component: 'el#1', terminal: '+' },
          to: { component: 'el#2', terminal: '1' },
          colour: 'red',
        },
      ],
      harness: [],
    });
    const warnings = screen.getByTestId('el-warnings').textContent ?? '';
    expect(warnings).toMatch(/terminal - \(-\) of Battery pack \(el#1\) is not connected/);
    expect(warnings).toMatch(/terminal 2 \(2\) of Fuse \(el#2\) is not connected/);
    // Nothing on the far side of the fuse draws current yet.
    expect(screen.getByTestId('el-current-value-conn#1').textContent).toBe(
      'not known: nothing beyond it draws current',
    );
    // An undo puts the draft back in step with the document.
    act(() => documents.getState().undo());
    expect(documents.getState().document.mech?.electrical).toBeUndefined();
    expect(screen.queryByTestId('el-component-0')).toBeNull();
  });

  it('measures a segment between instances and adds the slack', () => {
    const { documents } = setup();
    type('el-assembly', 'assembly#1');
    fireEvent.click(screen.getByTestId('el-add-component'));
    type('el-component-instance-0', 'inst#1');
    fireEvent.click(screen.getByTestId('el-add-segment'));
    type('el-segment-from-0', 'component:el#1');
    type('el-segment-to-0', 'instance:inst#2');
    type('el-segment-slack-0', '50 mm');
    fireEvent.click(screen.getByTestId('el-save'));
    expect(documents.getState().document.mech!.electrical!.harness[0]).toMatchObject({
      id: 'seg#1',
      from: { component: 'el#1' },
      to: { instance: 'inst#2' },
      length: { measured: true, slack: { source: '50 mm' } },
    });
    const text = screen.getByTestId('el-length-seg#1').textContent ?? '';
    expect(text).toMatch(/^550\.00 mm \(500\.00 mm straight \+ 50\.00 mm slack\)$/);
  });

  it('refuses terminals it cannot read and a value that does not read', () => {
    const { documents } = setup();
    type('el-add-role', 'board');
    fireEvent.click(screen.getByTestId('el-add-component'));
    type('el-component-terminals-0', 'vin volts');
    fireEvent.click(screen.getByTestId('el-save'));
    expect(screen.getByTestId('el-problems').textContent).toMatch(/"volts" is not a terminal kind/);
    type('el-component-terminals-0', 'vin power, gnd ground, sda signal');
    type('el-component-current-0', '5 V');
    fireEvent.click(screen.getByTestId('el-save'));
    expect(screen.getByTestId('el-problems').textContent).toMatch(/load\.current/);
    expect(documents.getState().document.mech?.electrical).toBeUndefined();
    type('el-component-current-0', '80 mA');
    fireEvent.click(screen.getByTestId('el-save'));
    expect(documents.getState().document.mech!.electrical!.components[0]!.terminals).toEqual([
      { id: 'vin', name: 'VIN', kind: 'power' },
      { id: 'gnd', name: 'GND', kind: 'ground' },
      { id: 'sda', name: 'sda', kind: 'signal' },
    ]);
  });

  it('adds the cable trainer’s system with every connection on a current path', () => {
    let doc = design();
    const req = templateCommand(doc, 'cable-trainer');
    if (!req.ok) throw new Error(req.message);
    doc = apply(doc, req.command);
    const { documents } = setup(doc);
    fireEvent.click(screen.getByTestId('el-template'));
    const e = documents.getState().document.mech!.electrical!;
    expect(e.components).toHaveLength(14);
    expect(e.connections).toHaveLength(31);
    expect(screen.queryByTestId('el-warnings')).toBeNull();
    const rows = screen.getByTestId('el-currents').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(31);
    for (const row of rows) expect(row.textContent).not.toMatch(/not known: (it|nothing|one|no )/);
    // The main lead waits for the simulation; the board's supply is its typed load.
    expect(screen.getByTestId('el-current-value-conn#1').textContent).toMatch(
      /not known \(electrical\/el#6\/bus-current: no simulation of lc#\d+ has run\)/,
    );
    expect(screen.getByTestId('el-current-value-conn#18').textContent).toBe(
      '0.08 A (always-on loads)',
    );
    expect(screen.getByTestId('el-current-value-conn#26').textContent).toBe('negligible (signal)');
    expect(screen.getByTestId('el-results').textContent).not.toMatch(WORDS);
    // One undo step takes it all away.
    act(() => documents.getState().undo());
    expect(documents.getState().document.mech!.electrical).toBeUndefined();
  });

  it('notes typed loads, and asks before the template drops unsaved edits', () => {
    const { documents } = setup();
    fireEvent.click(screen.getByTestId('el-add-component'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      fireEvent.click(screen.getByTestId('el-template'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(documents.getState().document.mech?.electrical).toBeUndefined();
      expect(screen.getByTestId('el-component-0')).toBeTruthy();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByTestId('el-template'));
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(documents.getState().document.mech!.electrical!.components).toHaveLength(14);
      // The fresh draft has no edits: the template again does not ask.
      fireEvent.click(screen.getByTestId('el-template'));
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally {
      confirm.mockRestore();
    }
    // The DC-DC converter (component 10) has a typed load, marked as one to check.
    expect(screen.getByTestId('el-component-load-note-9').textContent).toMatch(/estimates/);
    expect(screen.queryByTestId('el-component-load-note-0')).toBeNull();
  });

  it('shows a part that does not fit the role as such, not as missing', () => {
    const doc = apply(
      design(),
      {
        type: 'setPurchasedUse',
        use: { id: 'pp#1', entry: builtinRef('motor/odrive-d5065-270kv')!, alternates: [] },
      },
      {
        type: 'setElectrical',
        electrical: {
          components: [{ id: 'el#1', name: 'Fuse', role: 'fuse', use: 'pp#1' }],
          connections: [],
          harness: [],
        },
      },
    );
    setup(doc);
    const select = screen.getByTestId('el-component-use-0') as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toMatch(/\(pp#1\) \(does not fit the role\)$/);
    expect(screen.getByTestId('el-warnings').textContent).toMatch(
      /pp#1 is a motor, which a fuse does not use/,
    );
  });
});
