jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
}));
import { S3Client } from '@aws-sdk/client-s3';
import { PrivateMediaService } from './application/private-media.service';
import { createPrivateMediaService } from './private-media.factory';

const settings = {
  PRIVATE_MEDIA_ENDPOINT: 'https://private.invalid',
  PRIVATE_MEDIA_REGION: 'test',
  PRIVATE_MEDIA_BUCKET: 'private-test',
  PRIVATE_MEDIA_ACCESS_KEY_ID: 'synthetic',
  PRIVATE_MEDIA_SECRET_ACCESS_KEY: 'synthetic-only',
  PRIVATE_MEDIA_MAX_BYTES: 2,
};
const prisma = {} as Parameters<typeof createPrivateMediaService>[1];
beforeEach(() => jest.clearAllMocks());
test.each([
  undefined,
  {},
  { PRIVATE_MEDIA_BUCKET: 'partial' },
  { ...settings, PRIVATE_MEDIA_ENDPOINT: 'http://invalid.test' },
  { ...settings, PRIVATE_MEDIA_MAX_BYTES: 0 },
  {
    SPACES_ENDPOINT: 'https://public.invalid',
    SPACES_REGION: 'test',
    SPACES_BUCKET: 'public',
    SPACES_ACCESS_KEY_ID: 'synthetic',
    SPACES_SECRET_ACCESS_KEY: 'synthetic-only',
  },
])('disabled settings %p construct no SDK client or transport', (input) => {
  expect(createPrivateMediaService(input, prisma)).toBeNull();
  expect(S3Client).not.toHaveBeenCalled();
});
test('valid explicit settings compose the real service without I/O', () => {
  const snapshot = { ...settings };
  expect(createPrivateMediaService(settings, prisma)).toBeInstanceOf(
    PrivateMediaService,
  );
  expect(S3Client).toHaveBeenCalledTimes(1);
  expect(S3Client).toHaveBeenCalledWith({
    endpoint: settings.PRIVATE_MEDIA_ENDPOINT,
    region: 'test',
    credentials: {
      accessKeyId: 'synthetic',
      secretAccessKey: 'synthetic-only',
    },
    maxAttempts: 1,
  });
  const client = jest.mocked(S3Client).mock.results[0].value as {
    send: jest.Mock;
  };
  expect(client.send).not.toHaveBeenCalled();
  expect(settings).toEqual(snapshot);
});
