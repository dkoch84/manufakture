// The construction panels of the drawing workspace (M6 plan T6.4b): the New construction set form
// hands over what the user chose, and a construction view's strings list Hide, Show and Convert.

import type { Command, DrawingView } from '@manufakture/core';
import type { DrawingViewResult } from '@manufakture/regen';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { newDrawingCommand } from '../../drawing/model';
import { PART, constructionDocument, run } from '../construction.test-fixture';
import { ConstructionSetPanel, ConstructionStrings } from './ConstructionDrawingPanels';
import { canMakeSet, type SetOptions } from './set';

const view: DrawingView = {
  id: 'view#1',
  source: {
    domain: 'construction',
    part: PART,
    schemaVersion: 1,
    params: { kind: 'plan', level: 'level-1', hide: ['extension#1:s1:centres'] } as never,
  },
  direction: 'top',
  scale: {
    paper: { source: '1/4', lengthUnit: 'in', angleUnit: 'deg' },
    model: { source: '12', lengthUnit: 'in', angleUnit: 'deg' },
  },
  position: [100, 100],
  options: { hidden: false, smooth: false },
};

describe('construction drawing panels', () => {
  it('the set form offers feet-and-inch scales and hands over the choices', () => {
    const doc = constructionDocument();
    expect(canMakeSet(doc)).toBe(false);
    const onCreate = vi.fn<(o: SetOptions) => void>();
    render(
      <ConstructionSetPanel doc={doc} error="no walls" onCreate={onCreate} onClose={() => {}} />,
    );
    expect(screen.getByTestId('construction-set-error').textContent).toBe('no walls');
    expect(screen.getByTestId('construction-set-disclaimer').textContent).toMatch(
      /^Not an engineering tool/,
    );
    const scale = screen.getByTestId('construction-set-framing-scale') as HTMLSelectElement;
    expect([...scale.options].map((o) => o.value)).toContain(`1/4" = 1'`);
    fireEvent.change(scale, { target: { value: `1/2" = 1'` } });
    fireEvent.click(screen.getByTestId('construction-set-create'));
    // No part studio has walls, so there is no part to draw.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("a view's strings: hide, convert, and show a hidden one", () => {
    let doc = constructionDocument();
    const c = newDrawingCommand(doc, 'Set', { size: 'A3', orientation: 'landscape', title: null });
    doc = run(doc, c.command);
    doc = run(doc, { type: 'addView', drawingId: c.drawingId, sheetId: c.sheetId, view });
    const drawing = doc.drawings![0]!;
    const sheet = drawing.sheets[0]!;
    const ran: string[] = [];
    const runCommand = (_c: Command, label: string) => {
      ran.push(label);
      return true;
    };
    const result = {
      viewId: 'view#1',
      scale: { paper: 1, model: 48 },
      pick: null,
      chains: [
        {
          id: 'view#1/extension#1:s1:overall',
          view: 'view#1',
          kind: 'aligned',
          points: [
            [0, 0],
            [100, 0],
          ],
          offset: -10,
        },
      ],
    } as unknown as DrawingViewResult;
    render(
      <ConstructionStrings
        doc={doc}
        drawing={drawing}
        sheet={sheet}
        view={sheet.views[0]!}
        result={result}
        readOnly={false}
        run={runCommand}
      />,
    );
    expect(screen.getByTestId('construction-string-extension#1:s1:overall').textContent).toMatch(
      /^extension#1, segment 1, overall/,
    );
    fireEvent.click(screen.getByTestId('construction-string-hide-extension#1:s1:overall'));
    fireEvent.click(screen.getByTestId('construction-string-show-extension#1:s1:centres'));
    expect(ran).toEqual([
      'Hide extension#1:s1:overall in view#1',
      'Show extension#1:s1:centres in view#1',
    ]);
    // No layer bodies in the result: the conversion says so instead of running.
    fireEvent.click(screen.getByTestId('construction-string-convert-extension#1:s1:overall'));
    expect(screen.getByTestId('construction-strings-error').textContent).toMatch(
      /no layer bodies to measure from/,
    );
    expect(ran).toHaveLength(2);
  });
});
