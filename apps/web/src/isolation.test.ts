import { describe, expect, it, vi } from 'vitest';
import { isCrossOriginIsolated, logCrossOriginIsolation } from './isolation';

describe('isCrossOriginIsolated', () => {
  it('is true only when crossOriginIsolated is exactly true', () => {
    expect(isCrossOriginIsolated({ crossOriginIsolated: true })).toBe(true);
    expect(isCrossOriginIsolated({ crossOriginIsolated: false })).toBe(false);
    expect(isCrossOriginIsolated({})).toBe(false);
  });
});

describe('logCrossOriginIsolation', () => {
  it('logs info when isolated', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(logCrossOriginIsolation({ crossOriginIsolated: true }, logger)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('crossOriginIsolated: true');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when not isolated', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(logCrossOriginIsolation({ crossOriginIsolated: false }, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
