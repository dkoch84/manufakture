import { describe, expect, it } from 'vitest';

describe('test setup', () => {
  it('provides a working in-memory localStorage', () => {
    localStorage.setItem('a', '1');
    expect(localStorage.getItem('a')).toBe('1');
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('a');
    localStorage.removeItem('a');
    expect(localStorage.getItem('a')).toBeNull();
    localStorage.setItem('left-over', 'x');
  });

  it('isolates storage between tests', () => {
    expect(localStorage.length).toBe(0);
  });
});
