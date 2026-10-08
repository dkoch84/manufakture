// @vitest-environment node
// The takeoff PDF (`@manufakture/domain-construction/files`, M6 plan T6.3b) parsed back with
// pdfjs-dist, a development dependency of the app: the shed's rows to buy and its cost are there
// as text, and the short disclaimer opens the first page and closes every page.

import {
  DISCLAIMER_SHORT,
  constructionTakeoff,
  displayRows,
  documentConstruction,
  subtotalLines,
  takeoffModel,
} from '@manufakture/domain-construction';
import { takeoffPdf, wrap } from '@manufakture/domain-construction/files';
import {
  PART,
  PRICES,
  shedDocument,
  shedFeatures,
  shedSets,
} from '@manufakture/domain-construction/fixtures/shed-model';
import { readStockData, type Json } from '@manufakture/stock';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

async function pagesText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  await pdf.cleanup();
  return out;
}

function shed() {
  const doc = shedDocument({ prices: true });
  const data = documentConstruction(doc);
  if (!data.ok) throw new Error(data.message);
  const stock = readStockData(PRICES as unknown as Json, 1);
  if (!stock.ok) throw new Error(stock.message);
  const model = takeoffModel({
    document: doc,
    partId: PART,
    features: shedFeatures(),
    sets: shedSets(),
    settings: data.data?.settings,
    stock: stock.value,
  });
  const takeoff = constructionTakeoff(model.input);
  return { doc, takeoff, rows: displayRows(takeoff, doc.units), settings: data.data?.settings };
}

describe('the takeoff PDF', () => {
  it('has the rows to buy, the cost and the disclaimer on every page', async () => {
    const { doc, takeoff, rows, settings } = shed();
    const bytes = takeoffPdf(takeoff, rows, {
      title: doc.name,
      units: doc.units,
      subtotals: subtotalLines(takeoff, doc, PART, settings),
    });
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    // Letter landscape for a feet-and-inches document.
    const [, , w, h] = (await pdf.getPage(1)).view;
    expect(w).toBeCloseTo(792, 1);
    expect(h).toBeCloseTo(612, 1);
    await pdf.cleanup();

    const pages = await pagesText(bytes);
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.join(' ');
    expect(pages[0]).toMatch(/^Takeoff: Shed /);
    expect(pages[0]!.startsWith(`Takeoff: Shed ${DISCLAIMER_SHORT}`)).toBe(true);
    for (const page of pages) expect(page).toContain(DISCLAIMER_SHORT);
    for (const section of [
      'As framed',
      'Linear length',
      'Sheet layers as laid',
      'Lumber to buy',
      'Sheets to buy',
    ]) {
      expect(all).toContain(section);
    }
    // The 2x4 sticks, the precuts and the sheets, with their cost.
    expect(all).toMatch(/2x4 2x4 16' 0" 13 13 pcs \$156\.00 cut into 37 members/);
    expect(all).toMatch(/7' 8-5\/8" 51 51 pcs \$229\.50 cut into 51 members; precut stud/);
    expect(all).toMatch(/7\/16" OSB 7\/16" OSB 8' 0" x 4' 0" 25 25 sheets \$400\.00/);
    expect(all).toContain('Level Level 1: ');
    expect(all).toContain('Cost of what to buy: $1,708.90');
    expect(all).not.toMatch(/estimate|rule of thumb/i);
  });

  it('wraps text to a width, never splitting a word', () => {
    const lines = wrap(DISCLAIMER_SHORT, 2.6, 80);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe(DISCLAIMER_SHORT);
  });
});
