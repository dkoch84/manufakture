# spikes/T7.0b-sync: rebase and id remap on core (T7.0b)

Proves [ADR 0009](../../docs/adr/0009-sync-model.md) on real commands before a server is built:
an in-memory server that orders entries and validates them with core's `applyCommand`, two to five
simulated clients whose pending queues rebase by replay, a first structural id remap over every
counter scope core has today, and a seeded generator of random command streams run concurrently
with random delivery orders. Findings are in
[docs/spikes/T7.0b-sync.md](../../docs/spikes/T7.0b-sync.md).

## Running

From the repository root, after `pnpm install`:

```bash
pnpm --filter @manufakture/spike-sync sim         # every scenario x 20 seeds + the rebase bench, about 2.5 min
pnpm --filter @manufakture/spike-sync test        # names, remap and a short run of five scenarios, about 1 s
pnpm --filter @manufakture/spike-sync typecheck
```

Or in this folder: `node scripts/run.ts` and `../../node_modules/.bin/vitest run`.

`sim` bundles `src/main.ts` for Node with Vite (core's sources need its resolver), prints Markdown
tables and writes `results/sync.json` with the machine it ran on. Every run is reproducible from
its seed. Knobs (environment): `SEEDS=n` (default 20), `ONLY=two-busy,offline` (scenarios),
`PARTS=sim` or `PARTS=bench`, `BENCH_RUNS=n` (default 5, the median is reported). A partial run
writes `results/sync-<parts>.json` instead.

The spike's tests are not part of the root `vitest run` (its projects do not include `spikes/`),
like the other spikes'.

## Layout

```
src/scopes.ts     counter scopes, fresh id ranges from counter diffs, regressions
src/names.ts      face-name and body-id rewriter (recursive descent over the naming grammar)
src/remap.ts      structural remap over commands and documents, with a context resolver
src/protocol.ts   sync entry, verdicts, broadcasts
src/server.ts     ordering, de-duplication, predecessor rules, core validation, guards, invariants
src/client.ts     confirmed document, queue, rebase by replay with one simultaneous rename table
src/generator.ts  random commands over every M1 feature kind and the other scopes
src/intent.ts     id-free signatures in item names, checked on the converged document
src/sim.ts        event queue, network (latency, loss, ordering, offline), one run
src/scenarios.ts  the scenarios of the write-up
src/bench.ts      rebase cost for 10, 100 and 1000 pending commands
src/fixtures.ts   the M1 bracket (core's v15 golden) and a 200-feature part
src/main.ts       the harness; scripts/run.ts bundles and starts it
```
