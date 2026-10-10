import { createDocument } from '@manufakture/core';
import { DISCLAIMER_SHORT, MECH_NAMESPACE } from '@manufakture/domain-mech';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDocumentStore } from '../state/document';
import { parseFactor, parseFactors } from './factors';
import { MechToolbar } from './MechStart';

function setup() {
  const documents = createDocumentStore(createDocument({ id: 'd', name: 'Machine' }));
  render(<MechToolbar documents={documents} disabled={false} />);
  return documents;
}

describe('the mechanical first-run prompt', () => {
  it('asks for both factors, prefills neither, shows the notice and starts the domain', () => {
    const documents = setup();
    expect(documents.getState().document.domains).toBeUndefined();
    fireEvent.click(screen.getByTestId('mech-open'));
    expect(screen.getByTestId('mech-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    expect((screen.getByTestId('mech-factor-strength') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('mech-factor-fatigue') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('mech-factor-strength'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('mech-start-save'));
    expect(screen.queryByTestId('mech-start-dialog')).toBeNull();
    expect(documents.getState().document.domains?.[MECH_NAMESPACE]).toEqual({
      schemaVersion: 1,
      data: { factors: { strength: 2 } },
    });
    // It is one undo step.
    documents.getState().undo();
    expect(documents.getState().document.domains).toBeUndefined();
  });

  it('starts with no factor at all when both are left empty, and edits them later', () => {
    const documents = setup();
    fireEvent.click(screen.getByTestId('mech-open'));
    fireEvent.click(screen.getByTestId('mech-start-save'));
    expect(documents.getState().document.domains?.[MECH_NAMESPACE]?.data).toEqual({ factors: {} });
    fireEvent.click(screen.getByTestId('mech-open'));
    expect(screen.getByRole('heading').textContent).toBe('Safety factors');
    fireEvent.change(screen.getByTestId('mech-factor-fatigue'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('mech-start-save'));
    expect(documents.getState().document.domains?.[MECH_NAMESPACE]?.data).toEqual({
      factors: { fatigue: 1.5 },
    });
  });

  it('refuses a factor that is not a positive number, and keeps the dialog open', () => {
    const documents = setup();
    fireEvent.click(screen.getByTestId('mech-open'));
    fireEvent.change(screen.getByTestId('mech-factor-strength'), { target: { value: 'two' } });
    fireEvent.click(screen.getByTestId('mech-start-save'));
    expect(screen.getByTestId('mech-start-error').textContent).toMatch(/not a number/);
    expect(documents.getState().document.domains).toBeUndefined();
    fireEvent.click(screen.getByTestId('mech-start-cancel'));
    expect(screen.queryByTestId('mech-start-dialog')).toBeNull();
  });
});

describe('factor fields', () => {
  it('read empty as not set and refuse what is not a factor', () => {
    expect(parseFactor('')).toEqual({ ok: true, value: undefined });
    expect(parseFactor(' 2.5 ')).toEqual({ ok: true, value: 2.5 });
    expect(parseFactor('0').ok).toBe(false);
    expect(parseFactor('-1').ok).toBe(false);
    expect(parseFactor('1e3').ok).toBe(false);
    expect(parseFactor('1000').ok).toBe(false);
    expect(parseFactors('2', '')).toEqual({ ok: true, value: { strength: 2 } });
    expect(parseFactors('2', 'x')).toMatchObject({ ok: false, field: 'fatigue' });
  });
});
