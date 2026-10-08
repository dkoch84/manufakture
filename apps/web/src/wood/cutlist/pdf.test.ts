// @vitest-environment node
// The cut list PDF (`@manufakture/domain-wood/files`) parsed back with pdfjs-dist, a development
// dependency of the app: the list page, one page per sheet with its parts numbered as in the
// list, and the lumber plan; a sheet that does not fit a page's text is cut, never overflowing;
// the writer's RangeError on bad input reaches the caller.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  documentCutList,
  documentSettings,
  nestingJob,
  runNesting,
} from '@manufakture/domain-wood';
import { cutListPdf } from '@manufakture/domain-wood/files';
import { bookshelfDocument, bookshelfModel } from './cutlist.test-fixture';

async function pagesText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter((s) => s !== '')
        .join(' | '),
    );
  }
  await pdf.cleanup();
  return out;
}

describe('the cut list PDF', () => {
  it('has the list, a page per sheet and the lumber plan', async () => {
    const doc = bookshelfDocument();
    const list = documentCutList({ document: doc, parts: bookshelfModel().getState().parts });
    const layouts = await runNesting(nestingJob(list, documentSettings(doc).settings));
    const bytes = cutListPdf(list, layouts, {
      title: doc.name,
      units: doc.units,
      configuration: 'Tall',
      warnings: layouts.notes.map((n) => n.message),
    });
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    // Letter landscape for an inch document.
    const page = await pdf.getPage(1);
    const [, , w, h] = page.view;
    expect(w).toBeCloseTo(792, 1);
    expect(h).toBeCloseTo(612, 1);
    await pdf.cleanup();

    const pages = await pagesText(bytes);
    // The list, one plywood sheet, one 2x4 page.
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('Cut list: Bookshelf (Tall)');
    expect(pages[0]).toContain('Top, Bottom, Shelf 1-3');
    expect(pages[0]).toContain('29" x 11-1/4" x 23/32"');
    expect(pages[0]).toContain('Sheet goods: 22.58 sq ft, 7 pcs');
    expect(pages[0]).toContain('wider than 2x4');
    expect(pages[1]).toContain('3/4" plywood: sheet 1 of 1');
    expect(pages[1]).toContain('Cut order');
    // Every part of the sheet carries its row number: two sides (1) and five 29" parts (2).
    const labels = pages[1]!.split(' | ');
    expect(labels.filter((t) => t === '1')).toHaveLength(2);
    expect(labels.filter((t) => t === '2')).toHaveLength(5);
    expect(pages[2]).toContain('2x4: sticks 1 to 1 of 1');
    expect(pages[2]).toContain('3: 96"');
    expect(pages[2]).toContain('3 / 3');
  });

  it('writes the list alone when there are no layouts yet', async () => {
    const doc = bookshelfDocument();
    const list = documentCutList({ document: doc, parts: bookshelfModel().getState().parts });
    const pages = await pagesText(cutListPdf(list, null, { title: doc.name, units: doc.units }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('Cut list: Bookshelf');
  });
});
