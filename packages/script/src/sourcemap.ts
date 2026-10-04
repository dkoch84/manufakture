// Mapping positions in erased TypeScript back to the source the user wrote. Sucrase keeps every
// line where it was but deletes type annotations rather than blanking them, so columns after an
// annotation move left (`const x: number = 1` becomes `const x = 1`). Its source map has one
// segment per token, which is all a position lookup needs; this decoder reads only that.

/** A 1-based line and column, as editors and QuickJS backtraces count them. */
export interface SourcePosition {
  line: number;
  column: number;
}

/** One mapping segment: generated column to source line and column, all 0-based. */
interface Segment {
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** Decodes a source map `mappings` string into segments per generated line. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let generatedColumn = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let i = 0;
  const readVlq = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const digit = DIGIT.get(mappings[i++] ?? '');
      if (digit === undefined) throw new Error('bad source map');
      result += (digit & 31) << shift;
      if ((digit & 32) === 0) break;
      shift += 5;
    }
    return result & 1 ? -(result >>> 1) : result >>> 1;
  };
  while (i <= mappings.length) {
    const c = mappings[i];
    if (c === undefined || c === ';') {
      lines.push(line);
      line = [];
      generatedColumn = 0;
      i++;
      if (c === undefined) break;
      continue;
    }
    if (c === ',') {
      i++;
      continue;
    }
    generatedColumn += readVlq();
    const next = mappings[i];
    if (next === undefined || next === ',' || next === ';') continue; // a segment with no source
    readVlq(); // source index: sucrase maps one file
    sourceLine += readVlq();
    sourceColumn += readVlq();
    const after = mappings[i];
    if (after !== undefined && after !== ',' && after !== ';') readVlq(); // name index
    line.push({ generatedColumn, sourceLine, sourceColumn });
  }
  return lines;
}

/** Looks up positions in generated code. */
export class PositionMap {
  private readonly lines: Segment[][];

  constructor(mappings: string) {
    this.lines = decodeMappings(mappings);
  }

  /**
   * The source position of a generated position: the nearest segment at or before the column on
   * that line, plus the distance into it (a token keeps its length). A position with no segment
   * on its line keeps its column; sucrase keeps lines, so the line is always right.
   */
  toSource(position: SourcePosition): SourcePosition {
    const segments = this.lines[position.line - 1] ?? [];
    const column = position.column - 1;
    let best: Segment | undefined;
    for (const s of segments) {
      if (s.generatedColumn > column) break;
      best = s;
    }
    if (best === undefined) return position;
    return {
      line: best.sourceLine + 1,
      column: best.sourceColumn + (column - best.generatedColumn) + 1,
    };
  }
}
