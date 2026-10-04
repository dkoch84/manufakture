// Documents with scripts for the scripts and scripted feature tests.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type Script,
  type ScriptedFeature,
} from '@manufakture/core';

export const PART = 'part#1';

export const BOX_SOURCE = `export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  flip: { kind: 'boolean', default: false },
};
export function run(ctx, p) {}
`;

export const OTHER_SOURCE = 'export function run(ctx) {}\n';

export const script = (id: string, name: string, source: string): Script => ({
  id,
  name,
  language: 'js',
  apiVersion: 1,
  source,
});

export const scriptedFeature = (
  id: string,
  scriptId: string,
  over: Partial<ScriptedFeature> = {},
): ScriptedFeature => ({
  id,
  kind: 'scripted',
  name: `Scripted ${id.slice(id.indexOf('#') + 1)}`,
  suppressed: false,
  script: scriptId,
  params: {},
  seed: 0,
  dependsOn: [],
  ...over,
});

export function applyAll(doc: ManufaktureDocument, commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** `doc-s`: scripts Box (script#1) and Other (script#2); Scripted 1 runs Box, Scripted 2 Other. */
export function scriptedDocument(id = 'doc-s'): ManufaktureDocument {
  return applyAll(createDocument({ id, name: 'Scripted' }), [
    { type: 'setScript', script: script('script#1', 'Box', BOX_SOURCE) },
    { type: 'setScript', script: script('script#2', 'Other', OTHER_SOURCE) },
    { type: 'addFeature', partId: PART, feature: scriptedFeature('scripted#1', 'script#1') },
    { type: 'addFeature', partId: PART, feature: scriptedFeature('scripted#2', 'script#2') },
  ]);
}

/** A localStorage stand-in. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}
