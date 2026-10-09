import { err, ok, type Result } from './result';

export type TokenKind =
  | 'number'
  | 'ident'
  /** `#name`; `text` holds the name without the `#`. */
  | 'variable'
  | 'op'
  | '('
  | ')'
  | ','
  /** `'` or `′` */
  | 'foot-mark'
  /** `"` or `″` */
  | 'inch-mark'
  /** `°` */
  | 'degree-mark'
  /** `:`, between the rise and the run of a roof pitch */
  | ':'
  /** `%`, after a percent slope */
  | '%'
  /**
   * A quoted face name, `"extrude#1:cap:end"`: a `"` that starts an argument (right after `(` or
   * `,`) opens one, where it could never be an inch mark. `text` holds what is between the quotes.
   */
  | 'string'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /**
   * For `op` the normalised operator (`+ - * / ^`); for `variable` the bare name; for `string`
   * the text between the quotes.
   */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const LETTER = /[A-Za-z]/;
const WHITESPACE = /\s/;

const SINGLE_CHAR: Readonly<Record<string, { kind: TokenKind; text: string }>> = {
  '+': { kind: 'op', text: '+' },
  '-': { kind: 'op', text: '-' },
  '−': { kind: 'op', text: '-' }, // unicode minus sign
  '*': { kind: 'op', text: '*' },
  '×': { kind: 'op', text: '*' }, // multiplication sign
  '/': { kind: 'op', text: '/' },
  '^': { kind: 'op', text: '^' },
  '(': { kind: '(', text: '(' },
  ')': { kind: ')', text: ')' },
  ',': { kind: ',', text: ',' },
  "'": { kind: 'foot-mark', text: "'" },
  '′': { kind: 'foot-mark', text: "'" }, // prime
  '"': { kind: 'inch-mark', text: '"' },
  '″': { kind: 'inch-mark', text: '"' }, // double prime
  '°': { kind: 'degree-mark', text: '°' },
  ':': { kind: ':', text: ':' },
  '%': { kind: '%', text: '%' },
};

function isDigit(c: string | undefined): boolean {
  return c !== undefined && DIGIT.test(c);
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && LETTER.test(c);
}

function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && IDENT_PART.test(c);
}

/** Splits `source` into tokens. The last token is always `eof`. */
export function tokenize(source: string): Result<Token[]> {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (WHITESPACE.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      while (isDigit(source[i])) i++;
      if (source[i] === '.') {
        i++;
        while (isDigit(source[i])) i++;
      }
      // Exponent only when it is unambiguously one, so `2e` still reads as number + unit "e".
      if (source[i] === 'e' || source[i] === 'E') {
        const sign = source[i + 1] === '+' || source[i + 1] === '-' ? 1 : 0;
        if (isDigit(source[i + 1 + sign])) {
          i += 1 + sign;
          while (isDigit(source[i])) i++;
        }
      }
      tokens.push({ kind: 'number', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (IDENT_START.test(c)) {
      // A name glued to a number is a unit suffix and stops at the first non-letter, so that
      // `3ft4in` splits into 3 ft 4 in.
      const previous = tokens[tokens.length - 1];
      const unitSuffix = previous?.kind === 'number' && previous.end === start;
      while (unitSuffix ? isLetter(source[i]) : isIdentPart(source[i])) i++;
      tokens.push({ kind: 'ident', text: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === '#') {
      i++;
      if (!IDENT_START.test(source.charAt(i))) {
        return err('syntax', "Expected a variable name after '#'", start, start + 1);
      }
      while (isIdentPart(source[i])) i++;
      tokens.push({ kind: 'variable', text: source.slice(start + 1, i), start, end: i });
      continue;
    }
    const previous = tokens[tokens.length - 1];
    if (c === '"' && (previous?.kind === '(' || previous?.kind === ',')) {
      const close = source.indexOf('"', i + 1);
      if (close < 0) return err('syntax', 'Missing closing quote', start, start + 1);
      tokens.push({ kind: 'string', text: source.slice(i + 1, close), start, end: close + 1 });
      i = close + 1;
      continue;
    }
    const single = SINGLE_CHAR[c];
    if (single !== undefined) {
      tokens.push({ kind: single.kind, text: single.text, start, end: i + 1 });
      i++;
      continue;
    }
    const codePoint = source.codePointAt(i) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    return err(
      'syntax',
      `Unexpected character '${source.slice(i, i + width)}'`,
      start,
      start + width,
    );
  }
  tokens.push({ kind: 'eof', text: '', start: source.length, end: source.length });
  return ok(tokens);
}
