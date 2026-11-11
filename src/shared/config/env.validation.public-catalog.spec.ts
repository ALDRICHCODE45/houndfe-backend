/**
 * Public catalog v0 — PUBLIC_BOT_WHATSAPP (S5) and PUBLIC_STORE_URL (S6).
 * Both optional at boot; a present but malformed value fails boot.
 */
import { buildEnvValidationSchema } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_REGION: 'nyc3',
  SPACES_BUCKET: 'bucket',
  SPACES_ACCESS_KEY_ID: 'aki',
  SPACES_SECRET_ACCESS_KEY: 'sak',
  SPACES_PUBLIC_BASE_URL: 'https://bucket.nyc3.cdn.digitaloceanspaces.com',
  NODE_ENV: 'test',
};

const validate = (extra: Record<string, string>) =>
  buildEnvValidationSchema().validate(
    { ...base, ...extra },
    { abortEarly: false, allowUnknown: true },
  );

describe('PUBLIC_BOT_WHATSAPP', () => {
  it('is optional: absent and empty both validate', () => {
    expect(validate({}).error).toBeUndefined();
    expect(validate({ PUBLIC_BOT_WHATSAPP: '' }).error).toBeUndefined();
  });

  it.each(['+5215512345678', '+14155552671', '+442071838750'])(
    'accepts the E.164 number %s',
    (value) => {
      const result = validate({ PUBLIC_BOT_WHATSAPP: value });
      expect(result.error).toBeUndefined();
      expect(
        (result.value as Record<string, unknown>).PUBLIC_BOT_WHATSAPP,
      ).toBe(value);
    },
  );

  it.each([
    '5215512345678', // no plus
    '+0215512345678', // country code cannot start with 0
    '+52 155 1234 5678', // spaces
    '+52-155-1234-5678', // dashes
    '+1', // too short
    '+12345678901234567', // more than 15 digits
    'whatsapp:+5215512345678',
    '+52abc',
  ])('rejects %s at boot', (value) => {
    const { error } = validate({ PUBLIC_BOT_WHATSAPP: value });
    expect(error?.message).toContain('PUBLIC_BOT_WHATSAPP');
  });
});

describe('PUBLIC_STORE_URL', () => {
  it('is optional at boot (the share route answers 503 when it is unset)', () => {
    expect(validate({}).error).toBeUndefined();
    expect(validate({ PUBLIC_STORE_URL: '' }).error).toBeUndefined();
  });

  it.each([
    'https://sistem.houndfe.com/catalogo',
    'https://sistem.houndfe.com/catalogo/',
    'http://localhost:4173/catalogo',
  ])('accepts %s', (value) => {
    expect(validate({ PUBLIC_STORE_URL: value }).error).toBeUndefined();
  });

  it.each([
    'sistem.houndfe.com/catalogo',
    'javascript:alert(1)',
    'ftp://sistem.houndfe.com/catalogo',
    'not a url',
    'https://sistem.houndfe.com/catalogo?x=1',
    'https://sistem.houndfe.com/catalogo#frag',
  ])('rejects %s at boot', (value) => {
    const { error } = validate({ PUBLIC_STORE_URL: value });
    expect(error?.message).toContain('PUBLIC_STORE_URL');
  });
});
