import { describe, expect, it } from 'vitest';
import { decodeStepString, isStep, sniffFormat, stepProductNames } from './step';
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
