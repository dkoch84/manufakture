// The mesher's licence record (ADR 0006, amendment of 2026-10-10): every component gmsh's
// configuration names is listed in build/components.json with a licence this separate module may
// carry, every licence text it names ships in wasm/licenses/, and nothing is or names Blossom.
// The license check of tools/licenses picks this module up once an artifact ships it (T9.6c).

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface Component {
  name: string;
  version: string;
  config: string[];
  license: string;
  texts: string[];
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { components } = JSON.parse(read('../build/components.json')) as { components: Component[] };
const built = existsSync(new URL('../wasm/build-info.json', import.meta.url));

/**
 * ADR 0006 decision 2, with the amendment: permissive licences, MPL-2.0, GPL "or later" with v3,
 * and LGPL-2.1 with the Open CASCADE exception inside this separately loaded module. `LicenseRef-`
 * ids are permissive notices named in the component's note.
 */
const ALLOWED = new Set([
  'MIT',
  'NCSA',
  'BSD-2-Clause',
  'MPL-2.0',
  'GPL-2.0-or-later',
  'LGPL-2.1-only',
  'Apache-2.0',
  'LicenseRef-UC-permission',
  'LicenseRef-public-domain',
]);
const EXCEPTIONS: Record<string, string> = {
  'Open-CASCADE-Exception-1.0': 'LGPL-2.1-only',
  'LLVM-exception': 'Apache-2.0',
};

/** Every licence id and exception in an expression; AND, OR and parentheses are separators. */
function ids(expression: string): { id: string; exception?: string }[] {
  const tokens = expression.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
  const out: { id: string; exception?: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === 'AND' || t === 'OR') continue;
    if (tokens[i + 1] === 'WITH') {
      out.push({ id: t, exception: tokens[i + 2]! });
      i += 2;
    } else out.push({ id: t });
  }
  return out;
}

describe('the mesher module licence record', () => {
  test('every licence is allowed inside the module', () => {
    for (const c of components) {
      for (const { id, exception } of ids(c.license)) {
        expect(ALLOWED.has(id), `${c.name}: ${id}`).toBe(true);
        if (exception) expect(EXCEPTIONS[exception], `${c.name}: ${exception}`).toBe(id);
      }
    }
  });

  test('nothing is Blossom', () => {
    for (const c of components)
      expect(`${c.name} ${c.config.join(' ')}`).not.toMatch(/blossom|concorde/i);
  });

  test.skipIf(!built)('every configured component is listed, and every text ships', () => {
    const info = JSON.parse(read('../wasm/build-info.json')) as {
      gmshConfig: string;
      gmsh: string;
      occt: string;
    };
    expect(info.gmshConfig).not.toMatch(/blossom/i);
    const listed = new Set(components.flatMap((c) => c.config));
    for (const word of info.gmshConfig.split(/\s+/).filter(Boolean)) {
      expect(listed.has(word), `gmsh option ${word} has no entry in build/components.json`).toBe(
        true,
      );
    }
    for (const c of components) {
      for (const t of c.texts) {
        expect(
          existsSync(new URL(`../wasm/licenses/${t}`, import.meta.url)),
          `${c.name}: ${t}`,
        ).toBe(true);
      }
    }
    expect(components.find((c) => c.name === 'gmsh')!.license).toBe('GPL-2.0-or-later');
    expect(components.find((c) => c.config.includes('OpenCASCADE'))!.version).toBe(info.occt);
  });
});
