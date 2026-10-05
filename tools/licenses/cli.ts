// The license check and notices generator from the command line (ADR 0006 decision 5). Node runs
// it directly (type stripping), from the repository root:
//
//   node tools/licenses/cli.ts check                 # `pnpm licenses:check`, in CI
//   node tools/licenses/cli.ts write web <file>      # the notices the web build ships
//   node tools/licenses/cli.ts write server <file>   # the notices the server build ships
//
// `check` reads only the installed tree and the files in this repository: offline, deterministic.
// It exits 1 when any target has a problem.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { notices, type TargetName } from './index.ts';
import { TARGETS } from './policy.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function usage(): never {
  process.stderr.write('usage: cli.ts check | cli.ts write <web|server> <file>\n');
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);

if (command === 'check') {
  let failed = false;
  for (const target of TARGETS) {
    const n = notices(repoRoot, target.name);
    const c = n.collected;
    const summary =
      `${target.name}: ${c.packages.length} npm packages, ${c.manual.length} manual entries, ` +
      `${c.workspace.length} workspace packages, ${c.pruned.length} not-shipped dependencies skipped`;
    if (n.problems.length === 0) {
      process.stdout.write(`${summary}: ok\n`);
    } else {
      failed = true;
      process.stdout.write(`${summary}: ${n.problems.length} problems\n`);
      for (const p of n.problems) process.stdout.write(`  - ${p}\n`);
    }
  }
  process.exitCode = failed ? 1 : 0;
} else if (command === 'write') {
  const [name, file] = args;
  if (!TARGETS.some((t) => t.name === name) || !file) usage();
  const n = notices(repoRoot, name as TargetName);
  if (n.problems.length > 0) {
    for (const p of n.problems) process.stderr.write(`${p}\n`);
    process.exitCode = 1;
  } else {
    writeFileSync(file, n.text);
    process.stdout.write(`${file}: ${n.text.length} characters\n`);
  }
} else {
  usage();
}
