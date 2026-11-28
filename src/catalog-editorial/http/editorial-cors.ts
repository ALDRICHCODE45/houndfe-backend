import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

/**
 * Response headers every route exposes to a cross-origin frontend
 * (customers-bulk-actions / T1, frontend L3.9): the CSV / ZIP filename and
 * the `429 BULK_EXPORT_BUSY` back-off.
 */
export const APP_EXPOSED_HEADERS = [
  'Content-Disposition',
  'Retry-After',
] as const;

/** Caller headers first, then the app ones; case-insensitive dedupe. */
function mergeExposedHeaders(caller: CorsOptions['exposedHeaders']): string[] {
  const list =
    typeof caller === 'string' ? caller.split(',') : [...(caller ?? [])];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const header of [...list, ...APP_EXPOSED_HEADERS]) {
    const name = header.trim();
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    merged.push(name);
  }
  return merged;
}

/**
 * The app-wide CORS delegate used by `main.ts`: `editorialCors` with
 * `Content-Disposition` and `Retry-After` exposed, merged with any caller `exposedHeaders`
 * (string or array). The origin and credentials options are passed through
 * untouched; editorial routes keep their own `exposedHeaders`.
 */
export function appCors(
  options: CorsOptions = {},
): CorsOptionsDelegate<Request> {
  return editorialCors({
    ...options,
    exposedHeaders: mergeExposedHeaders(options.exposedHeaders),
  });
}

/** Preserve deployment origin policy and unrelated routes' default reflection. */
export function editorialCors(
  options: CorsOptions = {},
): CorsOptionsDelegate<Request> {
  return (request, callback) => {
    const method =
      request.method === 'OPTIONS'
        ? request.get('Access-Control-Request-Method')
        : request.method;
    const path = request.originalUrl.split('?')[0];
    const editorial =
      ((method === 'GET' || method === 'HEAD') &&
        /^\/(?:catalog-editorial\/vocabulary|products\/[^/]+\/editorial(?:\/context|\/draft\/readiness)?)\/?$/i.test(
          path,
        )) ||
      (method === 'PUT' &&
        /^\/products\/[^/]+\/editorial\/draft\/?$/i.test(path)) ||
      (method === 'POST' &&
        (/^\/products\/[^/]+\/editorial\/draft\/(?:initialize|publish|discard)\/?$/i.test(
          path,
        ) ||
          /^\/products\/[^/]+\/editorial\/published\/unpublish\/?$/i.test(
            path,
          )));
    callback(
      null,
      editorial
        ? {
            ...options,
            allowedHeaders: [
              'Authorization',
              'Content-Type',
              'Cache-Control',
              'Pragma',
              'Editorial-Vocabulary-Revision',
              'Idempotency-Key',
              'Editorial-Care-Confirmation',
            ],
            exposedHeaders: [
              'Editorial-Contract-Version',
              'Editorial-Vocabulary-Revision',
            ],
          }
        : options,
    );
  };
}
