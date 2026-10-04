// Build-time half of the source offer (offer.ts): reads where the build comes from (git, or the
// CI environment) and the installed version of every shipped `.wasm` module's package. Runs in
// Node from vite.config.ts only; the app never imports it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnownWasm, SourceInfo, WasmModule } from './offer.ts';

/**
 * A repository's web address from a git remote URL, or null for one that is not a web host:
 * `git@github.com:owner/repo.git` and `https://github.com/owner/repo.git` both give
 * `https://github.com/owner/repo`. Credentials in an https URL are dropped.
 */
export function webUrlFromRemote(remote: string): string | null {
  const trimmed = remote
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The web address of a package's repository from its package.json `repository` field. */
export function repositoryOf(field: unknown): string | null {
  const raw =
    typeof field === 'string'
      ? field
      : field && typeof field === 'object' && 'url' in field && typeof field.url === 'string'
        ? field.url
        : null;
  if (!raw) return null;
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(raw);
  if (shorthand) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[
      shorthand[1] as 'github' | 'gitlab' | 'bitbucket'
    ];
    return `https://${host}/${shorthand[2]!.replace(/\.git$/, '')}`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return webUrlFromRemote(raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://'));
}

type Env = Readonly<Record<string, string | undefined>>;
type Git = (args: string[]) => string | null;

function realGit(cwd: string): Git {
  return (args) => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
}

/**
 * Where the build comes from. Each fact can be given by the environment, for builds made outside
 * a checkout (a source tarball, a container build):
 *
 * - `MANUFAKTURE_SOURCE_COMMIT`, else `GITHUB_SHA` (GitHub Actions), else `git rev-parse HEAD`;
 * - `MANUFAKTURE_SOURCE_DIRTY` (`1` or `0`), else whether a tracked file differs from the commit
 *   (`git status --porcelain --untracked-files=no`; false when there is no checkout). Untracked
 *   files are left out, so what an install or a build leaves behind never marks a clean CI
 *   checkout dirty;
 * - `MANUFAKTURE_SOURCE_URL`, else `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`, else the web address
 *   of the `origin` remote. A fork that serves its build must offer its own repository, so the
 *   remote, not a fixed address, is the default.
 */
export function readSourceInfo(
  repoRoot: string,
  env: Env = process.env,
  git: Git = realGit(repoRoot),
): SourceInfo {
  const commit =
    env.MANUFAKTURE_SOURCE_COMMIT || env.GITHUB_SHA || git(['rev-parse', 'HEAD']) || null;
  let dirty: boolean;
  if (env.MANUFAKTURE_SOURCE_DIRTY === '1' || env.MANUFAKTURE_SOURCE_DIRTY === '0') {
    dirty = env.MANUFAKTURE_SOURCE_DIRTY === '1';
  } else {
    const status = git(['status', '--porcelain', '--untracked-files=no']);
    dirty = status !== null && status !== '';
  }
  let repository: string | null;
  if (env.MANUFAKTURE_SOURCE_URL) repository = webUrlFromRemote(env.MANUFAKTURE_SOURCE_URL);
  else if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    repository = `${env.GITHUB_SERVER_URL.replace(/\/+$/, '')}/${env.GITHUB_REPOSITORY}`;
  } else {
    const remote = git(['remote', 'get-url', 'origin']);
    repository = remote ? webUrlFromRemote(remote) : null;
  }
  return { commit, dirty, repository };
}

/** The installed package behind a shipped `.wasm`: version, license and repository. */
export function wasmModule(repoRoot: string, file: string, known: KnownWasm): WasmModule {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, known.from, 'node_modules', known.package, 'package.json'), 'utf8'),
  ) as { version?: unknown; license?: unknown; repository?: unknown; homepage?: unknown };
  const homepage = typeof manifest.homepage === 'string' ? manifest.homepage : null;
  return {
    file,
    package: known.package,
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    license: typeof manifest.license === 'string' ? manifest.license : 'see the package',
    repository: repositoryOf(manifest.repository) ?? (homepage ? webUrlFromRemote(homepage) : null),
    role: known.role,
  };
}
