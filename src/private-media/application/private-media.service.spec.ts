import { PrivateMediaService } from './private-media.service';
import { PRIVATE_MEDIA_MAX_SIZE_BYTES } from '../domain/private-media';
import type { PrivateMediaAsset } from '../domain/private-media';

const context = () => ({
  actorId: 'actor',
  tenantId: 'tenant',
  productId: 'product',
});
const input = () => ({ mimeType: 'image/png', bytes: Buffer.from([1, 2]) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(maxBytes = 4) {
  const rows: PrivateMediaAsset[] = [];
  const access = { canUpload: jest.fn(() => Promise.resolve(true)) };
  const storage = { put: jest.fn(() => Promise.resolve()), remove: jest.fn() };
  const repository = {
    create: jest.fn(
      (asset: PrivateMediaAsset): Promise<PrivateMediaAsset | null> => {
        rows.push({ ...asset });
        return Promise.resolve({ ...asset, createdAt: new Date(1234) });
      },
    ),
    find: jest.fn(() => Promise.resolve(null)),
  };
  const config = { maxBytes };
  const service = new PrivateMediaService(access, storage, repository, config);
  const unchanged = () => {
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  };
  return { service, access, storage, repository, rows, config, unchanged };
}

describe('PrivateMediaService upload', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'persists %s after put',
    async (mimeType) => {
      const f = fixture();
      const result = await f.service.upload(context(), {
        ...input(),
        mimeType,
      });
      expect(f.access.canUpload).toHaveBeenCalledWith(context());
      const asset = f.repository.create.mock.calls[0][0];
      expect(asset).toEqual({
        id: expect.any(String),
        tenantId: 'tenant',
        productId: 'product',
        storageKey: expect.any(String),
        mimeType,
        sizeBytes: 2,
        createdAt: expect.any(Date),
      });
      expect(f.storage.put).toHaveBeenCalledWith(asset, Buffer.from([1, 2]));
      expect(result).toEqual({
        id: asset.id,
        tenantId: 'tenant',
        productId: 'product',
        mimeType,
        sizeBytes: 2,
        createdAt: new Date(1234),
      });
    },
  );

  it.each([1, 4])('accepts positive/configured boundary %i', async (length) => {
    const f = fixture();
    expect(
      await f.service.upload(context(), {
        ...input(),
        bytes: Buffer.alloc(length),
      }),
    ).not.toBeNull();
  });

  it.each([
    ['empty', { ...input(), bytes: Buffer.alloc(0) }],
    ['nonBuffer', { ...input(), bytes: new Uint8Array([1]) }],
    ['unsupported', { ...input(), mimeType: 'image/gif' }],
    ['over cap', { ...input(), bytes: Buffer.alloc(5) }],
  ])('rejects %s without effects', async (_name, value) => {
    const f = fixture();
    expect(
      await f.service.upload(context(), value as ReturnType<typeof input>),
    ).toBeNull();
    expect(f.access.canUpload).not.toHaveBeenCalled();
    f.unchanged();
  });

  it.each(['actorId', 'tenantId', 'productId'])(
    'rejects invalid %s without effects',
    async (field) => {
      for (const value of ['', ' ', null, 7]) {
        const f = fixture();
        expect(
          await f.service.upload({ ...context(), [field]: value }, input()),
        ).toBeNull();
        expect(f.access.canUpload).not.toHaveBeenCalled();
        f.unchanged();
      }
    },
  );

  it.each([false, 'throw'])(
    'fails closed on current authority %s',
    async (mode) => {
      const f = fixture();
      if (mode === false) f.access.canUpload.mockResolvedValue(false);
      else
        f.access.canUpload.mockRejectedValue(
          new Error('authority unavailable'),
        );
      expect(await f.service.upload(context(), input())).toBeNull();
      expect(f.access.canUpload).toHaveBeenCalledTimes(1);
      f.unchanged();
    },
  );

  it('awaits put before create and create before returning metadata', async () => {
    const f = fixture();
    const put = deferred<void>();
    const create = deferred<PrivateMediaAsset | null>();
    f.storage.put.mockReturnValue(put.promise);
    f.repository.create.mockReturnValue(create.promise);
    let settled = false;
    const attempt = f.service.upload(context(), input()).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.repository.create).not.toHaveBeenCalled();
    put.resolve();
    await Promise.resolve();
    expect(f.repository.create).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    create.resolve(f.repository.create.mock.calls[0][0]);
    expect(await attempt).not.toBeNull();
  });

  it('owns fresh opaque identities and strips storage location from persisted output', async () => {
    const f = fixture();
    const supplied = {
      ...input(),
      id: 'client-id',
      storageKey: 'existing-key',
    };
    for (let i = 0; i < 2; i++) {
      const result = await f.service.upload(context(), supplied);
      const asset = f.rows[i];
      expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(asset.storageKey).toMatch(/^private-media\/[0-9a-f-]{36}$/);
      expect(result).not.toHaveProperty('storageKey');
      expect(result).not.toHaveProperty('publicURL');
      expect(asset.id).not.toBe(supplied.id);
      expect(asset.storageKey).not.toBe(supplied.storageKey);
    }
    expect(f.rows[0].id).not.toBe(f.rows[1].id);
    expect(f.rows[0].storageKey).not.toBe(f.rows[1].storageKey);
  });

  it('does not create linkage or delete on put failure', async () => {
    const f = fixture();
    f.storage.put.mockRejectedValue(new Error('put failed'));
    expect(await f.service.upload(context(), input())).toBeNull();
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.repository.create).not.toHaveBeenCalled();
    expect(f.storage.remove).not.toHaveBeenCalled();
    expect(f.rows).toEqual([]);
  });

  it.each(['null', 'throw'])(
    'never deletes after indeterminate post-write create %s',
    async (mode) => {
      const f = fixture();
      f.repository.create.mockImplementation((asset) => {
        f.rows.push({ ...asset });
        return mode === 'throw'
          ? Promise.reject(new Error('response lost after commit'))
          : Promise.resolve(null);
      });
      expect(await f.service.upload(context(), input())).toBeNull();
      expect(f.rows).toHaveLength(1);
      expect(f.storage.put).toHaveBeenCalledTimes(1);
      expect(f.repository.create).toHaveBeenCalledTimes(1);
      expect(f.repository.find).not.toHaveBeenCalled();
      expect(f.storage.remove).not.toHaveBeenCalled();
    },
  );

  it('snapshots scope, MIME, bytes and configured cap before pending authority', async () => {
    const f = fixture();
    const authority = deferred<boolean>();
    f.access.canUpload.mockReturnValue(authority.promise);
    const scope = context();
    const upload = input();
    const attempt = f.service.upload(scope, upload);
    Object.assign(scope, {
      actorId: 'other',
      tenantId: 'foreign',
      productId: 'other',
    });
    upload.mimeType = 'image/webp';
    upload.bytes.fill(9);
    upload.bytes = Buffer.alloc(20);
    f.config.maxBytes = 1;
    authority.resolve(true);
    const result = await attempt;
    expect(f.access.canUpload).toHaveBeenCalledWith(context());
    expect(f.storage.put).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant',
        productId: 'product',
        mimeType: 'image/png',
        sizeBytes: 2,
      }),
      Buffer.from([1, 2]),
    );
    expect(result).toEqual(
      expect.objectContaining({
        tenantId: 'tenant',
        productId: 'product',
        mimeType: 'image/png',
        sizeBytes: 2,
      }),
    );
  });

  it.each([0, -1, 1.5, NaN, PRIVATE_MEDIA_MAX_SIZE_BYTES + 1])(
    'rejects invalid configured cap %s without effects',
    (maxBytes) => {
      const f = fixture();
      expect(
        () =>
          new PrivateMediaService(f.access, f.storage, f.repository, {
            maxBytes,
          }),
      ).toThrow('Invalid private media size limit');
      expect(f.access.canUpload).not.toHaveBeenCalled();
      f.unchanged();
    },
  );
});
