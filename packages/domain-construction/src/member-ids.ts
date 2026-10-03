// Member ids (ADR 0015 decision 6). A member's id is local to the feature that owns it, and its
// full id is `<owner feature id>:<local id>`: one feature id, always at the front. A local id is
// stable by role and layout and deliberately fragile: lengthening a wall adds slots at the end and
// keeps the others, changing its spacing or layout origin renumbers them.
//
// Wall members, owned by the wall:
//
//   s<k>                       layout slot k: s0 flush at the start, s<k> centred on k x spacing
//                              from the layout origin, the last flush at the end
//   bottom<c>:<n>, top<c>:<n>  plate course c (1 is nearest the studs), piece n along the wall
//   block<r>:<n>               blocking row r, block n along the wall
//   start:<m>, end:<m>         corner framing at an L corner where this wall runs through:
//                              corner, corner-2, backing<r>
//   t<i>:<m>                   framing where the i-th tee (another wall's end) meets this wall:
//                              corner-l, corner-r, corner-c, backing<r>
//
// Every wall form takes a `seg<n>/` prefix in the n-th segment of a wall with several segments
// (n >= 2; the first segment has no prefix), so a straight wall's ids carry none.
//
// Opening members, owned by the opening (framed with its host wall, but not the wall's):
//
//   king-l, king-l2, king-r, ...   king studs each side, nearest the opening first
//   jack-l, jack-l2, jack-r, ...   jack studs each side, nearest the opening first
//   header, header-2, ...          header plies across the wall
//   spacer                         the header spacer
//   sill                           the rough sill (windows)
//   cripple-a<n>, cripple-b<n>     cripples above the header and below the sill
//
// Every id has exactly one spelling: the first king is `king-l`, never `king-l1`; the first
// header ply is `header`, never `header-1`; numbers have no leading zeros. The parsers refuse any
// other spelling, so one member has one id. A local id may contain a colon (`top1:2`), so a full
// id splits at its first colon only.

/** A feature id as core defines it (`kind#n`, core's `FEATURE_ID_PATTERN`). */
const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;
/** 1, 2, 3, ... */
const N = '[1-9][0-9]*';
/** 2, 3, ...: the second and later of a kind whose first has no number. */
const N2 = '(?:[2-9]|[1-9][0-9]+)';

export type CornerMemberName = 'corner' | 'corner-2' | `backing${number}`;
export type TeeMemberName = 'corner-l' | 'corner-r' | 'corner-c' | `backing${number}`;

/** A parsed wall member id. `segment` is 1-based; 1 for an unprefixed id. */
export type WallMemberId =
  | { readonly form: 'slot'; readonly segment: number; readonly slot: number }
  | {
      readonly form: 'plate';
      readonly segment: number;
      readonly plate: 'bottom' | 'top';
      readonly course: number;
      readonly piece: number;
    }
  | { readonly form: 'block'; readonly segment: number; readonly row: number; readonly n: number }
  | {
      readonly form: 'corner';
      readonly segment: number;
      readonly end: 'start' | 'end';
      readonly name: CornerMemberName;
    }
  | {
      readonly form: 'tee';
      readonly segment: number;
      readonly tee: number;
      readonly name: TeeMemberName;
    };

/** A parsed opening member id. `n` counts from 1 (the unnumbered first one). */
export type OpeningMemberId =
  | { readonly form: 'king' | 'jack'; readonly side: 'l' | 'r'; readonly n: number }
  | { readonly form: 'header'; readonly n: number }
  | { readonly form: 'spacer' | 'sill' }
  | { readonly form: 'cripple'; readonly where: 'above' | 'below'; readonly n: number };

const PREFIX = new RegExp(`^seg(${N})/(.*)$`);
const SLOT = /^s(0|[1-9][0-9]*)$/;
const PLATE = new RegExp(`^(bottom|top)(${N}):(${N})$`);
const BLOCK = new RegExp(`^block(${N}):(${N})$`);
const CORNER = new RegExp(`^(start|end):(corner|corner-2|backing${N})$`);
const TEE = new RegExp(`^t(${N}):(corner-l|corner-r|corner-c|backing${N})$`);

const STUD = new RegExp(`^(king|jack)-([lr])(${N2})?$`);
const HEADER = new RegExp(`^header(?:-(${N2}))?$`);
const CRIPPLE = new RegExp(`^cripple-([ab])(${N})$`);

/** Parses a wall's own member id; undefined when it is none of the wall forms above. */
export function parseWallMemberId(id: string): WallMemberId | undefined {
  let segment = 1;
  let rest = id;
  const p = PREFIX.exec(id);
  if (p) {
    segment = Number(p[1]);
    if (segment < 2) return undefined;
    rest = p[2]!;
  }
  let m = SLOT.exec(rest);
  if (m) return { form: 'slot', segment, slot: Number(m[1]) };
  m = PLATE.exec(rest);
  if (m)
    return {
      form: 'plate',
      segment,
      plate: m[1] as 'bottom' | 'top',
      course: Number(m[2]),
      piece: Number(m[3]),
    };
  m = BLOCK.exec(rest);
  if (m) return { form: 'block', segment, row: Number(m[1]), n: Number(m[2]) };
  m = CORNER.exec(rest);
  if (m)
    return {
      form: 'corner',
      segment,
      end: m[1] as 'start' | 'end',
      name: m[2] as CornerMemberName,
    };
  m = TEE.exec(rest);
  if (m) return { form: 'tee', segment, tee: Number(m[1]), name: m[2] as TeeMemberName };
  return undefined;
}

function prefixed(segment: number, local: string): string {
  return segment > 1 ? `seg${segment}/${local}` : local;
}

/** The id text of a parsed wall member id; `formatWallMemberId(parseWallMemberId(id)!) === id`. */
export function formatWallMemberId(p: WallMemberId): string {
  switch (p.form) {
    case 'slot':
      return prefixed(p.segment, `s${p.slot}`);
    case 'plate':
      return prefixed(p.segment, `${p.plate}${p.course}:${p.piece}`);
    case 'block':
      return prefixed(p.segment, `block${p.row}:${p.n}`);
    case 'corner':
      return prefixed(p.segment, `${p.end}:${p.name}`);
    case 'tee':
      return prefixed(p.segment, `t${p.tee}:${p.name}`);
  }
}

/** Parses an opening's own member id; undefined when it is none of the opening forms above. */
export function parseOpeningMemberId(id: string): OpeningMemberId | undefined {
  if (id === 'spacer' || id === 'sill') return { form: id };
  let m = STUD.exec(id);
  if (m)
    return {
      form: m[1] as 'king' | 'jack',
      side: m[2] as 'l' | 'r',
      n: m[3] === undefined ? 1 : Number(m[3]),
    };
  m = HEADER.exec(id);
  if (m) return { form: 'header', n: m[1] === undefined ? 1 : Number(m[1]) };
  m = CRIPPLE.exec(id);
  if (m) return { form: 'cripple', where: m[1] === 'a' ? 'above' : 'below', n: Number(m[2]) };
  return undefined;
}

const numbered = (base: string, n: number) => (n === 1 ? base : `${base}${n}`);

/** The id text of a parsed opening member id; round-trips with `parseOpeningMemberId`. */
export function formatOpeningMemberId(p: OpeningMemberId): string {
  switch (p.form) {
    case 'king':
    case 'jack':
      return numbered(`${p.form}-${p.side}`, p.n);
    case 'header':
      return numbered('header-', p.n).replace(/^header-$/, 'header');
    case 'spacer':
    case 'sill':
      return p.form;
    case 'cripple':
      return `cripple-${p.where === 'above' ? 'a' : 'b'}${p.n}`;
  }
}

/** A member's full id: `<owner feature id>:<local id>` (`extension#7:king-l`). */
export function memberFullId(m: { readonly owner: string; readonly id: string }): string {
  return `${m.owner}:${m.id}`;
}

/**
 * Splits a full member id at its first colon into the owner's feature id and the local id;
 * undefined when it has no colon, the owner is not a feature id, or the local id is empty.
 */
export function splitMemberFullId(full: string): { owner: string; id: string } | undefined {
  const i = full.indexOf(':');
  if (i < 0) return undefined;
  const owner = full.slice(0, i);
  const id = full.slice(i + 1);
  return FEATURE_ID.test(owner) && id !== '' ? { owner, id } : undefined;
}

/** Builders used by the generator, so every id goes through one place. */
export const memberIds = {
  slot: (segment: number, k: number) => formatWallMemberId({ form: 'slot', segment, slot: k }),
  plate: (segment: number, plate: 'bottom' | 'top', course: number, piece: number) =>
    formatWallMemberId({ form: 'plate', segment, plate, course, piece }),
  block: (segment: number, row: number, n: number) =>
    formatWallMemberId({ form: 'block', segment, row, n }),
  corner: (segment: number, end: 'start' | 'end', name: CornerMemberName) =>
    formatWallMemberId({ form: 'corner', segment, end, name }),
  tee: (segment: number, tee: number, name: TeeMemberName) =>
    formatWallMemberId({ form: 'tee', segment, tee, name }),
  opening: (p: OpeningMemberId) => formatOpeningMemberId(p),
};
