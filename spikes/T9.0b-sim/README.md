# spikes/T9.0b-sim: electromechanical rep simulation (T9.0b)

A prototype of the M9 plan's decision 6 ([docs/plans/m9.md](../../docs/plans/m9.md), "T9.0b"): a
lumped, deterministic, time-stepped model of a cable trainer. A prescribed rep (force, stroke,
speeds) goes through the cable, the spool, an optional reduction, a PMSM in dq (torque constant,
phase resistance and inductance, pole pairs, friction and iron loss), a controller (current and
voltage limits, fixed, conduction and switching losses), a pack (open-circuit voltage against state
of charge, internal resistance, charge acceptance) with a braking resistor on a chopper, and a
two-node thermal model of the motor. Every run keeps an energy ledger. The model is also built
from two published motor datasheets and compared with them. Findings are in
[docs/spikes/T9.0b-sim.md](../../docs/spikes/T9.0b-sim.md).

## Running

The spike has no `package.json` (so it adds nothing to the workspace or the lockfile) and no
dependencies beyond the repository's own Node and Vitest. From the repository root, after
`pnpm install`:

```bash
node spikes/T9.0b-sim/src/run.ts                              # every case, writes results/: about 6 s
node spikes/T9.0b-sim/src/run.ts trainer                      # one group: trainer, convergence, sensitivity, datasheets, series
node_modules/.bin/vitest run --root spikes/T9.0b-sim          # energy balance, closed forms, datasheet bounds: about 1 s
node_modules/.bin/tsc --noEmit -p spikes/T9.0b-sim            # typecheck
```

`run.ts` runs under Node 26's type stripping, so the sources use erasable TypeScript only
(`erasableSyntaxOnly` in `tsconfig.json`). Each group writes `results/<group>.json` with the machine
it ran on; `series` writes `results/rep-direct.csv`.

## Files

| File                     | What it is                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/model.ts`           | The model: parameter types, the theta-method time step (midpoint by default), the energy and thermal ledgers, peaks and limit flags              |
| `src/trainer.ts`         | The cable trainer's assumed parameters (direct drive and a 5:1 belt variant, the 16S pack) and its load cases (reps, hold, session)              |
| `src/datasheets.ts`      | The maxon EC 90 flat and FAULHABER 4221 BXT H datasheet values with sources, the model built from them, the comparison                           |
| `src/run.ts`             | Runs every case and writes the raw results                                                                                                       |
| `src/sim.test.ts`        | Closed forms (hold current F·r/(G·Kt), copper loss, work per pull, analytic two-node response, pack energy), ledger closure, step size           |
| `src/datasheets.test.ts` | The model's error against each datasheet winding stays within the bounds the write-up reports; the time-stepped bench settles on the closed form |

| Result                     | What it holds                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `results/trainer.json`     | Per machine: closed forms, 10 reps, 30 s hold, a session with ledgers, state-of-charge variants, sessions per charge, force sweep |
| `results/convergence.json` | 10 reps at every integrator, electrical mode and step size tried, against a 10 µs midpoint reference                              |
| `results/sensitivity.json` | Winding temperature after the hold and after 10 reps over a grid of winding heat capacity and thermal resistance                  |
| `results/datasheets.json`  | Every compared quantity per winding, and the speed and efficiency curves of model and datasheet                                   |
| `results/rep-direct.csv`   | One rep of the direct-drive trainer at 1 ms: position, speed, force, torque, current, powers, pack, temperatures                  |
