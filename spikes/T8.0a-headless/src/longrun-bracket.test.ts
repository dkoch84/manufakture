// The long run on the bracket: its own file, so its own process (see longrun.ts).
import { it } from 'vitest';
import { longRun } from './longrun';

it('long run: bracket', () => longRun('bracket'));
