import { InventoryCursor } from './inventory-cursor';

const P = '10000000-0000-4000-8000-000000000001';
const V = '10000000-0000-4000-8000-000000000002';
const scope = { tenantId: 'tenant-a', productId: P };
const position = {
  createdAt: '2026-11-04T18:00:00.123Z',
  id: '10000000-0000-4000-8000-0000000000aa',
};
const cursor = new InventoryCursor('offline-only');

describe('inventory movement cursor', () => {
  it('roundtrips a (createdAt,id) position', () => {
    expect(cursor.decode(cursor.encode(scope, position), scope)).toEqual(
      position,
    );
    expect(
      new InventoryCursor('offline-only').decode(
        cursor.encode(scope, position),
        scope,
      ),
    ).toEqual(position);
  });

  it('is bound to tenant, product, variant and lot filters', () => {
    const encoded = cursor.encode({ ...scope, variantId: V }, position);
    for (const other of [
      scope,
      { ...scope, variantId: V, tenantId: 'tenant-b' },
      { ...scope, variantId: V, productId: V },
      { ...scope, lotId: V },
      { ...scope, variantId: P },
    ])
      expect(() => cursor.decode(encoded, other)).toThrow('MALFORMED');
    expect(cursor.decode(encoded, { ...scope, variantId: V })).toEqual(
      position,
    );
  });

  it('rejects another secret, tampering and garbage', () => {
    const encoded = cursor.encode(scope, position);
    expect(() => new InventoryCursor('other').decode(encoded, scope)).toThrow(
      'MALFORMED',
    );
    const [payload, signature] = encoded.split('.');
    expect(() => cursor.decode(`${payload}x.${signature}`, scope)).toThrow(
      'MALFORMED',
    );
    for (const bad of ['', 'abc', `${payload}.`, 'a.b', 'x'.repeat(2000)])
      expect(() => cursor.decode(bad, scope)).toThrow('MALFORMED');
  });

  it('refuses to encode a malformed position', () => {
    expect(() =>
      cursor.encode(scope, { createdAt: '2026-11-04', id: position.id }),
    ).toThrow('MALFORMED');
    expect(() =>
      cursor.encode(scope, { createdAt: position.createdAt, id: 'x' }),
    ).toThrow('MALFORMED');
  });
});
