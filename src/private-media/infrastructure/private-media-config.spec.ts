import { readFileSync } from 'node:fs';
import { PRIVATE_MEDIA_MAX_SIZE_BYTES } from '../domain/private-media';
import { resolvePrivateMediaConfig } from './private-media-config';

// Synthetic inputs only; no host configuration or provider is consulted.
const complete = () => ({
  PRIVATE_MEDIA_ENDPOINT: 'https://private-storage.example.invalid',
  PRIVATE_MEDIA_REGION: 'synthetic-region',
  PRIVATE_MEDIA_BUCKET: 'synthetic-private-bucket',
  PRIVATE_MEDIA_ACCESS_KEY_ID: 'synthetic-private-id',
  PRIVATE_MEDIA_SECRET_ACCESS_KEY: ' synthetic-private-secret ',
});
const required = Object.keys(complete());
const publicSettings = {
  SPACES_ENDPOINT: 'https://public-storage.example.invalid',
  SPACES_REGION: 'synthetic-public-region',
  SPACES_BUCKET: 'synthetic-public-bucket',
  SPACES_ACCESS_KEY_ID: 'synthetic-public-id',
  SPACES_SECRET_ACCESS_KEY: 'synthetic-public-secret',
};

describe('resolvePrivateMediaConfig', () => {
  it.each([undefined, null, false, 1, '', 'settings', [], () => ({})])(
    'disables absent or non-record input (%p)',
    (input) => expect(resolvePrivateMediaConfig(input)).toBeNull(),
  );

  it('disables empty and public-only settings', () => {
    expect(resolvePrivateMediaConfig({})).toBeNull();
    expect(resolvePrivateMediaConfig(publicSettings)).toBeNull();
  });

  describe.each(required)('%s', (key) => {
    it('is required even when public settings are complete', () => {
      const input: Record<string, unknown> = complete();
      delete input[key];
      expect(resolvePrivateMediaConfig(input)).toBeNull();
      expect(
        resolvePrivateMediaConfig({ ...publicSettings, ...input }),
      ).toBeNull();
    });

    it.each([undefined, null, 12, true, {}, [], '', ' \t\n '])(
      'rejects a wrong type or blank value (%p)',
      (value) => {
        expect(
          resolvePrivateMediaConfig({ ...complete(), [key]: value }),
        ).toBeNull();
      },
    );
  });

  it.each([
    'not a URL',
    'http://storage.example.invalid',
    'ftp://storage.example.invalid',
    'https://',
    'https://user@storage.example.invalid',
    'https://user:synthetic-secret@storage.example.invalid',
    'https://storage.example.invalid?token=synthetic',
    'https://storage.example.invalid#synthetic',
    'https://storage.example.invalid?',
    'https://storage.example.invalid#',
  ])('disables an invalid private endpoint (%s)', (endpoint) => {
    expect(
      resolvePrivateMediaConfig({
        ...complete(),
        PRIVATE_MEDIA_ENDPOINT: endpoint,
      }),
    ).toBeNull();
  });

  it.each([
    null,
    '',
    ' ',
    0,
    -1,
    1.5,
    '1.5',
    'abc',
    true,
    {},
    [],
    NaN,
    Infinity,
    PRIVATE_MEDIA_MAX_SIZE_BYTES + 1,
    String(PRIVATE_MEDIA_MAX_SIZE_BYTES + 1),
  ])('disables an invalid explicit byte cap (%p)', (maxBytes) =>
    expect(
      resolvePrivateMediaConfig({
        ...complete(),
        PRIVATE_MEDIA_MAX_BYTES: maxBytes,
      }),
    ).toBeNull(),
  );

  it.each([
    1,
    '1',
    4096,
    '4096',
    PRIVATE_MEDIA_MAX_SIZE_BYTES,
    String(PRIVATE_MEDIA_MAX_SIZE_BYTES),
  ])(
    'accepts a positive integer cap within the domain ceiling (%p)',
    (maxBytes) =>
      expect(
        resolvePrivateMediaConfig({
          ...complete(),
          PRIVATE_MEDIA_MAX_BYTES: maxBytes,
        })?.maxBytes,
      ).toBe(Number(maxBytes)),
  );

  it('selects only private fields and defaults to the domain ceiling', () => {
    const input = { ...publicSettings, ...complete(), unrelated: 'synthetic' };
    expect(resolvePrivateMediaConfig(input)).toEqual({
      endpoint: input.PRIVATE_MEDIA_ENDPOINT,
      region: input.PRIVATE_MEDIA_REGION,
      bucket: input.PRIVATE_MEDIA_BUCKET,
      credentials: {
        accessKeyId: input.PRIVATE_MEDIA_ACCESS_KEY_ID,
        secretAccessKey: input.PRIVATE_MEDIA_SECRET_ACCESS_KEY,
      },
      maxBytes: PRIVATE_MEDIA_MAX_SIZE_BYTES,
    });
  });

  it('returns detached, immutable config including unmodified internal secrets', () => {
    const input = complete();
    const config = resolvePrivateMediaConfig(input)!;
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.credentials)).toBe(true);
    input.PRIVATE_MEDIA_SECRET_ACCESS_KEY = 'synthetic-changed';
    expect(config.credentials.secretAccessKey).toBe(
      ' synthetic-private-secret ',
    );
    expect(Reflect.set(config, 'bucket', 'synthetic-changed')).toBe(false);
    expect(
      Reflect.set(config.credentials, 'accessKeyId', 'synthetic-changed'),
    ).toBe(false);
  });

  it('does not log valid or rejected inputs, including secrets', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
    );
    try {
      resolvePrivateMediaConfig(complete());
      resolvePrivateMediaConfig({ ...complete(), PRIVATE_MEDIA_REGION: null });
      spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('has only a pure domain import, no SDK/environment/network initialization', () => {
    const source = readFileSync(`${__dirname}/private-media-config.ts`, 'utf8');
    expect(source.match(/^import .*$/gm)).toEqual([
      "import { PRIVATE_MEDIA_MAX_SIZE_BYTES } from '../domain/private-media';",
    ]);
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/);
    expect(source).not.toMatch(
      /process\s*\.|dotenv|ConfigService|console\s*\.|fetch\s*\(|new\s+\w*Client/,
    );
  });
});
