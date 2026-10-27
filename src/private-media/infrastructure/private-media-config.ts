import { PRIVATE_MEDIA_MAX_SIZE_BYTES } from '../domain/private-media';

/** Internal storage configuration only; never return it as public metadata. */
export interface PrivateMediaConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: Readonly<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
  readonly maxBytes: number;
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Resolve only injected private settings. Null means disabled, not public fallback. */
export function resolvePrivateMediaConfig(
  input: unknown,
): PrivateMediaConfig | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return null;
  const settings = input as Record<string, unknown>;
  const endpoint = settings.PRIVATE_MEDIA_ENDPOINT;
  const region = settings.PRIVATE_MEDIA_REGION;
  const bucket = settings.PRIVATE_MEDIA_BUCKET;
  const accessKeyId = settings.PRIVATE_MEDIA_ACCESS_KEY_ID;
  const secretAccessKey = settings.PRIVATE_MEDIA_SECRET_ACCESS_KEY;
  if (
    !nonblank(endpoint) ||
    !nonblank(region) ||
    !nonblank(bucket) ||
    !nonblank(accessKeyId) ||
    !nonblank(secretAccessKey)
  )
    return null;

  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      endpoint.includes('?') ||
      endpoint.includes('#') ||
      /^https:\/\/[^/]*@/i.test(endpoint)
    )
      return null;
  } catch {
    return null;
  }

  const suppliedCap = settings.PRIVATE_MEDIA_MAX_BYTES;
  let maxBytes = PRIVATE_MEDIA_MAX_SIZE_BYTES;
  if (suppliedCap !== undefined) {
    if (typeof suppliedCap !== 'number' && !nonblank(suppliedCap)) return null;
    maxBytes = Number(suppliedCap);
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > PRIVATE_MEDIA_MAX_SIZE_BYTES
    )
      return null;
  }

  return Object.freeze({
    endpoint,
    region,
    bucket,
    credentials: Object.freeze({ accessKeyId, secretAccessKey }),
    maxBytes,
  });
}
