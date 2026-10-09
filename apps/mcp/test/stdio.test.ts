// The server as a client starts it: `node --import <the TypeScript hooks> src/main.ts` (the
// package's start script) over stdio, configured from the environment. Initialize, list the
// tools, open a session on the bracket with the default worker engine, read its tree, close it.
// Exports whose kernel prints (OCCT's STEP writer prints its transfer statistics) leave stdout
// to the protocol: every line on it is JSON-RPC. And a configuration problem ends the process
// with the reason on stderr, nothing on stdout.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { bracketDocument } from '@manufakture/session/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SURFACE_VERSION } from '../src/version';
import type { Data } from './harness';

const APP = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = fileURLToPath(
  new URL('../../../packages/session/src/worker/ts-hooks.ts', import.meta.url),
);
const ARGS = ['--expose-gc', '--import', HOOKS, 'src/main.ts'];

let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mfk-mcp-stdio-'));
  await mkdir(path.join(dir, 'library'));
  await mkdir(path.join(dir, 'out'));
  await new DocumentLibrary(new NodeBackend(path.join(dir, 'library'))).create(bracketDocument());
  env = {
    PATH: process.env.PATH ?? '',
    MANUFAKTURE_LIBRARY: path.join(dir, 'library'),
    MANUFAKTURE_OUTPUT: path.join(dir, 'out'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('over stdio', () => {
  it('starts, initializes, lists its tools and runs a session', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ARGS,
      cwd: APP,
      env,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: 'stdio smoke test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({
        name: 'manufakture',
        version: SURFACE_VERSION,
      });
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(18);
      const opened = (await client.callTool({
        name: 'open_session',
        arguments: { documentId: 'doc-bracket' },
      })) as { structuredContent: Data };
      expect(opened.structuredContent.ok).toBe(true);
      const sessionId = opened.structuredContent.sessionId as string;
      const tree = (await client.callTool({ name: 'get_tree', arguments: { sessionId } })) as {
        structuredContent: Data;
      };
      expect(tree.structuredContent.tree.parts[0].bodies[0].bodyId).toBe('extrude#1');
      const closed = (await client.callTool({
        name: 'close_session',
        arguments: { sessionId },
      })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(closed.structuredContent).toMatchObject({ ok: true, closed: true });
    } finally {
      await client.close();
    }
    expect(stderr).toContain('ready');
  }, 120_000);

  it('keeps stdout to JSON-RPC while exports print, every line of it', async () => {
    const child = spawn(process.execPath, ARGS, { cwd: APP, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const replies = new Map<number, (message: Data) => void>();
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      pending += chunk.toString();
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        try {
          const message = JSON.parse(line) as Data;
          replies.get(message.id as number)?.(message);
        } catch {
          // Checked below, once the run is over.
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let next = 1;
    const send = (message: Data) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params: Data): Promise<Data> => {
      const id = next++;
      const reply = new Promise<Data>((resolve) => replies.set(id, resolve));
      send({ jsonrpc: '2.0', id, method, params });
      return reply;
    };
    const call = async (name: string, args: Data): Promise<Data> =>
      ((await request('tools/call', { name, arguments: args })).result as Data)
        .structuredContent as Data;
    try {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stdio export test', version: '1.0.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const opened = await call('open_session', { documentId: 'doc-bracket' });
      expect(opened.ok).toBe(true);
      const sessionId = opened.sessionId as string;
      for (const format of ['step', 'stl', '3mf']) {
        const r = await call('export', { sessionId, format, fileName: `bracket-${format}` });
        expect(r, format).toMatchObject({ ok: true, format });
      }
      expect((await call('close_session', { sessionId })).ok).toBe(true);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect((await readdir(path.join(dir, 'out'))).sort()).toEqual([
      'bracket-3mf.3mf',
      'bracket-step.step',
      'bracket-stl.stl',
    ]);
    const lines = stdout.split('\n');
    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) {
      let message: Data | null = null;
      try {
        message = JSON.parse(line) as Data;
      } catch {
        // Fails just below, naming the line.
      }
      expect(message?.jsonrpc, `a stdout line that is not JSON-RPC: ${line.slice(0, 200)}`).toBe(
        '2.0',
      );
    }
    // The kernel's chatter went to stderr.
    expect(stderr).toContain('Statistics on Transfer (Write)');
  }, 180_000);

  it('ends with the reason when the configuration is wrong', () => {
    const r = spawnSync(process.execPath, ARGS, {
      cwd: APP,
      env: { PATH: env.PATH! },
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('MANUFAKTURE_LIBRARY is not set');
  }, 60_000);
});
