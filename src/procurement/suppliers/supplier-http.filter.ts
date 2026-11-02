import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRequire } from 'node:module';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import {
  SupplierContractError,
  supplierErrorEnvelope,
} from './supplier-contract';

@Catch()
export class SupplierHttpFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    let error = exception;
    if (exception instanceof InsufficientPermissionsError)
      error = new SupplierContractError('FORBIDDEN');
    else if (exception instanceof HttpException) {
      const codes = {
        400: 'MALFORMED',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
      } as const;
      const status = exception.getStatus();
      const code = Object.hasOwn(codes, status)
        ? codes[status as keyof typeof codes]
        : 'INTERNAL_ERROR';
      error = new SupplierContractError(code);
    }
    const body = supplierErrorEnvelope(error);
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(body.statusCode).json(body);
  }
}

// Resolve the existing transitive Express dependency through Nest's adapter;
// no dependency mutation and no pnpm-store layout assumptions.
const localRequire = createRequire(__filename);
const express = createRequire(localRequire.resolve('@nestjs/platform-express'))(
  'express',
) as typeof import('express');

function isSupplierRoute(request: Request): boolean {
  const path = (request.originalUrl ?? request.url).split('?')[0];
  const collection = /^\/procurement\/suppliers\/?$/i.test(path);
  const detail = /^\/procurement\/suppliers\/[^/]+\/?$/i.test(path);
  return (
    ((request.method === 'GET' || request.method === 'HEAD') &&
      (collection || detail)) ||
    (request.method === 'POST' && collection) ||
    (request.method === 'PATCH' && detail)
  );
}
function malformed(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response
    .status(400)
    .json(supplierErrorEnvelope(new SupplierContractError('MALFORMED')));
}

/** Install AFTER CORS and BEFORE Nest init/listen. Root-mounted wrappers gate
 * exact methods/paths (Express case-insensitive and optional trailing slash),
 * not nearby siblings. Do not name them jsonParser/urlencodedParser: Nest uses
 * those names to detect globally installed parsers. Strict=false lets the pure
 * supplier parser reject primitives; syntax/size/encoding errors stay closed.
 * Parser failures precede guards, like Nest's default parsing, and never admit
 * a command. CORS headers already present are preserved.
 */
export function installSupplierBodyParser(app: INestApplication): void {
  const json = express.json({ strict: false });
  const form = express.urlencoded({ extended: true });
  const scopedJson: RequestHandler = (request, response, next) => {
    if (!isSupplierRoute(request)) return next();
    // Express would otherwise reject a malformed encoded parameter outside the
    // controller-filter boundary. Keep that path failure value-free as well.
    try {
      decodeURIComponent(request.path);
    } catch {
      malformed(response);
      return;
    }
    json(request, response, next);
  };
  const scopedForm: RequestHandler = (request, response, next) => {
    if (!isSupplierRoute(request)) return next();
    form(request, response, next);
  };
  function scopedError(
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    if (!isSupplierRoute(request) || response.headersSent) {
      next(error);
      return;
    }
    // Supplier vocabulary has no 413. All transport admission failures are 400.
    malformed(response);
  }
  app.use(scopedJson);
  app.use(scopedForm);
  app.use(scopedError);
}
