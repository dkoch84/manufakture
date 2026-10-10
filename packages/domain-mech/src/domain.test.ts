import { ExtensionRegistry } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER_IS_PLACEHOLDER, DISCLAIMER_SHORT } from './disclaimer';
import { MECH_IMPLEMENTATION, mechDomain, registerMech } from './domain';
import { MECH_NAMESPACE } from './settings';

describe('the mechanical domain', () => {
  it('registers its namespace and the reader of its settings, once', () => {
    const registry = new ExtensionRegistry();
    const unregister = registerMech(registry);
    expect(mechDomain.namespace).toBe(MECH_NAMESPACE);
    expect(mechDomain.implementation).toBe(MECH_IMPLEMENTATION);
    expect(() => registerMech(registry)).toThrow(/already registered/);
    const reader = mechDomain.data![MECH_NAMESPACE]!;
    expect(reader.read({ factors: { strength: 2 } }, 1).ok).toBe(true);
    expect(reader.read({ factors: { strength: 'two' } }, 1).ok).toBe(false);
    unregister();
    expect(() => registerMech(registry)).not.toThrow();
  });

  it('carries the drafted notice, marked as a placeholder', () => {
    expect(DISCLAIMER_IS_PLACEHOLDER).toBe(true);
    expect(DISCLAIMER_SHORT).toBe(
      'manufakture calculates by the methods and inputs shown in each record; it does not certify a design as safe or compliant with any standard. Catalog data is typical and unverified unless marked. Have a qualified engineer review any machine that carries load or stores energy before building or using it. Provided without warranty under GPL-3.0-or-later.',
    );
    expect(DISCLAIMER_SHORT).not.toMatch(/[\u2013\u2014]/);
  });
});
