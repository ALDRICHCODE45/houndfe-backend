import { CustomerKeySealer } from './customer-key-sealer';

const sealer = new CustomerKeySealer('unit-test-secret-of-some-length');
const T1 = 'tenant-1';
const KEY = '525512345678';

describe('CustomerKeySealer (R12: customerKey carries the phone)', () => {
  it('round-trips a customerKey and an unknown:<id> key', () => {
    for (const key of [KEY, 'unknown:6f1d3a2e-aaaa-4bbb-8ccc-1234567890ab']) {
      expect(sealer.open(T1, sealer.seal(T1, key))).toBe(key);
    }
  });

  it('is deterministic, so the same customer groups under one token', () => {
    expect(sealer.seal(T1, KEY)).toBe(sealer.seal(T1, KEY));
    expect(sealer.seal(T1, KEY)).not.toBe(sealer.seal(T1, '525512345679'));
  });

  it('hides the digits and is URL-safe', () => {
    const token = sealer.seal(T1, KEY);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(token).not.toContain('5512345678');
    expect(token).not.toContain(KEY);
    expect(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ).not.toContain('5512345678');
  });

  it('is bound to the tenant', () => {
    const token = sealer.seal(T1, KEY);
    expect(sealer.seal('tenant-2', KEY)).not.toBe(token);
    expect(sealer.open('tenant-2', token)).toBeNull();
  });

  it('rejects tampered, truncated and foreign tokens without throwing', () => {
    const token = sealer.seal(T1, KEY);
    const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const bad of [
      flipped,
      token.slice(0, 10),
      '',
      KEY,
      'k1.',
      'x'.repeat(80),
    ]) {
      expect(sealer.open(T1, bad)).toBeNull();
    }
    expect(
      new CustomerKeySealer('another-secret-of-some-length').open(T1, token),
    ).toBeNull();
  });

  it('refuses a short secret', () => {
    expect(() => new CustomerKeySealer('short')).toThrow();
  });
});
