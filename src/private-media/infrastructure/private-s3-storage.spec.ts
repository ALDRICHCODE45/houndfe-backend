jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
  DeleteObjectCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { PrivateS3Storage } from './private-s3-storage';
import { PrivateMediaConfig } from './private-media-config';

const mockSend = jest.fn();
const config: PrivateMediaConfig = {
  endpoint: 'https://private.invalid',
  region: 'test-region',
  bucket: 'private-test',
  credentials: {
    accessKeyId: 'synthetic-id',
    secretAccessKey: 'synthetic-secret',
  },
  maxBytes: 4,
};
const metadata = {
  storageKey: 'new-attempt/key',
  mimeType: 'image/png' as const,
  sizeBytes: 3,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
});

test('put sends only exact private command and snapshots caller bytes', async () => {
  const storage = new PrivateS3Storage(config);
  const bytes = Buffer.from('abc');
  const pending = storage.put(metadata, bytes);
  bytes.fill(0);
  await expect(pending).resolves.toBeUndefined();
  expect(S3Client).toHaveBeenCalledWith({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    maxAttempts: 1,
  });
  expect(PutObjectCommand).toHaveBeenCalledWith({
    Bucket: config.bucket,
    Key: metadata.storageKey,
    ACL: 'private',
    ContentType: 'image/png',
    ContentLength: 3,
    Body: Buffer.from('abc'),
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
  'uploads %s',
  async (mimeType) => {
    await expect(
      new PrivateS3Storage(config).put(
        { ...metadata, mimeType },
        Buffer.from('abc'),
      ),
    ).resolves.toBeUndefined();
  },
);

test.each([1, config.maxBytes])(
  'uploads valid size boundary %i',
  async (sizeBytes) => {
    await expect(
      new PrivateS3Storage(config).put(
        { ...metadata, sizeBytes },
        Buffer.alloc(sizeBytes),
      ),
    ).resolves.toBeUndefined();
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ ContentLength: sizeBytes }),
    );
  },
);

test.each([
  { ...metadata, sizeBytes: 0 },
  { ...metadata, sizeBytes: -1 },
  { ...metadata, sizeBytes: 1.5 },
  { ...metadata, sizeBytes: 5 },
  { ...metadata, storageKey: '' },
  { ...metadata, mimeType: 'text/plain' },
])('rejects invalid metadata before commands: %j', async (invalid) => {
  await expect(
    new PrivateS3Storage(config).put(
      invalid as typeof metadata,
      Buffer.from('abc'),
    ),
  ).rejects.toThrow();
  await expect(
    new PrivateS3Storage(config).read(invalid as typeof metadata),
  ).rejects.toThrow();
  expect(PutObjectCommand).not.toHaveBeenCalled();
  expect(GetObjectCommand).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test.each([Buffer.alloc(0), Buffer.from('ab'), Buffer.from('abcde'), 'abc'])(
  'rejects actual byte mismatch before commands: %j',
  async (bytes) => {
    await expect(
      new PrivateS3Storage(config).put(metadata, bytes as Buffer),
    ).rejects.toThrow();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  },
);

test.each([
  undefined,
  {},
  { ...config, endpoint: 'http://private.invalid' },
  { ...config, bucket: '' },
  { ...config, region: '' },
  { ...config, credentials: undefined },
  { ...config, maxBytes: undefined },
  { ...config, maxBytes: 0 },
  { ...config, maxBytes: 10485761 },
])('invalid explicit config never constructs SDK: %j', (invalid) => {
  expect(() => new PrivateS3Storage(invalid as PrivateMediaConfig)).toThrow();
  expect(S3Client).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

function stream(chunks: unknown[]) {
  const body = Readable.from(chunks);
  const destroy = jest.spyOn(body, 'destroy');
  return { body, destroy };
}

test('bounded read uses exact persisted key and returns complete bytes', async () => {
  mockSend.mockResolvedValue({
    Body: stream([Buffer.from('a'), new Uint8Array([98, 99])]).body,
    ContentType: metadata.mimeType,
    ContentLength: 3,
  });
  const bytes = await new PrivateS3Storage(config).read(metadata);
  expect(Buffer.isBuffer(bytes)).toBe(true);
  expect(bytes).toEqual(Buffer.from('abc'));
  expect(GetObjectCommand).toHaveBeenCalledWith({
    Bucket: config.bucket,
    Key: metadata.storageKey,
  });
});

test('missing optional headers still checks actual bytes', async () => {
  mockSend.mockResolvedValue({ Body: stream([Buffer.from('abc')]).body });
  await expect(new PrivateS3Storage(config).read(metadata)).resolves.toEqual(
    Buffer.from('abc'),
  );
});

test.each([
  { ContentLength: 2 },
  { ContentLength: 4 },
  { ContentType: 'image/jpeg' },
  { ContentRange: 'bytes 0-2/10' },
])('rejects mismatched response headers: %j', async (headers) => {
  const { body, destroy } = stream([Buffer.from('abc')]);
  mockSend.mockResolvedValue({ Body: body, ...headers });
  await expect(new PrivateS3Storage(config).read(metadata)).rejects.toThrow();
  expect(destroy).toHaveBeenCalled();
});

test.each([
  { chunks: [] },
  { chunks: [Buffer.from('ab')] },
  { chunks: [Buffer.from('ab'), Buffer.from('cd')] },
  { chunks: [Buffer.alloc(5)] },
  { chunks: ['abc'] },
  { chunks: [42] },
])(
  'rejects invalid actual body without partial bytes: %j',
  async ({ chunks }) => {
    const { body, destroy } = stream(chunks);
    mockSend.mockResolvedValue({ Body: body });
    await expect(new PrivateS3Storage(config).read(metadata)).rejects.toThrow();
    expect(destroy).toHaveBeenCalled();
  },
);

test.each([undefined, {}, { transformToByteArray: jest.fn() }])(
  'rejects unsupported bodies without unbounded transforms',
  async (Body) => {
    mockSend.mockResolvedValue({ Body });
    await expect(new PrivateS3Storage(config).read(metadata)).rejects.toThrow();
    if (Body && 'transformToByteArray' in Body)
      expect(Body.transformToByteArray).not.toHaveBeenCalled();
  },
);

test('stream error after a chunk preserves failure and destroys body', async () => {
  const failure = new Error('synthetic stream failure');
  const body = Readable.from(
    (function* () {
      yield Buffer.from('a');
      throw failure;
    })(),
  );
  const destroy = jest.spyOn(body, 'destroy');
  mockSend.mockResolvedValue({ Body: body });
  await expect(new PrivateS3Storage(config).read(metadata)).rejects.toBe(
    failure,
  );
  expect(destroy).toHaveBeenCalled();
  expect(DeleteObjectCommand).not.toHaveBeenCalled();
});

test('snapshots key, MIME and size before pending Get', async () => {
  let complete!: (value: unknown) => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const mutable = { ...metadata };
  const pending = new PrivateS3Storage(config).read(mutable);
  Object.assign(mutable, {
    storageKey: 'changed',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
  });
  complete({
    Body: stream([Buffer.from('abc')]).body,
    ContentType: metadata.mimeType,
    ContentLength: metadata.sizeBytes,
  });
  await expect(pending).resolves.toEqual(Buffer.from('abc'));
  expect(GetObjectCommand).toHaveBeenCalledWith({
    Bucket: config.bucket,
    Key: metadata.storageKey,
  });
});

test('remove sends only exact known key, rejects empty keys', async () => {
  const storage = new PrivateS3Storage(config);
  await expect(storage.remove('new-attempt/key')).resolves.toBeUndefined();
  expect(DeleteObjectCommand).toHaveBeenCalledWith({
    Bucket: config.bucket,
    Key: 'new-attempt/key',
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  await expect(storage.remove(' ')).rejects.toThrow();
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('SDK failures propagate unchanged with no automatic delete or retry', async () => {
  const failure = new Error('synthetic SDK failure');
  mockSend.mockRejectedValue(failure);
  const storage = new PrivateS3Storage(config);
  await expect(storage.put(metadata, Buffer.from('abc'))).rejects.toBe(failure);
  await expect(storage.read(metadata)).rejects.toBe(failure);
  expect(DeleteObjectCommand).not.toHaveBeenCalled();
  await expect(storage.remove(metadata.storageKey)).rejects.toBe(failure);
  expect(mockSend).toHaveBeenCalledTimes(3);
});
