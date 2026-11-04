import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRequire } from 'node:module';
import {
  InventoryContractError,
  inventoryErrorEnvelope,
} from './inventory-contract';

const localRequire = createRequire(__filename);
const express = createRequire(localRequire.resolve('@nestjs/platform-express'))(
  'express',
) as typeof import('express');

function isInventoryRoute(request: {
  method?: string;
  url?: string;
  originalUrl?: string;
}): boolean {
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
  return (
    request.method === 'POST' && /^\/inventory\/adjustments\/?$/i.test(path)
  );
}
function malformed(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response
    .status(400)
    .json(inventoryErrorEnvelope(new InventoryContractError('MALFORMED')));
}

/**
 * Rejects a member name that appears twice in the same JSON object (any
 * depth). Quoted tokens are matched first, so braces inside strings are inert.
 */
export function assertNoDuplicateMembers(raw: string): void {
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:]/g) ?? [];
  const scopes: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') scopes.push(new Set());
    else if (token === '}') scopes.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = scopes.at(-1);
      let key: string;
      try {
        key = JSON.parse(token) as string;
      } catch {
        throw new InventoryContractError('MALFORMED');
      }
      if (!keys || keys.has(key)) throw new InventoryContractError('MALFORMED');
      keys.add(key);
    }
  }
}

/**
 * Route-scoped JSON admission for `POST /inventory/adjustments`: AFTER CORS,
 * BEFORE Nest's default parsers mount. Malformed or duplicate-member bodies
 * leave as the `{statusCode, error}` envelope, never a framework body.
 */
export function installInventoryBodyParser(app: INestApplication): void {
  const json = express.json({
    strict: false,
    verify(_request, _response, buffer, encoding) {
      assertNoDuplicateMembers(buffer.toString(encoding as BufferEncoding));
    },
  });
  const scopedJson: RequestHandler = (request, response, next) => {
    if (!isInventoryRoute(request)) return next();
    json(request, response, next);
  };
  function scopedError(
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    if (!isInventoryRoute(request) || response.headersSent) {
      next(error);
      return;
    }
    malformed(response);
  }
  app.use(scopedJson);
  app.use(scopedError);
}
