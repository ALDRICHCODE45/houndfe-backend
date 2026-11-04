import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRequire } from 'node:module';
import {
  PurchaseOrderContractError,
  purchaseOrderErrorEnvelope,
} from './po-contract';

const localRequire = createRequire(__filename);
const express = createRequire(localRequire.resolve('@nestjs/platform-express'))(
  'express',
) as typeof import('express');

function isPurchaseOrderRoute(request: Request): boolean {
  const path = (request.originalUrl ?? request.url).split('?')[0];
  const collection = /^\/procurement\/purchase-orders\/?$/i.test(path);
  const detail = /^\/procurement\/purchase-orders\/[^/]+\/?$/i.test(path);
  const draft = /^\/procurement\/purchase-orders\/[^/]+\/draft\/?$/i.test(path);
  const transition =
    /^\/procurement\/purchase-orders\/[^/]+\/(?:confirm|cancel)\/?$/i.test(
      path,
    );
  return (
    ((request.method === 'GET' || request.method === 'HEAD') &&
      (collection || detail)) ||
    (request.method === 'POST' && (collection || transition)) ||
    (request.method === 'PUT' && draft) ||
    (request.method === 'DELETE' && detail)
  );
}
function isFlatBodyRoute(request: {
  method?: string;
  url?: string;
  originalUrl?: string;
}): boolean {
  if (request.method === 'DELETE') return true;
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
  return (
    request.method === 'POST' &&
    /^\/procurement\/purchase-orders\/[^/]+\/(?:confirm|cancel)\/?$/i.test(path)
  );
}
function malformed(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response
    .status(400)
    .json(
      purchaseOrderErrorEnvelope(new PurchaseOrderContractError('MALFORMED')),
    );
}

/** AFTER CORS, BEFORE Nest initialization, like the supplier-only parser.
 * Exact route/method gates preserve every other route's existing admission.
 * Flat bodies (DELETE, confirm, cancel) reject duplicate decoded member names
 * before JSON parsing.
 */
export function installPurchaseOrderBodyParser(app: INestApplication): void {
  const json = express.json({
    strict: false,
    verify(request, _response, buffer, encoding) {
      if (!isFlatBodyRoute(request)) return;
      const tokens =
        buffer
          .toString(encoding as BufferEncoding)
          .match(/"(?:\\.|[^"\\])*"|[{}:]/g) ?? [];
      const keys = new Set<string>();
      for (let i = 0; i < tokens.length - 1; i++) {
        if (!tokens[i].startsWith('"') || tokens[i + 1] !== ':') continue;
        let key: string;
        try {
          key = JSON.parse(tokens[i]) as string;
        } catch {
          throw new PurchaseOrderContractError('MALFORMED');
        }
        if (keys.has(key)) throw new PurchaseOrderContractError('MALFORMED');
        keys.add(key);
      }
    },
  });
  const form = express.urlencoded({ extended: true });
  const scopedJson: RequestHandler = (request, response, next) => {
    if (!isPurchaseOrderRoute(request)) return next();
    try {
      decodeURIComponent(request.path);
    } catch {
      malformed(response);
      return;
    }
    json(request, response, next);
  };
  const scopedForm: RequestHandler = (request, response, next) => {
    if (!isPurchaseOrderRoute(request)) return next();
    form(request, response, next);
  };
  function scopedError(
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    if (!isPurchaseOrderRoute(request) || response.headersSent) {
      next(error);
      return;
    }
    malformed(response);
  }
  app.use(scopedJson);
  app.use(scopedForm);
  app.use(scopedError);
}
