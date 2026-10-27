jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-s3')>(
    '@aws-sdk/client-s3',
  ),
  S3Client: jest.fn(() => ({ send: mockSend })),
}));
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { PrivateMediaAsset } from './domain/private-media';
import { createPrivateMediaService } from './private-media.factory';

const mockSend = jest.fn<Promise<unknown>, [unknown]>();
const context = { actorId: 'user', tenantId: 'tenant', productId: 'product' };
const settings = {
  PRIVATE_MEDIA_ENDPOINT: 'https://private.invalid',
  PRIVATE_MEDIA_REGION: 'test',
  PRIVATE_MEDIA_BUCKET: 'private-test',
  PRIVATE_MEDIA_ACCESS_KEY_ID: 'synthetic',
  PRIVATE_MEDIA_SECRET_ACCESS_KEY: 'synthetic-only',
  PRIVATE_MEDIA_MAX_BYTES: 2,
};
const bytes = Buffer.from([1, 2]);
const input = { mimeType: 'image/png', bytes };
const user = { findUnique: jest.fn() };
const tenantMembership = { findMany: jest.fn() };
const product = { findFirst: jest.fn() };
const query = jest.fn<
  Promise<unknown[]>,
  [TemplateStringsArray, ...unknown[]]
>();
let row: PrivateMediaAsset;
let object: Buffer;
let indeterminate: boolean;
let service: NonNullable<ReturnType<typeof createPrivateMediaService>>;
beforeEach(() => {
  jest.clearAllMocks();
  indeterminate = false;
  user.findUnique.mockResolvedValue({ isActive: true });
  tenantMembership.findMany.mockResolvedValue([
    {
      userId: 'user',
      tenantId: 'tenant',
      role: {
        permissions: ['read', 'update'].map((action) => ({
          permission: { subject: 'ProductEditorialDraft', action },
        })),
      },
    },
  ]);
  product.findFirst.mockResolvedValue({ id: 'product', tenantId: 'tenant' });
  query.mockImplementation(
    (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('').includes('INSERT')) {
        const [
          id,
          tenantId,
          productId,
          storageKey,
          mimeType,
          sizeBytes,
          createdAt,
        ] = values;
        row = {
          id,
          tenantId,
          productId,
          storageKey,
          mimeType,
          sizeBytes,
          createdAt,
        } as PrivateMediaAsset;
        return Promise.resolve(indeterminate ? [] : [{ ...row }]);
      }
      return Promise.resolve([{ ...row }]);
    },
  );
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      object = Buffer.from(command.input.Body as Buffer);
      return Promise.resolve({});
    }
    if (command instanceof GetObjectCommand)
      return Promise.resolve({
        Body: Readable.from([object]),
        ContentType: row.mimeType,
        ContentLength: object.length,
      });
    throw new Error('Unexpected storage command');
  });
  service = createPrivateMediaService(settings, {
    user,
    tenantMembership,
    product,
    $queryRaw: query,
  } as unknown as Parameters<typeof createPrivateMediaService>[1])!;
});
test('real composed upload/persist/read uses private commands and bound qualification', async () => {
  const metadata = await service.upload(context, input);
  expect(metadata).toEqual({
    id: row.id,
    tenantId: 'tenant',
    productId: 'product',
    mimeType: 'image/png',
    sizeBytes: 2,
    createdAt: row.createdAt,
  });
  expect(row.storageKey).toMatch(/^private-media\/[0-9a-f-]{36}$/);
  expect(mockSend.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
  expect((mockSend.mock.calls[0][0] as PutObjectCommand).input).toEqual({
    Bucket: 'private-test',
    Key: row.storageKey,
    Body: bytes,
    ContentType: 'image/png',
    ContentLength: 2,
    ACL: 'private',
  });
  expect(query.mock.calls[0].slice(1)).toEqual([
    row.id,
    'tenant',
    'product',
    row.storageKey,
    'image/png',
    2,
    row.createdAt,
  ]);
  expect(query.mock.calls[0][0].join('')).toBe(
    '\n        INSERT INTO private_media_assets\n' +
      '          (id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt")\n' +
      '        VALUES (, , , ,\n          , , )\n' +
      '        RETURNING id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt"',
  );
  expect(await service.read(context, row.id)).toEqual(bytes);
  expect(query.mock.calls[1].slice(1)).toEqual([row.id, 'tenant', 'product']);
  expect(query.mock.calls[1][0].join('')).toBe(
    '\n        SELECT id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt"\n' +
      '        FROM private_media_assets\n' +
      '        WHERE id =  AND "tenantId" = \n          AND "productId" = ',
  );
  expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
  expect((mockSend.mock.calls[1][0] as GetObjectCommand).input).toEqual({
    Bucket: 'private-test',
    Key: row.storageKey,
  });
  expect(product.findFirst).toHaveBeenNthCalledWith(2, {
    where: { id: 'product', tenantId: 'tenant' },
    select: { id: true, tenantId: true },
  });
  expect(user.findUnique).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(input.bytes).toEqual(Buffer.from([1, 2]));
});
test('injected size cap rejects before authority, SQL or storage', async () => {
  expect(
    await service.upload(context, { ...input, bytes: Buffer.alloc(3) }),
  ).toBeNull();
  expect(user.findUnique).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});
test('current revocation prevents any new Get and preserves persisted bytes', async () => {
  await service.upload(context, input);
  const snapshot = { ...row };
  tenantMembership.findMany.mockResolvedValue([]);
  expect(await service.read(context, row.id)).toBeNull();
  expect(user.findUnique).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(row).toEqual(snapshot);
  expect(object).toEqual(bytes);
});
test.each(['tenantId', 'productId'] as const)(
  'foreign %s qualification discloses nothing',
  async (field) => {
    await service.upload(context, input);
    const snapshot = { ...row };
    const foreign = { ...context, [field]: 'other' };
    expect(await service.read(foreign, row.id)).toBeNull();
    expect(query.mock.calls[1].slice(1)).toEqual([
      row.id,
      foreign.tenantId,
      foreign.productId,
    ]);
    expect(user.findUnique).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(row).toEqual(snapshot);
    expect(object).toEqual(bytes);
  },
);
test('indeterminate committed create preserves linkage/object without delete or retry', async () => {
  indeterminate = true;
  expect(await service.upload(context, input)).toBeNull();
  const snapshot = { ...row };
  expect(query).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(object).toEqual(bytes);
  expect(await service.read(context, row.id)).toEqual(bytes);
  expect(row).toEqual(snapshot);
  expect(query).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
});
test('storage read failure fails closed without delete or persistence changes', async () => {
  await service.upload(context, input);
  const snapshot = { ...row };
  mockSend.mockRejectedValueOnce(new Error('simulated transport failure'));
  expect(await service.read(context, row.id)).toBeNull();
  expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(2);
  expect(row).toEqual(snapshot);
  expect(object).toEqual(bytes);
});
