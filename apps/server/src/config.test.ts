import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { DEFAULT_LIMITS, TokenBucket, checkJsonShape } from './limits';

const TOKEN = 'a'.repeat(40);

describe('loadConfig', () => {
  it('reads the defaults and overrides', () => {
    const c = loadConfig({
      MANUFAKTURE_TOKEN: TOKEN,
      MANUFAKTURE_ORIGINS: 'https://cad.example.test, http://localhost:5173',
      MANUFAKTURE_MAX_ROWS_PER_CLIENT: '50',
    });
    expect(c).toMatchObject({
      token: TOKEN,
      host: '127.0.0.1',
      port: 8787,
      databasePath: 'manufakture.db',
      origins: ['https://cad.example.test', 'http://localhost:5173'],
      trustProxy: false,
    });
    expect(c.limits).toEqual({ ...DEFAULT_LIMITS, maxRowsPerClient: 50 });
  });

  it('refuses a missing or weak token, a bad origin and bad numbers', () => {
    expect(() => loadConfig({})).toThrow(/MANUFAKTURE_TOKEN/);
    expect(() => loadConfig({ MANUFAKTURE_TOKEN: 'short' })).toThrow(/MANUFAKTURE_TOKEN/);
    expect(() => loadConfig({ MANUFAKTURE_TOKEN: `${TOKEN} x` })).toThrow(/MANUFAKTURE_TOKEN/);
    expect(() => loadConfig({ MANUFAKTURE_TOKEN: TOKEN, MANUFAKTURE_ORIGINS: '*' })).toThrow(
      /MANUFAKTURE_ORIGINS/,
    );
    expect(() => loadConfig({ MANUFAKTURE_TOKEN: TOKEN, MANUFAKTURE_PORT: '70000' })).toThrow(
      /PORT/,
    );
    expect(() =>
      loadConfig({ MANUFAKTURE_TOKEN: TOKEN, MANUFAKTURE_MAX_JSON_DEPTH: '-1' }),
    ).toThrow(/MANUFAKTURE_MAX_JSON_DEPTH/);
    expect(() =>
      loadConfig({ MANUFAKTURE_TOKEN: TOKEN, MANUFAKTURE_ENTRIES_PER_MINUTE: '10' }),
    ).toThrow(/at least 1000/);
  });
});

describe('limits', () => {
  it('checks depth and size of JSON without recursion', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    expect(checkJsonShape(deep, 64, 1e9)).toMatchObject({ ok: false });
    expect(checkJsonShape(new Array(100).fill(1), 64, 50)).toMatchObject({ ok: false });
    expect(checkJsonShape({ a: [1, { b: 'c' }] }, 4, 10)).toEqual({ ok: true });
  });

  it('a token bucket refills over a minute', () => {
    let t = 0;
    const b = new TokenBucket(60, () => t);
    expect(b.take(60).ok).toBe(true);
    expect(b.take(1)).toEqual({ ok: false, retryAfterMs: 1000 });
    t += 1000;
    expect(b.take(1).ok).toBe(true);
  });
});
