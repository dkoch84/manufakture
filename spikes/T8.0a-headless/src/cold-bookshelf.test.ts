// Cold start on the bookshelf: its own file, so its own fresh process (see cold.ts).
import { it } from 'vitest';
import { coldStart } from './cold';

it('cold start: bookshelf', () => coldStart('bookshelf'));
