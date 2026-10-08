// Cold start on the shed: its own file, so its own fresh process (see cold.ts).
import { it } from 'vitest';
import { coldStart } from './cold';

it('cold start: shed', () => coldStart('shed'));
