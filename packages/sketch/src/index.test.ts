import { describe, expect, it } from 'vitest';
import { packageName } from './index';

describe('@manufakture/sketch', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@manufakture/sketch');
  });
});
