import type { BinaryOperator, Expression } from './ast';
import { DIMENSIONLESS, divideDimensions, type Dimension } from './dimension';
import { tokenize, type Token } from './lexer';
import { err, ok, type Result } from './result';
import {
  DEGREE_UNIT,
  FOOT_UNIT,
  INCH_UNIT,
  MINUTE_UNIT,
  MM_PER_INCH,
  lookupWordUnit,
  type UnitDefinition,
} from './units';

/** Names that are constants when written bare. `#pi` still refers to a variable called `pi`. */
const CONSTANTS: ReadonlyMap<string, number> = new Map([['pi', Math.PI]]);

/** Names of the built-in constants. */
export const CONSTANT_NAMES: readonly string[] = [...CONSTANTS.keys()];

const INTEGER = /^[0-9]+$/;

/** Most levels of parentheses, signs, calls and powers that may nest inside each other. */
export const MAX_NESTING = 256;

/**
 * Most levels the whole syntax tree may have, counting each chained operator (`a + b + c` is
 * two levels). Keeps parsing, evaluation and reference collection off the stack limit.
 */
export const MAX_TREE_DEPTH = 1024;

interface Magnitude {
  readonly value: number;
  /** Index of the first token after the magnitude. */
  readonly next: number;
}

interface UnitMatch {
  readonly unit: UnitDefinition;
  readonly token: Token;
}

class ParseFailure {
  constructor(readonly result: Result<never>) {}
}

function describeToken(token: Token): string {
  return token.kind === 'variable' ? `#${token.text}` : token.text;
}

/**
 * Recursive-descent parser. Grammar (lowest to highest precedence):
 *
 *   expression := slope (('+' | '-') slope)*
 *   slope      := term (':' term | '%')?           -- a pitch or a percent slope, never chained
 *   term       := unary (('*' | '/') unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := primary ('^' unary)?            -- right-associative, `2^-1` allowed
 *   primary    := measure | '(' expression ')' unit? | variable | name '(' args ')' | name
 *
 * `measure` is a number literal with its optional unit, fraction, mixed number, feet-inches
 * tail and per-time suffix (`mm/min`, `/min`); a bare `min` not followed by '(' is also a
 * measure (one minute). The rules are documented in the package README.
 */
class Parser {
  private pos = 0;
  private nesting = 0;
  private readonly depths = new WeakMap<Expression, number>();

  constructor(
    private readonly tokens: readonly Token[],
    private readonly text: string,
  ) {}

  private source(node: Expression): string {
    return this.text.slice(node.start, node.end);
  }

  private tok(i: number): Token {
    // The token list always ends with `eof`; clamp so look-ahead past it stays on `eof`.
    return this.tokens[Math.min(i, this.tokens.length - 1)] as Token;
  }

  private cur(): Token {
    return this.tok(this.pos);
  }

  private fail(
    code: 'syntax' | 'unknown-unit' | 'domain',
    message: string,
    start: number,
    end: number,
  ): never {
    throw new ParseFailure(err(code, message, start, end));
  }

  /** Error for a token that cannot appear where it is. */
  private unexpected(token: Token): never {
    const prev = this.pos > 0 ? this.tok(this.pos - 1) : undefined;
    if (token.kind === 'eof') {
      if (prev === undefined) this.fail('syntax', 'Enter a value', 0, 0);
      this.fail('syntax', `Expected a value after '${prev.text}'`, prev.start, prev.end);
    }
    if (token.kind === ')') {
      if (prev !== undefined && (prev.kind === '(' || prev.kind === ',' || prev.kind === 'op')) {
        this.fail('syntax', "Expected a value before ')'", token.start, token.end);
      }
      this.fail('syntax', "Unmatched ')'", token.start, token.end);
    }
    if (token.kind === 'ident' && prev?.kind === 'number' && prev.end === token.start) {
      if (token.text === 'min' && this.tok(this.pos + 1).kind === '(') {
        // `5min(3)`: `min` is both a unit and a function, and a name followed by '(' is always a
        // call, so this is not "5 minutes".
        this.fail(
          'syntax',
          `Missing operator: write '${prev.text}*${token.text}(…)' to call ${token.text}(), or '${prev.text}${token.text}' alone for the unit`,
          token.start,
          token.end,
        );
      }
      const hint = CONSTANTS.has(token.text)
        ? `; write '${prev.text}*${token.text}' to multiply`
        : '';
      this.fail('unknown-unit', `Unknown unit '${token.text}'${hint}`, token.start, token.end);
    }
    const startsValue =
      token.kind === 'number' ||
      token.kind === 'ident' ||
      token.kind === 'variable' ||
      token.kind === '(';
    if (startsValue && prev !== undefined && prev.kind !== 'op' && prev.kind !== '(') {
      this.fail(
        'syntax',
        `Missing operator before '${describeToken(token)}'`,
        token.start,
        token.end,
      );
    }
    this.fail('syntax', `Unexpected '${describeToken(token)}'`, token.start, token.end);
  }

  parseAll(): Expression {
    if (this.cur().kind === 'eof') this.unexpected(this.cur());
    const expr = this.parseExpression();
    if (this.cur().kind !== 'eof') this.unexpected(this.cur());
    return expr;
  }

  /** Records the depth of a new node, failing when the tree gets too deep. */
  private node<T extends Expression>(node: T, ...children: Expression[]): T {
    let depth = 1;
    for (const child of children) depth = Math.max(depth, (this.depths.get(child) ?? 1) + 1);
    if (depth > MAX_TREE_DEPTH) {
      this.fail(
        'syntax',
        `Expression is too complex (more than ${MAX_TREE_DEPTH} levels)`,
        node.start,
        node.end,
      );
    }
    this.depths.set(node, depth);
    return node;
  }

  private isOp(token: Token, ...ops: string[]): boolean {
    return token.kind === 'op' && ops.includes(token.text);
  }

  private parseExpression(): Expression {
    let left = this.parseSlope();
    while (this.isOp(this.cur(), '+', '-')) {
      const op = this.cur().text as BinaryOperator;
      this.pos++;
      const right = this.parseSlope();
      left = this.node(
        { type: 'binary', op, left, right, start: left.start, end: right.end },
        left,
        right,
      );
    }
    return left;
  }

  /**
   * A roof pitch `rise:run` or a percent slope `term%`. Both bind looser than `*`, `/` and `^`
   * and tighter than `+` and `-`, so `#rise*2:12` is `(#rise*2):12` and `2*12.5%` is `25%`.
   * Neither chains or combines with the other: `1:2:3`, `6:12%` and `25%:4` are errors.
   */
  private parseSlope(): Expression {
    const left = this.parseTerm();
    const token = this.cur();
    let slope: Expression;
    if (token.kind === ':') {
      this.pos++;
      const run = this.parseTerm();
      slope = this.node(
        { type: 'pitch', rise: left, run, start: left.start, end: run.end },
        left,
        run,
      );
    } else if (token.kind === '%') {
      this.pos++;
      slope = this.node(
        { type: 'percent', operand: left, start: left.start, end: token.end },
        left,
      );
    } else {
      return left;
    }
    const next = this.cur();
    if (next.kind === ':') {
      this.fail(
        'syntax',
        slope.type === 'pitch'
          ? 'A pitch has one colon: write rise:run'
          : 'Write a slope as a percent or as rise:run, not both',
        next.start,
        next.end,
      );
    }
    if (next.kind === '%') {
      this.fail(
        'syntax',
        slope.type === 'pitch'
          ? 'Write a slope as rise:run or as a percent, not both'
          : "Unexpected '%'",
        next.start,
        next.end,
      );
    }
    if (slope.type === 'percent' && this.isOp(next, '*', '/', '^')) {
      const percent = this.source(slope);
      this.fail(
        'syntax',
        `A percent applies to everything before it up to '+' or '-': write (${percent})${next.text}…`,
        next.start,
        next.end,
      );
    }
    return slope;
  }

  private parseTerm(): Expression {
    let left = this.parseUnary();
    while (this.isOp(this.cur(), '*', '/')) {
      const op = this.cur().text as BinaryOperator;
      this.pos++;
      const right = this.parseUnary();
      left = this.node(
        { type: 'binary', op, left, right, start: left.start, end: right.end },
        left,
        right,
      );
    }
    return left;
  }

  /** Every nested construct passes through here, so this is where nesting is limited. */
  private parseUnary(): Expression {
    const token = this.cur();
    if (this.nesting >= MAX_NESTING) {
      this.fail(
        'syntax',
        `Expression is nested too deeply (more than ${MAX_NESTING} levels)`,
        token.start,
        token.end,
      );
    }
    this.nesting++;
    try {
      if (this.isOp(token, '-', '+')) {
        this.pos++;
        const operand = this.parseUnary();
        const op = token.text === '-' ? '-' : '+';
        return this.node(
          { type: 'unary', op, operand, start: token.start, end: operand.end },
          operand,
        );
      }
      return this.parsePower();
    } finally {
      this.nesting--;
    }
  }

  private parsePower(): Expression {
    const base = this.parsePrimary();
    if (!this.isOp(this.cur(), '^')) return base;
    this.pos++;
    const exponent = this.parseUnary();
    return this.node(
      {
        type: 'binary',
        op: '^',
        left: base,
        right: exponent,
        start: base.start,
        end: exponent.end,
      },
      base,
      exponent,
    );
  }

  private parsePrimary(): Expression {
    const token = this.cur();
    switch (token.kind) {
      case 'number':
        return this.parseMeasure();
      case '(':
        return this.parseParenthesised();
      case 'variable':
        this.pos++;
        return {
          type: 'variable',
          name: token.text,
          hashed: true,
          start: token.start,
          end: token.end,
        };
      case 'ident': {
        this.pos++;
        if (this.cur().kind === '(') return this.parseCall(token);
        // `min` cannot be a variable (it is a function), so on its own it is the minute:
        // `1000 mm / min`. Only lowercase: `MIN` is a valid variable name.
        if (token.text === 'min') {
          return {
            type: 'measure',
            value: MINUTE_UNIT.factor,
            dimension: MINUTE_UNIT.dimension,
            start: token.start,
            end: token.end,
          };
        }
        const constant = CONSTANTS.get(token.text);
        if (constant !== undefined) {
          return { type: 'number', value: constant, start: token.start, end: token.end };
        }
        return {
          type: 'variable',
          name: token.text,
          hashed: false,
          start: token.start,
          end: token.end,
        };
      }
      default:
        return this.unexpected(token);
    }
  }

  private parseParenthesised(): Expression {
    const open = this.cur();
    this.pos++;
    const inner = this.parseExpression();
    if (this.cur().kind !== ')') {
      if (this.cur().kind === 'eof') {
        this.fail('syntax', 'Missing closing parenthesis', open.start, open.end);
      }
      this.unexpected(this.cur());
    }
    const close = this.cur();
    this.pos++;
    const unit = this.unitAt(this.pos);
    if (unit === undefined) {
      const widened = { ...inner, start: open.start, end: close.end };
      this.depths.set(widened, this.depths.get(inner) ?? 1);
      return widened;
    }
    this.pos++;
    let applied = unit.unit;
    let end = unit.token.end;
    const perTime = this.perTimeAt(this.pos);
    if (perTime !== undefined) {
      applied = {
        symbol: `${applied.symbol}/${perTime.unit.symbol}`,
        factor: applied.factor / perTime.unit.factor,
        dimension: divideDimensions(applied.dimension, perTime.unit.dimension),
        role: 'other',
      };
      end = perTime.token.end;
      this.pos += 2;
    }
    return this.node(
      { type: 'unit', operand: inner, unit: applied, start: open.start, end },
      inner,
    );
  }

  private parseCall(name: Token): Expression {
    const open = this.cur();
    this.pos++;
    const args: Expression[] = [];
    if (this.cur().kind !== ')') {
      for (;;) {
        args.push(this.parseExpression());
        if (this.cur().kind === ',') {
          this.pos++;
          continue;
        }
        if (this.cur().kind === ')') break;
        if (this.cur().kind === 'eof') {
          this.fail('syntax', 'Missing closing parenthesis', open.start, open.end);
        }
        this.unexpected(this.cur());
      }
    }
    const close = this.cur();
    this.pos++;
    return this.node(
      { type: 'call', name: name.text, nameEnd: name.end, args, start: name.start, end: close.end },
      ...args,
    );
  }

  // --- number literals -------------------------------------------------------------------------

  private unitAt(i: number): UnitMatch | undefined {
    const token = this.tok(i);
    switch (token.kind) {
      case 'foot-mark':
        return { unit: FOOT_UNIT, token };
      case 'inch-mark':
        return { unit: INCH_UNIT, token };
      case 'degree-mark':
        return { unit: DEGREE_UNIT, token };
      case 'ident': {
        // `2 m(3)` is not "2 metres"; a name followed by '(' is always a call.
        if (this.tok(i + 1).kind === '(') return undefined;
        const unit = lookupWordUnit(token.text);
        return unit === undefined ? undefined : { unit, token };
      }
      default:
        return undefined;
    }
  }

  /**
   * A per-minute suffix starting at token `i`: `/` glued to the token before it, then a lowercase
   * `min` glued to the slash and not followed by `(` (`mm/min`, `12000/min`). Only `min`
   * qualifies, because it is the only time unit that cannot be a variable name: `100mm/s` and
   * `100mm/MIN` keep dividing by variables called `s` and `MIN`.
   */
  private perTimeAt(i: number): UnitMatch | undefined {
    const slash = this.tok(i);
    const name = this.tok(i + 1);
    if (!this.isOp(slash, '/') || slash.start !== this.tok(i - 1).end) return undefined;
    if (name.kind !== 'ident' || name.start !== slash.end || name.text !== 'min') return undefined;
    if (this.tok(i + 2).kind === '(') return undefined;
    return { unit: MINUTE_UNIT, token: name };
  }

  /** Whether a unit or a per-time suffix starts at token `i`, which makes a fraction a literal. */
  private hasUnitAt(i: number): boolean {
    return this.unitAt(i) !== undefined || this.perTimeAt(i) !== undefined;
  }

  private isInteger(i: number): boolean {
    const token = this.tok(i);
    return token.kind === 'number' && INTEGER.test(token.text);
  }

  /** `INT/INT` with no whitespace around the slash, starting at token `i`. */
  private fractionAt(i: number): Magnitude | undefined {
    const numerator = this.tok(i);
    const slash = this.tok(i + 1);
    const denominator = this.tok(i + 2);
    if (
      this.isInteger(i) &&
      this.isOp(slash, '/') &&
      slash.start === numerator.end &&
      this.isInteger(i + 2) &&
      denominator.start === slash.end &&
      Number(denominator.text) !== 0 // leave `1/0"` to the evaluator's division-by-zero error
    ) {
      return { value: Number(numerator.text) / Number(denominator.text), next: i + 3 };
    }
    return undefined;
  }

  /**
   * A number, `INT/INT` fraction or mixed number (`4 1/2`, `4-1/2`) starting at token `i`.
   * Outside an inches context a fraction needs a unit after it, otherwise it is ordinary
   * division, and a hyphenated mixed number without a unit is rejected as ambiguous.
   */
  private magnitudeAt(i: number, inchContext: boolean): Magnitude {
    const whole = this.tok(i);
    if (this.isInteger(i)) {
      const sep = this.tok(i + 1);
      let fractionStart = -1;
      let hyphen = false;
      if (sep.kind === 'number' && sep.start > whole.end) {
        fractionStart = i + 1;
      } else if (
        this.isOp(sep, '-') &&
        sep.start === whole.end &&
        this.tok(i + 2).start === sep.end
      ) {
        fractionStart = i + 2;
        hyphen = true;
      }
      if (fractionStart >= 0) {
        const fraction = this.fractionAt(fractionStart);
        if (fraction !== undefined) {
          if (hyphen && !inchContext && !this.hasUnitAt(fraction.next)) {
            const numerator = this.tok(fractionStart).text;
            const denominator = this.tok(fractionStart + 2).text;
            const w = whole.text;
            this.fail(
              'syntax',
              `Ambiguous: write '${w} ${numerator}/${denominator}', '${w}-${numerator}/${denominator}"' or '${w} - ${numerator}/${denominator}'`,
              whole.start,
              this.tok(fraction.next - 1).end,
            );
          }
          return { value: Number(whole.text) + fraction.value, next: fraction.next };
        }
      }
      const fraction = this.fractionAt(i);
      if (fraction !== undefined && (inchContext || this.hasUnitAt(fraction.next))) return fraction;
    }
    return { value: Number(whole.text), next: i + 1 };
  }

  /** Inches after a foot unit: `3' 4"`, `3'4`, `3'-4-1/2"`, `3ft 4.5in`. Value in inches. */
  private inchTailAt(i: number): Magnitude | undefined {
    const prev = this.tok(i - 1);
    const token = this.tok(i);
    let numberIndex: number;
    if (token.kind === 'number') {
      numberIndex = i;
    } else if (
      this.isOp(token, '-') &&
      token.start === prev.end &&
      this.tok(i + 1).kind === 'number' &&
      this.tok(i + 1).start === token.end
    ) {
      numberIndex = i + 1;
    } else {
      return undefined;
    }
    const magnitude = this.magnitudeAt(numberIndex, true);
    const unit = this.unitAt(magnitude.next);
    if (unit === undefined) return magnitude;
    if (unit.unit.role === 'inch') return { value: magnitude.value, next: magnitude.next + 1 };
    return undefined;
  }

  private parseMeasure(): Expression {
    const first = this.cur();
    const magnitude = this.magnitudeAt(this.pos, false);
    let next = magnitude.next;
    const unit = this.unitAt(next);
    const perTime = unit === undefined ? this.perTimeAt(next) : undefined;
    if (perTime !== undefined) {
      // `12000/min`: a bare number per time.
      return this.finishMeasure(
        first,
        magnitude.value / perTime.unit.factor,
        divideDimensions(DIMENSIONLESS, perTime.unit.dimension),
        next + 2,
      );
    }
    if (unit === undefined) {
      if (!Number.isFinite(magnitude.value)) {
        this.fail('domain', 'Number is too large', first.start, this.tok(next - 1).end);
      }
      this.pos = next;
      return {
        type: 'number',
        value: magnitude.value,
        start: first.start,
        end: this.tok(next - 1).end,
      };
    }
    next++;
    let value = magnitude.value * unit.unit.factor;
    if (unit.unit.role === 'foot') {
      const tail = this.inchTailAt(next);
      if (tail !== undefined) {
        value += tail.value * MM_PER_INCH;
        next = tail.next;
      }
    }
    let dimension = unit.unit.dimension;
    const per = this.perTimeAt(next);
    if (per !== undefined) {
      value /= per.unit.factor;
      dimension = divideDimensions(dimension, per.unit.dimension);
      next += 2;
    }
    return this.finishMeasure(first, value, dimension, next);
  }

  /** A measure literal from token `first` up to (not including) token `next`. */
  private finishMeasure(first: Token, value: number, dimension: Dimension, next: number) {
    if (!Number.isFinite(value)) {
      this.fail('domain', 'Number is too large', first.start, this.tok(next - 1).end);
    }
    this.pos = next;
    return {
      type: 'measure',
      value,
      dimension,
      start: first.start,
      end: this.tok(next - 1).end,
    } as const;
  }
}

/**
 * Parses an expression into an AST without evaluating it. Parsing needs no context: bare numbers
 * stay dimensionless and variables stay unresolved.
 */
export function parseExpression(source: string): Result<Expression> {
  const tokens = tokenize(source);
  if (!tokens.ok) return tokens;
  try {
    return ok(new Parser(tokens.value, source).parseAll());
  } catch (e) {
    if (e instanceof ParseFailure) return e.result;
    throw e;
  }
}
