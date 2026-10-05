// Reads what a target ships from the installed tree: walks the production dependency closure from
// the target's workspace roots (`dependencies` and installed `optionalDependencies`, never
// `devDependencies`), resolving each name as Node does from the package's real directory, so
// pnpm's layout needs no special case. Everything it reads is local, so the result is offline and
// deterministic. The judging is check.ts; the file is render.ts.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  FONT_FILE,
  LICENSE_FILE,
  MANUAL_ENTRIES,
  NOTICE_FILE,
  PACKAGE_TEXTS,
  type ManualEntry,
  type Target,
} from './policy.ts';

export interface TextFile {
  /** The file's name (or repository-relative path, for manual texts). */
  name: string;
  /** The text, line endings normalized; null when the file is missing. */
  text: string | null;
}

export interface CollectedPackage {
  name: string;
  version: string;
  /** The package.json `license` (or legacy `licenses`) as an expression; null when absent. */
  license: string | null;
  repository: string | null;
  /** The package that first pulled it in (`name@version`), for messages. */
  via: string;
  licenseFiles: TextFile[];
  noticeFiles: TextFile[];
  /** Texts from PACKAGE_TEXTS, for a package that ships none. */
  manualTexts: TextFile[];
  manualNote: string | null;
  /** Shipped files (not license files) that carry MPL's Exhibit B notice; MPL packages only. */
  exhibitB: string[];
}

export interface CollectedWorkspace {
  name: string;
  dir: string;
  license: string | null;
}

export interface CollectedManual {
  entry: ManualEntry;
  texts: TextFile[];
}

export interface CollectedFont {
  path: string;
  sha256: string;
}

export interface Collected {
  target: Target;
  packages: CollectedPackage[];
  workspace: CollectedWorkspace[];
  /** Declared, non-optional dependencies that are not installed. */
  missing: { name: string; from: string }[];
  /** Dependency keys that are not valid npm package names (never resolved). */
  invalid: { name: string; from: string }[];
  /** NotShipped rules (`package` and dependency) that matched something. */
  pruned: { package: string; dependency: string }[];
  manual: CollectedManual[];
  fonts: CollectedFont[];
}

interface Manifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  homepage?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** Text with LF line endings and no trailing blank lines. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/**
 * A package.json's license as one expression: the `license` string, the legacy `{ type }` object,
 * or the legacy `licenses` array (joined with AND: without saying which applies, all of them do).
 */
export function licenseOf(manifest: { license?: unknown; licenses?: unknown }): string | null {
  const typeOf = (v: unknown): string | null =>
    typeof v === 'string'
      ? v
      : v && typeof v === 'object' && 'type' in v && typeof v.type === 'string'
        ? v.type
        : null;
  const single = typeOf(manifest.license);
  if (single && single.trim()) return single.trim();
  if (Array.isArray(manifest.licenses)) {
    const all = manifest.licenses.map(typeOf).filter((t): t is string => !!t && !!t.trim());
    if (all.length === 1) return all[0]!;
    if (all.length > 1) return all.map((t) => `(${t})`).join(' AND ');
  }
  return null;
}

/** A repository's web address from a package.json `repository` (or `homepage`) field. */
export function repositoryOf(field: unknown, homepage?: unknown): string | null {
  const raw =
    typeof field === 'string'
      ? field
      : field && typeof field === 'object' && 'url' in field && typeof field.url === 'string'
        ? field.url
        : null;
  if (raw) {
    const short = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(raw);
    if (short) {
      const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
      return `https://${host[short[1] as keyof typeof host]}/${short[2]}`;
    }
    if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
    const url = raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@([\w.-]+):/, 'https://$1/')
      .replace(/\.git$/, '');
    if (/^https?:\/\//.test(url)) return url;
  }
  return typeof homepage === 'string' && /^https?:\/\//.test(homepage) ? homepage : null;
}

/**
 * Orders strings by UTF-16 code unit, as `Array.prototype.sort()` does with no comparator.
 * `localeCompare` depends on the process locale (LANG, LC_ALL), which would make the notices
 * file's bytes differ between machines.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A dependency key that is a valid npm package name, scoped or not, so it is safe to join into a
 * path: one or two segments, each starting with a letter, digit, `~` or `-` (never `.`, so never
 * `..`), no leading `/` and no other separators.
 */
export function isPackageName(name: string): boolean {
  return /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/.test(name);
}

/** Node's lookup: `<dir>/node_modules/<name>` from `from` up to the root, skipping node_modules dirs. */
export function resolvePackage(from: string, name: string): string | null {
  if (!isPackageName(name)) throw new Error(`not an npm package name: ${JSON.stringify(name)}`);
  let dir = from;
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const EXHIBIT_B = 'Incompatible With Secondary Licenses';

/** Files under a package (not nested node_modules) whose bytes carry Exhibit B, license files aside. */
function findExhibitB(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      compareCodeUnits(a.name, b.name),
    )) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (entry.isFile() && !LICENSE_FILE.test(entry.name)) {
        if (readFileSync(path).includes(EXHIBIT_B, 0, 'latin1')) found.push(relative(dir, path));
      }
    }
  };
  walk(dir);
  return found;
}

function textFiles(dir: string, pattern: RegExp): TextFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, text: normalizeText(readFileSync(join(dir, name), 'utf8')) }));
}

function repoText(repoRoot: string, path: string): TextFile {
  const full = join(repoRoot, path);
  return {
    name: path,
    text: existsSync(full) ? normalizeText(readFileSync(full, 'utf8')) : null,
  };
}

function isInstalled(dir: string): boolean {
  return dir.split(sep).includes('node_modules');
}

/** The hand-kept parts of the policy collect reads; tests pass their own. */
export interface ManualPolicy {
  manual: readonly ManualEntry[];
  packageTexts: Readonly<Record<string, { texts: readonly string[]; note: string }>>;
}

const POLICY: ManualPolicy = { manual: MANUAL_ENTRIES, packageTexts: PACKAGE_TEXTS };

/** Walks a target's closure and reads every text it needs. */
export function collect(
  repoRoot: string,
  target: Target,
  policy: ManualPolicy = POLICY,
): Collected {
  const packages = new Map<string, CollectedPackage>();
  const workspace = new Map<string, CollectedWorkspace>();
  const missing: Collected['missing'] = [];
  const invalid: Collected['invalid'] = [];
  const pruned = new Map<string, { package: string; dependency: string }>();
  const visited = new Set<string>();

  const visit = (dir: string, via: string) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    const manifest = readManifest(dir);
    const name = typeof manifest.name === 'string' ? manifest.name : basename(dir);
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    const id = `${name}@${version}`;
    const license = licenseOf(manifest);
    if (!isInstalled(dir)) {
      workspace.set(id, { name, dir: relative(repoRoot, dir), license });
    } else if (!packages.has(id)) {
      const override = policy.packageTexts[id];
      packages.set(id, {
        name,
        version,
        license,
        repository: repositoryOf(manifest.repository, manifest.homepage),
        via,
        licenseFiles: textFiles(dir, LICENSE_FILE),
        noticeFiles: textFiles(dir, NOTICE_FILE),
        manualTexts: override ? override.texts.map((p) => repoText(repoRoot, p)) : [],
        manualNote: override?.note ?? null,
        exhibitB: license && /MPL/i.test(license) ? findExhibitB(dir) : [],
      });
    }
    const rule = target.notShipped.find((r) => r.package === name);
    const deps: [string, boolean][] = [
      ...Object.keys(manifest.dependencies ?? {}).map((n): [string, boolean] => [n, false]),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((n): [string, boolean] => [n, true]),
    ];
    for (const [dep, optional] of deps.sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (!isPackageName(dep)) {
        invalid.push({ name: dep, from: id });
        continue;
      }
      if (rule && (rule.dependencies === '*' || rule.dependencies.includes(dep))) {
        pruned.set(`${name}>${dep}`, { package: name, dependency: dep });
        continue;
      }
      const resolved = resolvePackage(dir, dep);
      if (resolved) visit(resolved, id);
      else if (!optional) missing.push({ name: dep, from: id });
    }
  };

  for (const root of target.roots) visit(realpathSync(join(repoRoot, root)), 'root');

  const fonts: CollectedFont[] = [];
  for (const fontDir of target.fontDirs) {
    const full = join(repoRoot, fontDir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full).sort()) {
      if (!FONT_FILE.test(file)) continue;
      const bytes = readFileSync(join(full, file));
      fonts.push({
        path: `${fontDir}/${file}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }

  const byId = (a: { name: string; version?: string }, b: { name: string; version?: string }) =>
    compareCodeUnits(a.name, b.name) || compareCodeUnits(a.version ?? '', b.version ?? '');
  return {
    target,
    packages: [...packages.values()].sort(byId),
    workspace: [...workspace.values()].sort(byId),
    missing,
    invalid,
    pruned: [...pruned.values()],
    manual: policy.manual
      .filter((e) => e.targets.includes(target.name))
      .map((entry) => ({
        entry,
        texts: entry.texts.map((p) => repoText(repoRoot, p)),
      })),
    fonts,
  };
}
