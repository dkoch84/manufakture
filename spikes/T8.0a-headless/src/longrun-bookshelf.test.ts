// The long run on the bookshelf: its own file, so its own process (see longrun.ts).
import { it } from 'vitest';
import { longRun } from './longrun';

it('long run: bookshelf', () => longRun('bookshelf'));
