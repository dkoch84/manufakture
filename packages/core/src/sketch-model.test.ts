import type {
  PointRef as SketchPointRef,
  SketchConstraint as SketchSketchConstraint,
  SketchEntity as SketchSketchEntity,
  SketchPlacement as SketchSketchPlacement,
  StoredExpression as SketchStoredExpression,
  Vec2 as SketchVec2,
  Vec3 as SketchVec3,
} from '@manufakture/sketch/model';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type {
  ConstraintKind,
  Point2,
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SketchPlacement,
  StoredExpression,
  Vec3,
} from './index';
import {
  Point2Schema,
  PointRefSchema,
  SketchConstraintSchema,
  SketchEntitySchema,
  SketchPlacementSchema,
  StoredExpressionSchema,
  Vec3Schema,
} from './index';

// The sketch data types are defined once, in `@manufakture/sketch/model`. Core validates them
// with zod schemas that are tied to those types in both directions at compile time:
//
// - `satisfies z.ZodType<T>` in schema.ts: whatever the schema accepts is a valid `T`;
// - the assertions below: the schema's inferred type is exactly `T`, so the schema accepts every
//   field `T` has, with the same optionality and readonly-ness.
//
// These run under `tsc` (make typecheck), which is where drift shows up; vitest only runs the
// value checks. `.branded` compares deeply, so `A & (B | C)` in the sketch types equals zod's
// flattened `(A & B) | (A & C)`.

describe('sketch model types', () => {
  it('schemas infer exactly the sketch model types', () => {
    expectTypeOf<
      z.infer<typeof StoredExpressionSchema>
    >().branded.toEqualTypeOf<SketchStoredExpression>();
    expectTypeOf<z.infer<typeof Point2Schema>>().branded.toEqualTypeOf<SketchVec2>();
    expectTypeOf<z.infer<typeof Vec3Schema>>().branded.toEqualTypeOf<SketchVec3>();
    expectTypeOf<z.infer<typeof PointRefSchema>>().branded.toEqualTypeOf<SketchPointRef>();
    expectTypeOf<z.infer<typeof SketchEntitySchema>>().branded.toEqualTypeOf<SketchSketchEntity>();
    expectTypeOf<
      z.infer<typeof SketchConstraintSchema>
    >().branded.toEqualTypeOf<SketchSketchConstraint>();
    expectTypeOf<
      z.infer<typeof SketchPlacementSchema>
    >().branded.toEqualTypeOf<SketchSketchPlacement>();
  });

  it('core re-exports the sketch model types themselves', () => {
    expectTypeOf<StoredExpression>().toEqualTypeOf<SketchStoredExpression>();
    expectTypeOf<Point2>().toEqualTypeOf<SketchVec2>();
    expectTypeOf<Vec3>().toEqualTypeOf<SketchVec3>();
    expectTypeOf<PointRef>().toEqualTypeOf<SketchPointRef>();
    expectTypeOf<SketchEntity>().toEqualTypeOf<SketchSketchEntity>();
    expectTypeOf<SketchConstraint>().toEqualTypeOf<SketchSketchConstraint>();
    expectTypeOf<ConstraintKind>().toEqualTypeOf<SketchSketchConstraint['kind']>();
    expectTypeOf<SketchPlacement>().toEqualTypeOf<SketchSketchPlacement>();
    expectTypeOf<SketchFeature['entities']>().branded.toEqualTypeOf<SketchSketchEntity[]>();
    expectTypeOf<SketchFeature['constraints']>().branded.toEqualTypeOf<SketchSketchConstraint[]>();
  });

  it('the assertions catch drift', () => {
    // An extra field on either side is drift, even an optional one that `satisfies` lets through.
    expectTypeOf<z.infer<typeof PointRefSchema>>()
      // @ts-expect-error the sketch type gained a field the schema does not know
      .branded.toEqualTypeOf<SketchPointRef & { weight?: number }>();
    // zod's `.optional()` infers `at?: X | undefined`, which is not the sketch type's `at?: X`
    // under exactOptionalPropertyTypes; `satisfies` catches it (hence `exactOptional` in schema.ts).
    const loose = z.strictObject({ entity: z.string(), at: z.enum(['start', 'end']).optional() });
    // @ts-expect-error an explicit undefined is not a valid sketch PointRef
    void (loose satisfies z.ZodType<SketchPointRef>);
    // A mutable tuple is not the sketch model's readonly `Vec2`.
    // @ts-expect-error mutable versus readonly
    expectTypeOf<[number, number]>().branded.toEqualTypeOf<SketchVec2>();
    // A constraint kind the schema lacks.
    expectTypeOf<z.infer<typeof SketchConstraintSchema>>()
      // @ts-expect-error the sketch model gained a constraint kind
      .branded.toEqualTypeOf<SketchSketchConstraint | { id: string; kind: 'block'; a: string }>();
  });
});

describe('sketch model at runtime', () => {
  it('core imports only types from the sketch package', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const found = runtimeSketchImports(readFileSync(`${dir}/${file}`, 'utf8'));
      expect(found, `${file} loads the sketch package at runtime`).toEqual([]);
    }
  });

  it('the import guard catches every runtime form', () => {
    // Built at runtime so this file's own source never names the package in a string.
    const pkg = ['@manufakture', 'sketch'].join('/');
    const q = '`';
    for (const text of [
      `import { solve } from '${pkg}';`,
      `import '${pkg}';`,
      `import "${pkg}/solver";`,
      `export * from '${pkg}';`,
      `import { type Vec2, solve } from '${pkg}/model';`,
      `const m = await import('${pkg}');`,
      `const m = await import(${q}${pkg}${q});`,
      `const m = require('${pkg}');`,
      `import type { Vec2 } from '${pkg}';`,
    ]) {
      expect(runtimeSketchImports(text), text).not.toEqual([]);
    }
    for (const text of [
      `import type { Vec2 } from '${pkg}/model';`,
      `export type {\n  Vec2,\n  Vec3,\n} from '${pkg}/model';`,
      `// see ${q}${pkg}${q} for the solver`,
      `/* import '${pkg}'; */`,
    ]) {
      expect(runtimeSketchImports(text), text).toEqual([]);
    }
  });

  it('accepts sketch model values and rejects an explicit undefined optional', () => {
    const ref: SketchPointRef = { entity: 'e1', at: 'start' };
    expect(PointRefSchema.parse(ref)).toEqual(ref);
    expect(PointRefSchema.safeParse({ entity: 'e1' }).success).toBe(true);
    expect(PointRefSchema.safeParse({ entity: 'e1', at: undefined }).success).toBe(false);

    const tangent: SketchSketchConstraint = { id: 'k1', kind: 'tangent', a: 'e1', b: 'e2' };
    expect(SketchConstraintSchema.parse(tangent)).toEqual(tangent);
    const placement: SketchSketchPlacement = {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    };
    expect(SketchPlacementSchema.parse(placement)).toEqual(placement);
  });
});

/**
 * Every mention of the sketch package in `text` outside a type-only import or export from
 * `@manufakture/sketch/model` and outside comments: named and bare side-effect imports,
 * re-exports, `import()` and `require`. Anything left over names the package as a string, which
 * is how a runtime dependency on it would start.
 */
function runtimeSketchImports(text: string): string[] {
  const code = text
    .replace(/^(?:import|export) type [^;]*?from '@manufakture\/sketch\/model';/gms, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  return code.match(/^.*['"`]@manufakture\/sketch\b.*$/gm) ?? [];
}
