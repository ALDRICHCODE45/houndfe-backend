import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Request } from 'express';

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
