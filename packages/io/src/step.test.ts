import { describe, expect, it } from 'vitest';
import {
  MAX_STEP_FILE_BYTES,
  checkStepFile,
  decodeStepString,
  isStep,
  sniffFormat,
  stepProductNames,
} from './step';
import { writeBinaryStl } from './stl';
import { write3mf } from './threemf';
import { boxMesh } from './test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('STEP text', () => {
  it('reads product names in file order, decoding STEP strings', () => {
    const file = enc(
      "ISO-10303-21;\nDATA;\n#7 = PRODUCT('Bracket','Bracket','',(#8));\n" +
        "#25 = PRODUCT ( 'It''s \\X2\\00E400F6\\X0\\','x','',(#26));\n" +
        "#30 = PRODUCT_DEFINITION('design','',#31,#32);\nENDSEC;\n",
    );
    expect(stepProductNames(file)).toEqual(['Bracket', "It's äö"]);
    expect(decodeStepString('\\X\\E9t\\X\\E9')).toBe('été');
    expect(decodeStepString('a\\\\b')).toBe('a\\b');
  });

  it('recognises STEP, STL and 3MF by content', () => {
    expect(isStep(enc('  ISO-10303-21;\nHEADER;'))).toBe(true);
    expect(isStep(enc('solid x'))).toBe(false);
    expect(sniffFormat(enc('ISO-10303-21;'), 'x.stl')).toBe('step');
    expect(sniffFormat(writeBinaryStl(boxMesh()), 'part.bin')).toBe('stl');
    expect(sniffFormat(enc('solid a\nfacet normal 0 0 1\n'), 'a.txt')).toBe('stl');
    expect(sniffFormat(write3mf([{ name: 'a', mesh: boxMesh() }]))).toBe('3mf');
    expect(sniffFormat(enc('hello'), 'hello.txt')).toBeNull();
  });
});

describe('checking an untrusted STEP file', () => {
  const good =
    "ISO-10303-21;\nHEADER;\nFILE_NAME('x');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n";

  it('accepts a well-formed file', () => {
    expect(checkStepFile(enc(good))).toEqual({ ok: true });
  });

  it('refuses empty, oversized and foreign files', () => {
    expect(checkStepFile(new Uint8Array())).toMatchObject({ ok: false, line: 1 });
    expect(checkStepFile(enc(good), 10)).toMatchObject({ ok: false, message: /at most 10/ });
    expect(MAX_STEP_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(checkStepFile(enc('<html>'))).toMatchObject({ ok: false, message: /not a STEP/ });
  });

  it('names the line of a NUL byte, a missing section or a missing end', () => {
    const nul = enc(good.replace('#1=', '#1=\u0000'));
    expect(checkStepFile(nul)).toMatchObject({ ok: false, line: 6, message: /NUL/ });
    expect(checkStepFile(enc(good.replace('HEADER;', 'HEAD;')))).toMatchObject({
      ok: false,
      message: /HEADER/,
    });
    expect(checkStepFile(enc(good.replace('DATA;', 'DATUM;')))).toMatchObject({
      ok: false,
      line: 2,
      message: /DATA/,
    });
    expect(checkStepFile(enc(good.replace('END-ISO-10303-21;', '')))).toMatchObject({
      ok: false,
      message: /END-ISO/,
    });
  });

  it('checks a large file in one pass', () => {
    const body = "#1=CARTESIAN_POINT('',(0.,0.,0.));\n".repeat(200_000);
    const big = enc(good.replace('DATA;\n', `DATA;\n${body}`));
    const t = performance.now();
    expect(checkStepFile(big).ok).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
