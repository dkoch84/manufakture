// Cold start on the bracket: its own file, so its own fresh process (see cold.ts).
import { it } from 'vitest';
import { coldStart } from './cold';

it('cold start: bracket', () => coldStart('bracket'));
