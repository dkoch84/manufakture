import { unzlibSync } from 'fflate';
import { getDocument, OPS, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { displayListToSheet, drawingToPdf } from './drawing-export';
import { HELVETICA_CAP_HEIGHT, helveticaTextWidth, winAnsiBytes } from './helvetica';
import { polylinePath, type Sheet2 } from './path2';
import { POINTS_PER_MM, contentStream, pdfTextString, writePdf } from './pdf';
import { PLATE_SHEET, SHAPES_SHEET, bracketSheet } from './sheet-test-helpers';

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdfjs takes ownership of (and detaches) the buffer it is given.
  return getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Every xref entry points at its `n 0 obj`, and startxref at the table. */
function checkXref(bytes: Uint8Array): number {
  const text = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 5)).toBe('xref\n');
  const m = /^xref\n0 (\d+)\n/.exec(text.slice(startxref))!;
  const count = Number(m[1]);
  const table = text.slice(startxref + m[0].length, startxref + m[0].length + 20 * count);
  expect(table.slice(0, 20)).toBe('0000000000 65535 f \n');
  for (let k = 1; k < count; k++) {
    const entry = table.slice(20 * k, 20 * k + 20);
    expect(entry).toMatch(/^\d{10} 00000 n \n$/);
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${k} 0 obj\n`.length)).toBe(`${k} 0 obj\n`);
  }
  expect(text).toContain(`trailer\n<< /Size ${count} /Root 1 0 R /Info 4 0 R >>`);
  // Stream lengths match their data.
  for (const s of text.matchAll(/\/Length (\d+)[^>]*>>\nstream\n/g)) {
    const start = s.index + s[0].length;
    expect(text.slice(start + Number(s[1]), start + Number(s[1]) + 10)).toBe('\nendstream');
  }
  return count;
}

const pathCount = (sheet: Sheet2) => sheet.items.filter((i) => i.kind === 'path').length;

async function pageFacts(doc: PDFDocumentProxy, n: number) {
  const page = await doc.getPage(n);
  const ops = await page.getOperatorList();
  const text = await page.getTextContent();
  const items = text.items.filter((t) => 'str' in t && t.str.trim() !== '') as {
    str: string;
    width: number;
    transform: number[];
  }[];
  return {
    view: page.view,
    paths: ops.fnArray.filter((f) => f === OPS.constructPath).length,
    texts: items,
  };
}

describe('writePdf', () => {
  it('writes the bracket drawing: A3 in points, title block text, one path per stroke', async () => {
    const sheet = displayListToSheet(bracketSheet());
    const bytes = drawingToPdf(bracketSheet(), { title: 'M1 bracket' });
    checkXref(bytes);
    expect(latin1(bytes.subarray(0, 9))).toBe('%PDF-1.4\n');
    const doc = await open(bytes);
    expect(doc.numPages).toBe(1);
    expect((await doc.getMetadata()).info).toMatchObject({
      Title: 'M1 bracket',
      Producer: 'manufakture',
    });
    const facts = await pageFacts(doc, 1);
    expect(facts.view.map((v) => Number(v.toFixed(3)))).toEqual([0, 0, 1190.551, 841.89]);
    // Written to 1e-4 pt.
    expect(facts.view[2]).toBeCloseTo(420 * POINTS_PER_MM, 3);
    expect(facts.paths).toBe(pathCount(sheet));
    const strings = facts.texts.map((t) => t.str);
    expect(strings).toEqual(
      expect.arrayContaining([
        'M1 bracket',
        'MK-0001',
        'DRAWING NO.',
        'THIRD ANGLE',
        '2x Ø8 CBORE',
      ]),
    );
  });

  it('places text by Helvetica widths: anchors, baselines, rotation', async () => {
    const sheet = displayListToSheet(SHAPES_SHEET);
    const doc = await open(writePdf(sheet));
    const facts = await pageFacts(doc, 1);
    expect(facts.paths).toBe(pathCount(sheet));
    const k = POINTS_PER_MM;
    const byText = Object.fromEntries(facts.texts.map((t) => [t.str, t]));
    for (const item of sheet.items) {
      if (item.kind !== 'text') continue;
      const t = byText[item.text]!;
      const size = item.height / HELVETICA_CAP_HEIGHT;
      // pdfjs measures with its own Helvetica metrics: the same widths as ours.
      expect(t.width / k).toBeCloseTo(helveticaTextWidth(item.text, size), 3);
      const [a, b, , , x, y] = t.transform;
      expect(Math.atan2(b!, a!)).toBeCloseTo(item.rotation, 6);
      expect(Math.hypot(a!, b!) / k).toBeCloseTo(size, 3);
      // The anchor point, measured back along the text direction.
      const frac = item.anchor === 'middle' ? 0.5 : item.anchor === 'end' ? 1 : 0;
      const drop =
        item.baseline === 'top' ? item.height : item.baseline === 'middle' ? item.height / 2 : 0;
      const [c, s] = [Math.cos(item.rotation), Math.sin(item.rotation)];
      const w = t.width / k;
      expect(x! / k + frac * w * c - drop * s).toBeCloseTo(item.at[0], 3);
      expect(y! / k + frac * w * s + drop * c).toBeCloseTo(item.at[1], 3);
    }
  });

  it('writes several sheets as pages of their own sizes', async () => {
    const bytes = drawingToPdf([bracketSheet(), SHAPES_SHEET]);
    expect(checkXref(bytes)).toBe(5 + 2 * 2);
    const doc = await open(bytes);
    expect(doc.numPages).toBe(2);
    const [a, b] = [await doc.getPage(1), await doc.getPage(2)];
    expect(a.view[2]! / POINTS_PER_MM).toBeCloseTo(420, 4);
    expect(b.view.slice(2).map((v) => v / POINTS_PER_MM)).toEqual([
      expect.closeTo(210, 4),
      expect.closeTo(297, 4),
    ]);
  });

  it('pages a sheet without a size by its bounds, in its colour', async () => {
    const bytes = writePdf(PLATE_SHEET, { compress: false });
    const text = latin1(bytes);
    expect(text).toContain('/MediaBox [0 0 170.0787 113.3858]');
    expect(text).toContain('1 0 0 RG 1 0 0 rg');
    const doc = await open(bytes);
    expect((await pageFacts(doc, 1)).paths).toBe(2);
  });

  it('deflates content streams by default, to the same operators', () => {
    const plain = latin1(writePdf(PLATE_SHEET, { compress: false }));
    const packed = writePdf(PLATE_SHEET);
    const text = latin1(packed);
    const m = /\/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/.exec(text)!;
    const start = m.index + m[0].length;
    const ops = latin1(unzlibSync(packed.subarray(start, start + Number(m[1]))));
    expect(plain).toContain(ops);
    checkXref(packed);
  });

  it('is deterministic unless given a creation date', () => {
    const a = writePdf(PLATE_SHEET);
    expect(writePdf(PLATE_SHEET)).toEqual(a);
    const dated = latin1(
      writePdf(PLATE_SHEET, { creationDate: new Date(Date.UTC(2026, 9, 2, 1, 2, 3)) }),
    );
    expect(dated).toContain('/CreationDate (D:20261002010203Z)');
    expect(() => writePdf([])).toThrow();
  });
});

describe('PDF layer state', () => {
  it('clamps negative dash entries, and an all-zero pattern is continuous', () => {
    const sheet: Sheet2 = {
      size: { width: 20, height: 20 },
      layers: [
        { name: 'a', dash: [-2, 1], color: 'red' },
        { name: 'b', dash: [-2, -1] },
      ],
      items: [
        polylinePath('a', [
          [0, 0],
          [10, 10],
        ]),
        polylinePath('b', [
          [0, 10],
          [10, 0],
        ]),
      ],
    };
    const ops = contentStream(sheet);
    expect(ops).toContain('[0 1] 0 d\n0 J\n0 0 0 RG 0 0 0 rg');
    expect(ops).toContain('[] 0 d\n1 J');
    expect(ops).not.toMatch(/\[[^\]]*-/);
  });
});

describe('PDF text', () => {
  it('encodes WinAnsi and escapes strings', () => {
    expect(winAnsiBytes('AØ°\u2014\u4e00\t')).toEqual([0x41, 0xd8, 0xb0, 0x97, 0x3f, 0x20]);
    expect(pdfTextString('a(b)\\')).toBe('(a\\(b\\)\\\\)');
    expect(pdfTextString('Ø')).toBe('<FEFF00D8>');
  });
});
