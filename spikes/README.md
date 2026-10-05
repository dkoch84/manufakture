# Spikes

Code and raw results behind the write-ups in [`docs/spikes`](../docs/spikes). They are kept as a
record and are not part of the app.

The spikes are outside the pnpm workspace (`pnpm-workspace.yaml` lists only `apps/*` and
`packages/*`), so `pnpm install` (CI's included) installs none of their dependencies, and the root
`typecheck`, `lint` and `test` do not cover them.

To rerun a spike that has a `package.json`, add its folder to `pnpm-workspace.yaml` and install:

```yaml
packages:
  - apps/*
  - packages/*
  - spikes/clipper2
```

```sh
pnpm install
pnpm --filter @manufakture/spike-clipper2 test
```

Several spikes depend on workspace packages (`workspace:*`), so installing one on its own with
`--ignore-workspace` does not work for those. Remove the line again afterwards, and run
`pnpm install` once more so the lockfile goes back to what it was.

The spikes without a `package.json` (`hlr`, `opencamlib`) need nothing extra: they run with the
repository's own Vitest, as their READMEs describe.
