// Number and comment formatting for G-code (M5 plan, T5.4a; ADR 0014 decision 10). Numbers are
// written in fixed notation with a fixed number of decimals and never with an exponent; comments
// are parenthesised printable ASCII with nothing a controller could read as a command.

/**
 * The most digits a number may have. Grbl's `read_float` keeps the first eight digits of a number
 * (`MAX_INT_DIGITS`) and silently drops the rest, so a longer number would be read as a different
 * value. Leading zeros count, as they do in Grbl.
 */
export const MAX_NUMBER_DIGITS = 8;

/** The largest number of decimals a dialect may ask for. */
export const MAX_DECIMALS = 6;

/**
 * `value` rounded to `decimals` places in fixed notation, trailing zeros and a trailing point
 * removed, `-0` written as `0`: `12.5`, `-0.25`, `100`. Undefined for a value that is not finite or
 * that would need more than `MAX_NUMBER_DIGITS` digits.
 */
export function formatNumber(value: number, decimals: number): string | undefined {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return undefined;
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (text === '-0') text = '0';
  const digits = text.replace(/[^0-9]/g, '').length;
  if (digits > MAX_NUMBER_DIGITS || /e/i.test(text)) return undefined;
  return text;
}

/** The value Grbl 1.1 reads from `text` (`nuts_bolts.c` `read_float`), in single precision. */
export function grblReadFloat(text: string): number {
  const f = Math.fround;
  let i = 0;
  let negative = false;
  if (text[i] === '-') {
    negative = true;
    i++;
  } else if (text[i] === '+') {
    i++;
  }
  let intval = 0;
  let exp = 0;
  let ndigit = 0;
  let decimal = false;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i) - 48;
    if (c >= 0 && c <= 9) {
      ndigit++;
      if (ndigit <= MAX_NUMBER_DIGITS) {
        if (decimal) exp--;
        intval = intval * 10 + c; // below 1e8, exact in a double as in Grbl's uint32
      } else if (!decimal) {
        exp++;
      }
    } else if (text[i] === '.' && !decimal) {
      decimal = true;
    } else {
      break;
    }
  }
  let value = f(intval);
  if (value !== 0) {
    while (exp <= -2) {
      value = f(value * f(0.01));
      exp += 2;
    }
    if (exp < 0) value = f(value * f(0.1));
    else
      while (exp > 0) {
        value = f(value * 10);
        exp--;
      }
  }
  return negative ? -value : value;
}

/**
 * Characters a comment may keep. Everything else is dropped after transliteration. Grbl picks its
 * real-time commands out of the serial stream wherever they appear, comments included: `?`
 * (status), `!` (feed hold), `~` (cycle start) and bytes from 0x80. Those are never written. `;`
 * starts a comment on some controllers and `%` delimits a program on others, so neither is kept.
 */
const COMMENT_KEEP = /[A-Za-z0-9 .,:\-_/+=*#'"[\]<>@&]/;

/**
 * Comment text made safe: accents removed (`é` to `e`), parentheses turned into brackets (no
 * nesting), every character outside a small printable ASCII set dropped, runs of white space
 * collapsed. The result never holds `(`, `)`, `;`, `%`, `?`, `!`, `~` or a non-ASCII byte.
 */
export function sanitizeComment(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKD')) {
    if (ch === '(') out += '[';
    else if (ch === ')') out += ']';
    else if (/\s/.test(ch)) out += ' ';
    else if (COMMENT_KEEP.test(ch)) out += ch;
  }
  return out.replace(/ +/g, ' ').trim();
}

/**
 * Comment keywords controllers act on (LinuxCNC, Mach3 and their kin): `(MSG,...)` shows a
 * message, `(DEBUG,...)` and `(PRINT,...)` print, `(LOGOPEN,file)` and `(PROBEOPEN file)` open
 * files on the controller, `(ABORT,...)` stops, `(py,...)` runs Python. Matched case-insensitively
 * as a prefix, so `LOGAPPEND` and `PROBECLOSE` are covered too.
 */
const COMMENT_KEYWORD = /^(?:msg|debug|print|log|probe|abort|py)/i;

/**
 * True when a comment's text could be read as a controller command: it starts with one of the
 * keywords above, or with a word directly followed by a comma (the shape of every such command).
 */
export function isCommentCommand(text: string): boolean {
  const t = text.trimStart();
  return COMMENT_KEYWORD.test(t) || /^[A-Za-z0-9_]+\s*,/.test(t);
}

/**
 * `text` sanitised and wrapped into parenthesised comment lines of at most `maxLength`
 * characters, breaking at spaces where it can. A line that could be read as a controller command
 * (`isCommentCommand`), the first or any continuation, is written with a leading `_`. An empty
 * comment gives no lines.
 */
export function commentLines(text: string, maxLength: number): string[] {
  const clean = sanitizeComment(text);
  if (clean === '') return [];
  // Room for the parentheses and a possible `_`.
  const width = Math.max(1, maxLength - 3);
  const lines: string[] = [];
  let rest = clean;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') lines.push(rest);
  return lines.map((l) => (isCommentCommand(l) ? `(_${l})` : `(${l})`));
}
