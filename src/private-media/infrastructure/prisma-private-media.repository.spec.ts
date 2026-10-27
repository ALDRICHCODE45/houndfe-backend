import { PrismaPrivateMediaRepository } from './prisma-private-media.repository';
import { PRIVATE_MEDIA_MAX_SIZE_BYTES } from '../domain/private-media';
const asset = {
  id: "asset'",
  tenantId: 'tenant',
  productId: 'product',
  storageKey: 'private/key',
  mimeType: 'image/png' as const,
  sizeBytes: 1,
  createdAt: new Date('2026-10-26'),
};
const query = jest.fn();
const repository = new PrismaPrivateMediaRepository({ $queryRaw: query });
beforeEach(() => {
  query.mockReset().mockResolvedValue([{ ...asset }]);
});
test('creates and finds validated metadata using bound values, not caller SQL', async () => {
  expect(await repository.create(asset)).toEqual(asset);
  expect(await repository.find(asset)).toEqual(asset);
  for (const [sql, ...values] of query.mock.calls) {
    expect((sql as TemplateStringsArray).join('')).not.toContain(asset.id);
    expect(values).toContain(asset.id);
    expect(values).toContain(asset.tenantId);
    expect(values).toContain(asset.productId);
  }
});
test.each([
  { id: '' },
  { tenantId: ' ' },
  { productId: null },
  { storageKey: '' },
  { createdAt: new Date(NaN) },
  { createdAt: '2026-10-26' },
  { mimeType: 'image/gif' },
  { sizeBytes: 0 },
  { sizeBytes: -1 },
  { sizeBytes: 1.5 },
  { sizeBytes: PRIVATE_MEDIA_MAX_SIZE_BYTES + 1 },
])('invalid metadata makes no write: %p', async (change) => {
  expect(await repository.create({ ...asset, ...change } as never)).toBeNull();
  expect(query).not.toHaveBeenCalled();
});
test.each([{ id: '' }, { tenantId: null }, { productId: ' ' }])(
  'invalid scope makes no query: %p',
  async (change) => {
    expect(await repository.find({ ...asset, ...change } as never)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  },
);
test.each([
  null,
  {},
  [],
  [asset, asset],
  [{ ...asset, id: 'other' }],
  [{ ...asset, tenantId: 'other' }],
  [{ ...asset, productId: 'other' }],
  [{ ...asset, sizeBytes: '1' }],
  [{ ...asset, mimeType: 'text/plain' }],
  [{ ...asset, createdAt: null }],
  [{ ...asset, createdAt: new Date(NaN) }],
  [{ ...asset, sizeBytes: 0 }],
  [{ ...asset, storageKey: '' }],
])('malformed/foreign rows fail closed: %p', async (rows) => {
  query.mockResolvedValue(rows);
  expect(await repository.find(asset)).toBeNull();
  expect(await repository.create(asset)).toBeNull();
});
test.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
  'admits %s and rejects substituted create metadata',
  async (mimeType) => {
    const input = { ...asset, mimeType };
    query.mockResolvedValue([input]);
    expect(await repository.create(input)).toEqual(input);
    query.mockResolvedValue([{ ...input, storageKey: 'substituted' }]);
    expect(await repository.create(input)).toBeNull();
  },
);
test('null inputs fail closed without queries', async () => {
  expect(await repository.create(null as never)).toBeNull();
  expect(await repository.find(null as never)).toBeNull();
  expect(query).not.toHaveBeenCalled();
});
test('inclusive ceiling and dependency failure', async () => {
  const maximum = { ...asset, sizeBytes: PRIVATE_MEDIA_MAX_SIZE_BYTES };
  query.mockResolvedValue([maximum]);
  expect(await repository.create(maximum)).toEqual(maximum);
  query.mockRejectedValue(new Error('offline'));
  expect(await repository.create(asset)).toBeNull();
  expect(await repository.find(asset)).toBeNull();
});
