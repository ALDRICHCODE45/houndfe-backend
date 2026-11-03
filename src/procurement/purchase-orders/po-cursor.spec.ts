import { createHmac } from 'node:crypto';
import { PurchaseOrderCursor } from './po-cursor';

const scope = {
  tenantId: 'tenant-a',
  supplierId: '10000000-0000-4000-8000-000000000002',
};
const position = {
  createdAt: '2026-01-02T03:04:05.123Z',
  id: '10000000-0000-4000-8000-000000000001',
};
const cursor = new PurchaseOrderCursor('offline-only');

describe('pure purchase-order cursor', () => {
  it('roundtrips stable timestamp/id descending pagination positions', () => {
    expect(
      new PurchaseOrderCursor('offline-only').decode(
        cursor.encode(scope, position),
        scope,
      ),
    ).toEqual(position);
    expect(
      cursor.decode(cursor.encode({ tenantId: scope.tenantId }, position), {
        tenantId: scope.tenantId,
      }),
    ).toEqual(position);
  });
  it('rejects tenant, filter, resource, key and signature changes', () => {
    const encoded = cursor.encode(scope, position);
    for (const other of [
      { ...scope, tenantId: 'other' },
      { tenantId: scope.tenantId },
      { ...scope, supplierId: position.id },
    ])
      expect(() => cursor.decode(encoded, other)).toThrow('MALFORMED');
    expect(() =>
      new PurchaseOrderCursor('wrong').decode(encoded, scope),
    ).toThrow('MALFORMED');
    const [payload, signature] = encoded.split('.');
    expect(() =>
      cursor.decode(
        `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`,
        scope,
      ),
    ).toThrow('MALFORMED');
    const tuple = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown[];
    for (const invalid of [
      [2, ...tuple.slice(1)],
      [1, 'supplier-resource', ...tuple.slice(2)],
      [...tuple, 'extra'],
      [1, tuple[1], '2026-02-30T00:00:00.000Z', position.id],
      [1, tuple[1], position.createdAt, 'bad'],
    ]) {
      const value = Buffer.from(JSON.stringify(invalid)).toString('base64url');
      const mac = createHmac('sha256', 'offline-only')
        .update(`procurement-purchase-orders-cursor-v1\0${value}`)
        .digest('base64url');
      expect(() => cursor.decode(`${value}.${mac}`, scope)).toThrow(
        'MALFORMED',
      );
    }
  });
  it.each(['', 'abc', 'a.b.c', '😀', 'a'.repeat(1025)])(
    'rejects invalid wire encoding %#',
    (value) => {
      expect(() => cursor.decode(value, scope)).toThrow('MALFORMED');
    },
  );
  it.each([
    { ...position, id: 'bad' },
    { ...position, createdAt: '2026-02-30T00:00:00.000Z' },
  ])('does not issue invalid positions %#', (value) => {
    expect(() => cursor.encode(scope, value)).toThrow('MALFORMED');
  });
});
