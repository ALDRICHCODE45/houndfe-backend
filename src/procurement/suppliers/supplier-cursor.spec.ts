import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SupplierCursor } from './supplier-cursor';

const scope = { tenantId: 'tenant-a', status: 'ALL' as const, search: 'É_%\\' };
const position = {
  createdAt: '2026-01-02T03:04:05.123Z',
  id: '10000000-0000-4000-8000-000000000001',
};
const cursor = new SupplierCursor(
  new ConfigService({ JWT_SECRET: 'offline-only' }),
);
describe('supplier cursor', () => {
  it('roundtrips the exact timestamp and UUID, stable across instances', () => {
    const other = new SupplierCursor(
      new ConfigService({ JWT_SECRET: 'offline-only' }),
    );
    expect(other.decode(cursor.encode(scope, position), scope)).toEqual(
      position,
    );
  });
  it.each([
    { ...scope, tenantId: 'tenant-b' },
    { ...scope, status: 'ACTIVE' as const },
    { ...scope, search: 'é_%\\' },
    { ...scope, search: undefined },
  ])('rejects cross-scope cursors: %j', (different) => {
    expect(() =>
      cursor.decode(cursor.encode(scope, position), different),
    ).toThrow('MALFORMED');
  });
  it.each(['', 'abc', 'a.b.c', '😀', 'a'.repeat(4097)])(
    'rejects invalid encoding %s',
    (value) => {
      expect(() => cursor.decode(value, scope)).toThrow('MALFORMED');
    },
  );
  it('rejects tampering, wrong key and resource payload', () => {
    const encoded = cursor.encode(scope, position);
    const [payload, mac] = encoded.split('.');
    expect(() =>
      cursor.decode(
        `${payload}.${mac[0] === 'a' ? 'b' : 'a'}${mac.slice(1)}`,
        scope,
      ),
    ).toThrow('MALFORMED');
    const other = new SupplierCursor(
      new ConfigService({ JWT_SECRET: 'different' }),
    );
    expect(() => other.decode(encoded, scope)).toThrow('MALFORMED');
    expect(() =>
      cursor.decode(`${Buffer.from('{}').toString('base64url')}.${mac}`, scope),
    ).toThrow('MALFORMED');
  });
  it('rejects signed invalid versions, resource binding, tuple shape and ordering fields', () => {
    const [payload] = cursor.encode(scope, position).split('.');
    const valid = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown[];
    for (const tuple of [
      [2, ...valid.slice(1)],
      [1, 'another-resource-binding', ...valid.slice(2)],
      [...valid, 'extra'],
      [1, valid[1], '2026-02-30T00:00:00.000Z', valid[3]],
      [1, valid[1], valid[2], 'bad-uuid'],
    ]) {
      const encoded = Buffer.from(JSON.stringify(tuple)).toString('base64url');
      const signature = createHmac('sha256', 'offline-only')
        .update(`procurement-suppliers-cursor-v1\0${encoded}`)
        .digest('base64url');
      expect(() => cursor.decode(`${encoded}.${signature}`, scope)).toThrow(
        'MALFORMED',
      );
    }
  });
  it.each([
    { ...position, createdAt: '2026-02-30T00:00:00.000Z' },
    { ...position, createdAt: 'not-date' },
    { ...position, id: 'invalid' },
  ])('does not issue invalid positions %j', (invalid) => {
    expect(() => cursor.encode(scope, invalid)).toThrow('MALFORMED');
  });
});
