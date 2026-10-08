// The long run on the shed: its own file, so its own process (see longrun.ts).
import { it } from 'vitest';
import { longRun } from './longrun';

it('long run: shed', () => longRun('shed'));
