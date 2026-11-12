/**
 * Route-scoped JSON limit of `POST /chatbot-api/conversations/:ref/messages:
 * batch` (human-intervention unit 9; contract §3.6, §6.4).
 *
 * THE BOUND the bot may rely on: the whole JSON body of one batch is at most
 * 3 MiB (3 145 728 bytes). A full batch is 50 messages of up to 4 096
 * characters (code points). Written as raw UTF-8 that is ~200 KB, but an encoder
 * that escapes non-ASCII as `\uXXXX` spends 6 bytes per BMP character and 12 per
 * astral one (an emoji is a surrogate pair), so the worst case is
 * 50 x 4 096 x 12 = 2 457 600 bytes plus ~100 bytes of fields per message: about
 * 2.5 MB. 3 MiB covers that with margin; anything larger is a 413.
 *
 * Express's default limit is 100 KB and its parser errors do not use the bot's
 * envelope (and a default error handler can echo a snippet of the body). Mount
 * it in `main.ts` BEFORE Nest's default parsers (same place as the other
 * `install*BodyParser` calls); only that exact method and path get the limit,
 * every other route keeps the default. Errors of this parser, on this route
 * only, answer `{statusCode, code, message}` with fixed texts: 413
 * `BODY_TOO_LARGE`, anything else (malformed JSON, unsupported charset,
 * aborted upload) 400 `VALIDATION_ERROR`. Nothing of the body or of the
 * parser's own message is ever echoed.
 */
import type { INestApplication } from '@nestjs/common';
import type { RequestHandler } from 'express';
import { createRequire } from 'node:module';

// `express` is not a direct dependency (pnpm): resolve it through
// @nestjs/platform-express, like the other route-scoped body parsers.
const localRequire = createRequire(__filename);
const express = createRequire(localRequire.resolve('@nestjs/platform-express'))(
  'express',
) as typeof import('express');

export const CONVERSATION_BATCH_BODY_BYTES = 3 * 1024 * 1024;
export const CONVERSATION_BATCH_BODY_LIMIT = CONVERSATION_BATCH_BODY_BYTES;

const BATCH_PATH = /^\/chatbot-api\/conversations\/[^/]+\/messages:batch\/?$/;

/** Same shape and wording as `ChatbotRequestHttpFilter` (the bot envelope). */
const ENVELOPE = {
  tooLarge: {
    statusCode: 413,
    code: 'BODY_TOO_LARGE',
    message: 'The request body is too large',
  },
  invalid: {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: 'Invalid request',
  },
} as const;

export function installConversationBatchBodyParser(
  app: INestApplication,
): void {
  const jsonParser = express.json({ limit: CONVERSATION_BATCH_BODY_BYTES });
  const scoped: RequestHandler = (request, response, next) => {
    // `app.use('/chatbot-api', …)` strips the mount point: rebuild the path.
    const path = `${request.baseUrl}${request.path}`;
    if (request.method !== 'POST' || !BATCH_PATH.test(path)) {
      next();
      return;
    }
    jsonParser(request, response, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      const tooLarge =
        typeof error === 'object' &&
        error !== null &&
        (error as { status?: unknown }).status === 413;
      const body = tooLarge ? ENVELOPE.tooLarge : ENVELOPE.invalid;
      response.setHeader('Cache-Control', 'no-store');
      response.status(body.statusCode).json(body);
    });
  };
  app.use('/chatbot-api', scoped);
}
