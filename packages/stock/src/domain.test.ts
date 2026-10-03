import { ExtensionRegistry } from '@manufakture/regen/extensions';
import { describe, expect, it } from 'vitest';
import { registerStock, stockDomain } from './domain';
import { STOCK_DATA_VERSION, STOCK_NAMESPACE } from './stock-data';

const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

describe('the stock registration (ADR 0015 decision 1)', () => {
  it('is a data-only domain owning `stock`', () => {
    expect(stockDomain.namespace).toBe('stock');
    expect(stockDomain.types).toBeUndefined();
    expect(Object.keys(stockDomain.data!)).toEqual([STOCK_NAMESPACE]);
    expect(stockDomain.data![STOCK_NAMESPACE]!.schemaVersion).toBe(STOCK_DATA_VERSION);
  });

  it('registers once, however often it is called, and reads `domains.stock`', () => {
    const registry = new ExtensionRegistry();
    const off = registerStock(registry);
    registerStock(registry);
    expect(registry.namespaces).toEqual(['stock']);
    const reader = registry.reader('stock')!;
    expect(reader.read({ overrides: { 'us-2x4': { width: mm('90mm') } } }, 1)).toMatchObject({
      ok: true,
    });
    expect(reader.read({ overrides: { 'us-2x4': { width: mm('#w') } } }, 1)).toMatchObject({
      ok: false,
      field: ['overrides', 'us-2x4', 'width'],
    });
    off();
    expect(registry.reader('stock')).toBeUndefined();
  });

  it('leaves `stock` alone when another domain already owns it', () => {
    const registry = new ExtensionRegistry();
    registry.registerDomain({
      namespace: 'other',
      implementation: 1,
      data: { stock: { schemaVersion: 1, read: (d) => ({ ok: true, value: d }) } },
    });
    const off = registerStock(registry);
    expect(registry.namespaces).toEqual(['other']);
    off();
    expect(registry.reader('stock')).toBeDefined();
  });
});
