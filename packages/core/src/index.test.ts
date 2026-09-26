import { describe, expect, it } from 'vitest';
import { packageName } from './index';

describe('@manufakture/core', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@manufakture/core');
  });
});
