// The tool list as a public contract (ADR 0016 decision 7): src/tools.golden.json holds every
// tool's name with its input and output schemas as `tools/list` gives them. A change that does
// more than add fails here, always. A change that only adds fails too until the golden is
// rewritten with the surface version raised:
//
//   UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run --project mcp apps/mcp/test/golden.test.ts
//
// (then `prettier --write apps/mcp/src/tools.golden.json`).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schemaIndex } from '@manufakture/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contractOf,
  surfaceChanges,
  versionAfter,
  type SurfaceContract,
  type ToolContract,
} from '../src/surface';
import { SURFACE_VERSION } from '../src/version';
import { harness, type Harness } from './harness';

const GOLDEN = fileURLToPath(new URL('../src/tools.golden.json', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function current(): Promise<SurfaceContract> {
  const { tools } = await h.client.listTools();
  return contractOf(SURFACE_VERSION, tools);
}

describe('the tool surface', () => {
  it('only ever grows, and the golden matches it', async () => {
    const now = await current();
    if (!existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
      throw new Error('tools.golden.json was missing and has been written: check it, rerun.');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as SurfaceContract;
    // Never anything but additions, whatever UPDATE_GOLDENS says.
    expect(surfaceChanges(golden, now)).toEqual([]);
    const same = JSON.stringify(golden.tools) === JSON.stringify(now.tools);
    if (same) {
      expect(now.surfaceVersion, 'SURFACE_VERSION without a change to the tools').toBe(
        golden.surfaceVersion,
      );
      return;
    }
    if (!UPDATE) {
      throw new Error(
        'The tools changed (additions only): raise SURFACE_VERSION in src/version.ts and rewrite the golden with UPDATE_GOLDENS=1.',
      );
    }
    expect(versionAfter(now.surfaceVersion, golden.surfaceVersion), 'raise SURFACE_VERSION').toBe(
      true,
    );
    writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
  });
});

describe('commands in the golden', () => {
  it("holds core's command types as apply's enum (ADR 0016, amendment of decisions 6 and 7)", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as SurfaceContract;
    const apply = golden.tools.find((t) => t.name === 'apply')!;
    const commands = (apply.inputSchema as { properties: { commands: { items: unknown } } })
      .properties.commands.items as { properties: { type: { enum: string[] } } };
    expect([...commands.properties.type.enum].sort()).toEqual([...schemaIndex().commands].sort());
  });
});

describe('what counts as more than adding', () => {
  const tool = (inputSchema: unknown, outputSchema: unknown = {}): ToolContract => ({
    name: 't',
    inputSchema,
    outputSchema,
  });
  const surface = (...tools: ToolContract[]): SurfaceContract => ({
    surfaceVersion: '1.0.0',
    tools,
  });
  const input = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  const base = input({ a: { type: 'string', maxLength: 10 }, k: { enum: ['x', 'y'] } }, ['a']);

  it('allows a new tool, a new optional input, a wider bound or enum, a new output field', () => {
    const old = surface(tool(base, input({ v: { type: 'number' } })));
    const grown = surface(
      tool(
        input({ a: { type: 'string', maxLength: 20 }, k: { enum: ['x', 'y', 'z'] }, b: {} }, ['a']),
        input({ v: { type: 'number' }, w: { type: 'string' } }),
      ),
      { ...tool({}), name: 'u' },
    );
    expect(surfaceChanges(old, grown)).toEqual([]);
  });

  it('refuses a removed tool, a new required input, a tighter bound, a dropped enum value', () => {
    const old = surface(tool(base, input({ v: { type: 'number' } }, ['v'])));
    expect(surfaceChanges(old, surface())).toEqual(['t: removed']);
    expect(
      surfaceChanges(old, surface(tool(input({ ...base.properties, b: {} }, ['a', 'b'])))),
    ).toContain('t input/required: b is newly required');
    expect(
      surfaceChanges(
        old,
        surface(tool(input({ ...base.properties, a: { type: 'string', maxLength: 5 } }, ['a']))),
      ),
    ).toContain('t input/properties/a/maxLength: tightened');
    expect(
      surfaceChanges(old, surface(tool(input({ ...base.properties, k: { enum: ['x'] } }, ['a'])))),
    ).toContain('t input/properties/k/enum: "y" dropped');
    expect(
      surfaceChanges(old, surface(tool(base, input({ v: { type: 'string' } }, ['v'])))),
    ).toContain('t output/properties/v/type: changed');
    expect(surfaceChanges(old, surface(tool(base, input({}, []))))).toEqual(
      expect.arrayContaining(['t output/properties/v: removed']),
    );
  });

  it('refuses a new value in an output enum, which a client may not know', () => {
    const old = surface(tool(base, input({ s: { enum: ['open', 'closed'] } })));
    expect(
      surfaceChanges(old, surface(tool(base, input({ s: { enum: ['open', 'closed', 'gone'] } })))),
    ).toEqual(['t output/properties/s/enum: "gone" added to an output enum']);
  });
});
