// The MCP server's configuration, from the environment (M8 plan T8.4a, T8.4b): where documents
// come from (a sync server with an agent token, the normal case; or a library directory, for tests
// and CI), where exports go, and which engine sessions use.
//
// Every directory is resolved to its real path once at start, so a symbolic link in the
// configured path is followed by the person who set it, never later by a tool's input.

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_TOKEN, type EngineKind } from '@manufakture/session';

export const ENV = {
  /**
   * The library's root directory (a `NodeBackend` root: `documents/...` under it). Required unless
   * a sync server is configured; with one, sessions work over sync and this is not used.
   */
  library: 'MANUFAKTURE_LIBRARY',
  /** The directory `export` writes into. Optional: without it, `export` refuses. */
  output: 'MANUFAKTURE_OUTPUT',
  /** `worker` (default) or `in-process`: where each session's kernel runs. */
  engine: 'MANUFAKTURE_ENGINE',
  /** The sync server's URL (T8.4b): sessions open documents there. Optional. */
  syncUrl: 'MANUFAKTURE_SYNC_URL',
  /**
   * The agent token for the sync server (T8.4b): `agent.<id>.<secret>`, issued by the server's
   * owner. Required with the URL; never shown anywhere. The instance's own token is refused.
   */
  syncToken: 'MANUFAKTURE_SYNC_TOKEN',
} as const;

export interface SyncConfig {
  url: string;
  /** Kept out of every log line and tool result. */
  token: string;
}

export interface McpConfig {
  /** Real path of the library root; null when sessions work over sync without one. */
  libraryRoot: string | null;
  /** Real path of the output directory, or null when none is configured. */
  outputDir: string | null;
  engine: EngineKind;
  /** The sync server (T8.4b): when set, documents and sessions are the server's. */
  sync: SyncConfig | null;
}

/**
 * The configuration, or what is wrong with it. `warnings` are worth saying on stderr but do not
 * stop the server (a sync server over plain http to another machine).
 */
export type ConfigResult =
  { ok: true; config: McpConfig; warnings: string[] } | { ok: false; problems: string[] };

/** Whether `host` (a URL's hostname) names this machine. */
function loopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

async function directory(name: string, value: string, problems: string[]): Promise<string | null> {
  if (!path.isAbsolute(value)) {
    problems.push(`${name} must be an absolute path.`);
    return null;
  }
  let real: string;
  try {
    real = await realpath(value);
  } catch {
    problems.push(`${name} does not exist.`);
    return null;
  }
  try {
    if (!(await stat(real)).isDirectory()) {
      problems.push(`${name} is not a directory.`);
      return null;
    }
  } catch {
    problems.push(`${name} cannot be read.`);
    return null;
  }
  return real;
}

/** Whether `inner` is `outer` or inside it (both real paths). */
export function within(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

/**
 * The configuration from `env`, every directory checked and resolved. `MANUFAKTURE_SYNC_TOKEN` is
 * removed from `env` once read.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ConfigResult> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const libraryValue = env[ENV.library];
  const syncSet = env[ENV.syncUrl] !== undefined && env[ENV.syncUrl] !== '';
  let libraryRoot: string | null = null;
  if (libraryValue === undefined || libraryValue === '') {
    if (!syncSet) {
      problems.push(
        `${ENV.library} is not set: the library's root directory (or set ${ENV.syncUrl}).`,
      );
    }
  } else {
    libraryRoot = await directory(ENV.library, libraryValue, problems);
  }

  const outputValue = env[ENV.output];
  let outputDir: string | null = null;
  if (outputValue !== undefined && outputValue !== '') {
    outputDir = await directory(ENV.output, outputValue, problems);
  }
  // Exports never land among the library's own files, and the library is never inside the
  // directory an agent writes to.
  if (libraryRoot !== null && outputDir !== null) {
    if (within(libraryRoot, outputDir) || within(outputDir, libraryRoot)) {
      problems.push(`${ENV.output} and ${ENV.library} must not contain each other.`);
    }
  }

  const engineValue = env[ENV.engine] ?? 'worker';
  let engine: EngineKind = 'worker';
  if (engineValue === 'worker' || engineValue === 'in-process') engine = engineValue;
  else problems.push(`${ENV.engine} is worker or in-process.`);

  let sync: SyncConfig | null = null;
  const syncUrl = env[ENV.syncUrl];
  const syncToken = env[ENV.syncToken];
  // Read once, then gone from the environment: session workers and any child process inherit
  // the environment, and none of them needs the token.
  delete env[ENV.syncToken];
  if (syncUrl !== undefined && syncUrl !== '') {
    let url: URL | null = null;
    try {
      url = new URL(syncUrl);
    } catch {
      problems.push(`${ENV.syncUrl} is not a URL.`);
    }
    if (url !== null) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push(`${ENV.syncUrl} must be an http or https URL.`);
      } else if (url.username !== '' || url.password !== '') {
        problems.push(`${ENV.syncUrl} must not carry credentials: use ${ENV.syncToken}.`);
      } else if (syncToken === undefined || syncToken === '') {
        problems.push(`${ENV.syncToken} is not set: the agent token for ${ENV.syncUrl}.`);
      } else if (!AGENT_TOKEN.test(syncToken)) {
        // Never quoted: it may be the instance's own token, the one that may do everything.
        problems.push(
          `${ENV.syncToken} is not an agent token (agent.<id>.<secret>). Issue one for the agent on the sync server; the instance's own token is never given to an agent.`,
        );
      } else {
        sync = { url: url.href, token: syncToken };
        if (url.protocol === 'http:' && !loopback(url.hostname)) {
          warnings.push(
            `${ENV.syncUrl} is plain http to another machine: the agent token and the documents cross the network unencrypted. Use https.`,
          );
        }
      }
    }
  } else if (syncToken !== undefined && syncToken !== '') {
    problems.push(`${ENV.syncToken} is set without ${ENV.syncUrl}.`);
  }

  if (problems.length > 0 || (libraryRoot === null && sync === null)) {
    return { ok: false, problems };
  }
  return { ok: true, config: { libraryRoot, outputDir, engine, sync }, warnings };
}
