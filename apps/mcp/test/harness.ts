// A server on a fresh library (holding the M1 bracket on Main) and an output directory, both in a
// temporary directory, with the SDK's client connected over the in-process transport. Sessions use
// the kernel in this thread (`in-process`), as packages/session's tests do.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ManufaktureDocument } from '@manufakture/core';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { bracketDocument } from '@manufakture/session/test-fixtures';
import { loadConfig } from '../src/config';
import { createMcpServer, type ManufaktureServer, type ServerOptions } from '../src/server';

export interface Harness {
  dir: string;
  libraryRoot: string;
  outputDir: string;
  documentId: string;
  app: ManufaktureServer;
  client: Client;
  /** Call a tool; the structured result. */
  call(name: string, args?: Record<string, unknown>): Promise<Structured>;
  /** Call a tool; the whole result. */
  raw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type Structured = Record<string, unknown> & {
  ok: boolean;
  error?: Record<string, unknown> & { kind: string; code?: string; message?: string };
};

export async function harness(
  options: {
    document?: ManufaktureDocument;
    output?: boolean;
    server?: Omit<ServerOptions, 'config'>;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mfk-mcp-'));
  const libraryRoot = path.join(dir, 'library');
  const outputDir = path.join(dir, 'out');
  await mkdir(libraryRoot);
  await mkdir(outputDir);
  const doc = options.document ?? bracketDocument();
  await new DocumentLibrary(new NodeBackend(libraryRoot)).create(doc);
  const loaded = await loadConfig({
    MANUFAKTURE_LIBRARY: libraryRoot,
    ...(options.output === false ? {} : { MANUFAKTURE_OUTPUT: outputDir }),
    MANUFAKTURE_ENGINE: 'in-process',
  });
  if (!loaded.ok) throw new Error(loaded.problems.join('; '));
  const app = createMcpServer({ config: loaded.config, ...options.server });
  const client = new Client({ name: 'Test client', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([app.server.connect(serverSide), client.connect(clientSide)]);
  const raw = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    dir,
    libraryRoot: loaded.config.libraryRoot,
    outputDir: loaded.config.outputDir ?? outputDir,
    documentId: doc.id,
    app,
    client,
    raw,
    async call(name, args = {}) {
      const r = await raw(name, args);
      if (r.structuredContent === undefined) {
        // An input the schema refused: the SDK answers with text only.
        const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
        return { ok: false, error: { kind: 'input', message: text } };
      }
      return r.structuredContent as Structured;
    },
    async close() {
      await client.close().catch(() => undefined);
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Result data as tests read it: JSON whose shape each assertion states. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk result JSON freely
export type Data = Record<string, any>;

/** The structured result's fields, failing the test when it is a refusal. */
export function value(r: Structured): Data {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r;
}

export const mm = (v: number) => ({ source: `${v} mm`, lengthUnit: 'mm', angleUnit: 'deg' });

/** A boss on the bracket's upright, by symbolic ids (packages/session's test batch). */
export const BOSS = [
  {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: 'sketch#$bossSketch',
      kind: 'sketch',
      name: 'Boss sketch',
      suppressed: false,
      plane: { type: 'plane', origin: [0, 0, 40], normal: [0, 0, 1], xDir: [1, 0, 0] },
      entities: [
        { id: 'e$circle', kind: 'circle', construction: false, center: [3, 0], radius: 2 },
      ],
      constraints: [],
    },
  },
  {
    type: 'addFeature',
    partId: 'part#1',
    feature: {
      id: 'extrude#$boss',
      kind: 'extrude',
      name: 'Boss',
      suppressed: false,
      profile: { sketch: 'sketch#$bossSketch' },
      operation: 'add',
      extent: { type: 'blind', distance: mm(5) },
      reverse: false,
    },
  },
];
