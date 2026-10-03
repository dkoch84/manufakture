import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../../model/model';
import { createDocumentStore } from '../../state/document';
import { createSelectionStore } from '../../state/selection';
import { createMemberStore } from '../../viewport/memberStore';
import { ConstructionPanel } from '../ConstructionPanel';
import { FT_IN, constructionDocument, settingsOf } from '../construction.test-fixture';
import { createConstructionUiStore } from '../state';
import { EMPTY_RULE, framingFormOf, framingOf, headerRulesOf, lengthList } from './framing';

function setup() {
  const documents = createDocumentStore(constructionDocument());
  const ui = createConstructionUiStore();
  render(
    <ConstructionPanel
      documents={documents}
      model={createModelStore()}
      members={createMemberStore()}
      selection={createSelectionStore()}
      ui={ui}
      partId="part#1"
    />,
  );
  return { documents };
}

const change = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('framing settings', () => {
  it('reads lists of constant lengths, bounded', () => {
    const r = lengthList(`8', 10'; 12'`, FT_IN);
    expect(r.ok && r.value.map((e) => e.source)).toEqual([`8'`, `10'`, `12'`]);
    expect(lengthList(Array(21).fill(`8'`).join(','), FT_IN)).toEqual({
      ok: false,
      message: 'At most 20 lengths.',
    });
    expect(lengthList('x'.repeat(5000), FT_IN).ok).toBe(false);
    expect(lengthList('#h', FT_IN)).toEqual({
      ok: false,
      message: '#h: Settings take a length, not a variable.',
    });
  });

  it('turns the form into framing defaults and back', () => {
    const form = {
      ...framingFormOf({}),
      spacing: '24"',
      topPlates: '1' as const,
      blocking: 'heights' as const,
      heights: `4', 6'`,
      plateStockLengths: `8', 12'`,
    };
    const r = framingOf(form, FT_IN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      spacing: { source: '24"' },
      topPlates: 1,
      blocking: { kind: 'heights', heights: [{ source: `4'` }, { source: `6'` }] },
    });
    expect(framingFormOf(r.value)).toEqual(form);
    expect(framingOf({ ...form, spacing: '1"' }, FT_IN)).toMatchObject({
      ok: false,
      errors: { spacing: 'Must be at least 50 mm.' },
    });
  });

  it('refuses header rules that are incomplete or for the same width', () => {
    expect(headerRulesOf([{ ...EMPTY_RULE }], FT_IN)).toEqual({
      ok: false,
      errors: {
        '0.maxWidth': 'Enter a length.',
        '0.stock': 'Choose the header stock.',
        '0.plies': 'Choose how many plies.',
        '0.jacks': 'Choose how many jack studs.',
      },
    });
    const rule = { maxWidth: `4'`, stock: 'us-2x8', plies: '2', jacks: '1' };
    expect(headerRulesOf([rule, { ...rule, maxWidth: '48"' }], FT_IN)).toMatchObject({
      ok: false,
      errors: { '1.maxWidth': 'Rule 1 is for the same width.' },
    });
  });

  it('saves the framing defaults as one step', () => {
    const t = setup();
    change('framing-spacing', '24"');
    change('field-framing-corners', 'three-stud');
    fireEvent.click(screen.getByTestId('framing-save'));
    expect(settingsOf(t.documents.getState().document).stored.framing).toEqual({
      spacing: { source: '24"', lengthUnit: 'in', angleUnit: 'deg' },
      cornerStyle: 'three-stud',
    });
    expect(t.documents.getState().undoLabel).toBe('Set the framing defaults');
  });

  it('starts with no header rules, and keeps the rules the user enters', () => {
    const t = setup();
    expect(screen.getByTestId('header-rules-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('header-rule-add'));
    // A new row has nothing filled in.
    const row = within(screen.getByTestId('header-rule-1'));
    expect((row.getByTestId('header-rule-width-1') as HTMLInputElement).value).toBe('');
    expect((row.getByTestId('field-header-rule-1-header-plies') as HTMLSelectElement).value).toBe(
      '',
    );
    change('header-rule-width-1', `4'`);
    change('header-rule-1-header-stock', 'us-2x8');
    change('field-header-rule-1-header-plies', '2');
    change('field-header-rule-1-header-jacks', '1');
    fireEvent.click(screen.getByTestId('header-rules-save'));
    const rules = settingsOf(t.documents.getState().document).stored.headerRules;
    expect(rules).toEqual([
      {
        maxWidth: { source: `4'`, lengthUnit: 'in', angleUnit: 'deg' },
        header: { stock: 'us-2x8', plies: 2, jacks: 1 },
      },
    ]);
    // Removed again: back to none.
    fireEvent.click(screen.getByTestId('header-rule-remove-1'));
    fireEvent.click(screen.getByTestId('header-rules-save'));
    expect(settingsOf(t.documents.getState().document).stored.headerRules).toEqual([]);
    act(() => void t.documents.getState().undo());
    expect(settingsOf(t.documents.getState().document).stored.headerRules).toHaveLength(1);
  });
});
