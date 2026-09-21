import {
  deriveAutomationServiceKey,
  hashApiKey,
  prefixApiKey,
} from '../../../scripts/provision-key-crypto';

describe('deriveAutomationServiceKey (TODO-021)', () => {
  it('is deterministic and ak_-prefixed', () => {
    const gw = 'ak_gateway_master_key_example_1234567890';
    const a = deriveAutomationServiceKey(gw);
    const b = deriveAutomationServiceKey(gw);
    expect(a).toBe(b);
    expect(a.startsWith('ak_')).toBe(true);
    expect(a.length).toBeGreaterThan('ak_'.length + 20);
  });

  it('differs from the gateway key', () => {
    const gw = 'ak_gateway_master_key_example_1234567890';
    expect(deriveAutomationServiceKey(gw)).not.toBe(gw);
  });

  it('hashApiKey/prefixApiKey stay stable for derived keys', () => {
    const key = deriveAutomationServiceKey('ak_test_gateway');
    expect(hashApiKey(key)).toMatch(/^[a-f0-9]{64}$/);
    expect(prefixApiKey(key)).toBe(key.slice(0, 11));
  });
});
