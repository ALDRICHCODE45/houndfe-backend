import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

/**
 * Response headers every route exposes to a cross-origin frontend
 * (customers-bulk-actions / T1, frontend L3.9): the CSV / ZIP filename.
 */
export const APP_EXPOSED_HEADERS = ['Content-Disposition'] as const;

/**
 * The app-wide CORS delegate used by `main.ts`: `editorialCors` with
 * `Content-Disposition` exposed. The origin and credentials options are passed
 * through untouched; editorial routes keep their own `exposedHeaders`.
 */
export function appCors(
  options: CorsOptions = {},
): CorsOptionsDelegate<Request> {
  return editorialCors({
    ...options,
    exposedHeaders: [...APP_EXPOSED_HEADERS],
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
