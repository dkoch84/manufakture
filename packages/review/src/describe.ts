// Readable descriptions of document objects, for the command summaries and the feature diff:
// "Fillet 3 (2 mm) on 4 edges of Extrude 1". Names are looked up in the documents given, the
// first that has the object winning, and shown through `shown` (bounded, no control characters).

import {
  findMaterial,
  type Feature,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { expressionText, plural, shown } from './text';

/** Name lookups over several documents: the state before a command, after it, base, head. */
export class Names {
  readonly #docs: readonly ManufaktureDocument[];

  constructor(docs: readonly (ManufaktureDocument | undefined)[]) {
    this.#docs = docs.filter((d): d is ManufaktureDocument => d !== undefined);
  }

  #first<T>(pick: (doc: ManufaktureDocument) => T | undefined): T | undefined {
    for (const doc of this.#docs) {
      const v = pick(doc);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** How many parts the documents have at most: a summary names the part only when it matters. */
  get manyParts(): boolean {
    return this.#docs.some((d) => d.parts.length > 1);
  }

  part(partId: string): string {
    return shown(this.#first((d) => d.parts.find((p) => p.id === partId)?.name) ?? partId);
  }

  feature(partId: string, featureId: string): string {
    return shown(
      this.#first(
        (d) => d.parts.find((p) => p.id === partId)?.features.find((f) => f.id === featureId)?.name,
      ) ?? featureId,
    );
  }

  /** A feature by id in any part (face names do not carry the part). */
  anyFeature(featureId: string): string {
    return shown(
      this.#first((d) => {
        for (const p of d.parts) {
          const f = p.features.find((x) => x.id === featureId);
          if (f) return f.name;
        }
        return undefined;
      }) ?? featureId,
    );
  }

  assembly(id: string): string {
    return shown(this.#first((d) => d.assemblies.find((a) => a.id === id)?.name) ?? id);
  }

  instance(assemblyId: string, id: string): string {
    return shown(
      this.#first(
        (d) =>
          d.assemblies.find((a) => a.id === assemblyId)?.instances.find((i) => i.id === id)?.name,
      ) ?? id,
    );
  }

  mate(assemblyId: string, id: string): string {
    return shown(
      this.#first(
        (d) => d.assemblies.find((a) => a.id === assemblyId)?.mates.find((m) => m.id === id)?.name,
      ) ?? id,
    );
  }

  explodedView(assemblyId: string, id: string): string {
    return shown(
      this.#first(
        (d) =>
          d.assemblies.find((a) => a.id === assemblyId)?.explodedViews?.find((v) => v.id === id)
            ?.name,
      ) ?? id,
    );
  }

  drawing(id: string): string {
    return shown(this.#first((d) => d.drawings?.find((x) => x.id === id)?.name) ?? id);
  }

  sheet(drawingId: string, id: string): string {
    return shown(
      this.#first(
        (d) => d.drawings?.find((x) => x.id === drawingId)?.sheets.find((s) => s.id === id)?.name,
      ) ?? id,
    );
  }

  printSetup(id: string): string {
    return shown(this.#first((d) => d.print.setups.find((s) => s.id === id)?.name) ?? id);
  }

  camSetup(id: string): string {
    return shown(this.#first((d) => d.cam.setups.find((s) => s.id === id)?.name) ?? id);
  }

  camTool(id: string): string {
    return shown(this.#first((d) => d.cam.tools.find((t) => t.id === id)?.name) ?? id);
  }

  camOperation(setupId: string, id: string): string {
    return shown(
      this.#first(
        (d) =>
          d.cam.setups.find((s) => s.id === setupId)?.operations.find((o) => o.id === id)?.name,
      ) ?? id,
    );
  }

  script(id: string): string {
    return shown(this.#first((d) => d.scripts?.find((s) => s.id === id)?.name) ?? id);
  }

  font(id: string): string {
    return shown(
      this.#first((d) => {
        const f = d.fonts.find((x) => x.id === id);
        return f ? `${f.family} ${f.style}` : undefined;
      }) ?? id,
    );
  }

  configParameter(id: string): string {
    return shown(
      this.#first((d) => d.configurations?.parameters.find((p) => p.id === id)?.name) ?? id,
    );
  }

  configRow(id: string): string {
    return shown(this.#first((d) => d.configurations?.rows.find((r) => r.id === id)?.name) ?? id);
  }

  bodyGroup(partId: string, id: string): string {
    return shown(
      this.#first(
        (d) => d.parts.find((p) => p.id === partId)?.bodyGroups?.find((g) => g.id === id)?.name,
      ) ?? id,
    );
  }

  variable(name: string): StoredExpression | undefined {
    return this.#first((d) => d.variables.find((v) => v.name === name)?.expression);
  }
}

export function materialName(id: string | null | undefined): string {
  if (id === null || id === undefined) return 'none';
  return shown(findMaterial(id)?.name ?? id);
}

/** The feature id a face or edge name starts with (`extrude#1:side:e3` gives `extrude#1`). */
export function ownerOf(name: string): string | null {
  return /^([a-z][a-z0-9]*#\d+)/.exec(name)?.[1] ?? null;
}

/** "of Extrude 1", "of Extrude 1 and Hole 1", for the features names belong to. */
function ofFeatures(names: readonly string[], lookup: Names): string {
  const owners = [...new Set(names.map(ownerOf).filter((o): o is string => o !== null))];
  if (owners.length === 0) return '';
  const named = owners.slice(0, 3).map((o) => lookup.anyFeature(o));
  const more = owners.length > 3 ? ` and ${owners.length - 3} more` : '';
  return ` of ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]}${more}`;
}

const KIND_WORDS: Record<string, string> = {
  sketch: 'sketch',
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  hole: 'hole',
  pattern: 'pattern',
  mirror: 'mirror',
  extension: 'feature',
  import: 'import',
  derived: 'derived part',
  thread: 'thread',
  scripted: 'scripted feature',
};

/** The feature's kind as the tree shows it: `extension:wood.board` for an extension. */
export function featureKind(f: Feature): string {
  return f.kind === 'extension' ? `extension:${f.extension}` : f.kind;
}

/** "Fillet 3", or "hole M4 holes" when the name does not say what it is. */
export function featureTitle(f: Feature): string {
  const name = shown(f.name);
  const word =
    f.kind === 'extension'
      ? shown(f.extension.split('.').at(-1) ?? f.extension, 40)
      : (KIND_WORDS[f.kind] ?? f.kind);
  return name.toLowerCase().startsWith(word.toLowerCase()) ? name : `${word} ${name}`;
}

const op = (o: string | undefined): string => (o === undefined ? '' : `${o}, `);

/** What a feature does, after its title: " (2 mm) on 4 edges of Extrude 1". */
export function featureDetail(f: Feature, lookup: Names, partId: string): string {
  switch (f.kind) {
    case 'sketch':
      return ` (${plural(f.entities.length, 'entity', 'entities')}, ${plural(f.constraints.length, 'constraint')})`;
    case 'extrude': {
      const e = f.extent;
      const extent =
        e.type === 'blind' || e.type === 'symmetric'
          ? `${e.type} ${expressionText(e.distance)}`
          : e.type === 'throughAll'
            ? 'through all'
            : `up to a face${ofFeatures([e.face.ref.face], lookup)}`;
      return ` (${op(f.operation)}${extent}${f.reverse ? ', reversed' : ''}) from ${lookup.feature(partId, f.profile.sketch)}`;
    }
    case 'revolve':
      return ` (${op(f.operation)}${expressionText(f.angle, 'angle')}${f.symmetric ? ' symmetric' : ''}) from ${lookup.feature(partId, f.profile.sketch)}`;
    case 'fillet':
      return ` (${expressionText(f.radius)}) on ${plural(f.edges.length, 'edge')}${ofFeatures(
        f.edges.flatMap((e) => e.ref.faces),
        lookup,
      )}`;
    case 'chamfer': {
      const size =
        f.secondDistance !== undefined
          ? `${expressionText(f.distance)} by ${expressionText(f.secondDistance)}`
          : f.angle !== undefined
            ? `${expressionText(f.distance)} at ${expressionText(f.angle, 'angle')}`
            : expressionText(f.distance);
      return ` (${size}) on ${plural(f.edges.length, 'edge')}${ofFeatures(
        f.edges.flatMap((e) => e.ref.faces),
        lookup,
      )}`;
    }
    case 'shell':
      return ` (${expressionText(f.thickness)}${f.outward ? ' outward' : ''}) removing ${plural(f.faces.length, 'face')}${ofFeatures(
        f.faces.map((x) => x.ref.face),
        lookup,
      )}`;
    case 'hole': {
      const extent =
        f.extent.type === 'blind' ? expressionText(f.extent.depth) + ' deep' : 'through all';
      const head =
        f.head.type === 'simple' ? '' : `, ${f.head.type} ${expressionText(f.head.diameter)}`;
      const size = f.standard ? `${shown(f.standard.size, 40)} ${f.standard.fit}, ` : '';
      return ` (${plural(f.points.length, 'hole')}, ${size}${expressionText(f.diameter)} ${extent}${head}) on ${lookup.feature(partId, f.sketch)}`;
    }
    case 'pattern': {
      const l = f.layout;
      const layout =
        l.type === 'linear'
          ? `linear, ${expressionText(l.count, 'count')} at ${expressionText(l.spacing)}`
          : `circular, ${expressionText(l.count, 'count')} over ${expressionText(l.angle, 'angle')}`;
      const what = f.body
        ? `bodies${f.scope ? ` ${f.scope.map((s) => lookup.feature(partId, s)).join(', ')}` : ''}`
        : f.features.map((x) => lookup.feature(partId, x)).join(', ');
      return ` (${layout}) of ${what}`;
    }
    case 'mirror': {
      const what = f.body ? 'bodies' : f.features.map((x) => lookup.feature(partId, x)).join(', ');
      return ` of ${what} across a face${ofFeatures([f.plane.ref.face], lookup)}`;
    }
    case 'extension': {
      const deps =
        f.dependsOn.length > 0
          ? ` on ${f.dependsOn.map((d) => lookup.feature(partId, d)).join(', ')}`
          : '';
      return ` (${shown(f.extension, 80)}${f.operation ? `, ${f.operation}` : ''})${deps}`;
    }
    case 'import':
      return ` (${f.source.format.toUpperCase()} ${shown(f.source.fileName, 120)}, ${f.source.size} bytes, ${f.operation})`;
    case 'derived':
      return ` (${shown(f.source.documentName, 120)}, version ${shown(f.source.versionName, 120)}, ${f.operation})`;
    case 'thread': {
      const length = f.length === 'full' ? 'full length' : expressionText(f.length);
      return ` (${shown(f.standard.size, 40)} ${f.standard.system}, ${f.hand}-hand, ${length}, ${f.representation}) on a face${ofFeatures([f.face.ref.face], lookup)}`;
    }
    case 'scripted':
      return ` (script ${lookup.script(f.script)}, ${plural(Object.keys(f.params).length, 'parameter')}, seed ${f.seed})`;
  }
}

/** "Fillet 3 (2 mm) on 4 edges of Extrude 1". */
export function describeFeature(f: Feature, lookup: Names, partId: string): string {
  return shown(`${featureTitle(f)}${featureDetail(f, lookup, partId)}`);
}
