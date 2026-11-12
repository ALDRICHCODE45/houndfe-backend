/**
 * Route-scoped JSON limit of `POST /chatbot-api/conversations/:ref/messages:
 * batch` (human-intervention unit 9; contract §3.6, §6.4). A full batch is 50
 * messages of up to 4 096 characters (~200 KB of JSON); Express's default limit
 * is 100 KB, and its 413 does not carry the bot's error envelope. Mount it in
 * `main.ts` BEFORE Nest's default parsers (same place as the other
 * `install*BodyParser` calls); only that exact method and path get 1 MB, every
 * other route keeps the default.
 */
import type { INestApplication } from '@nestjs/common';
import express, { type RequestHandler } from 'express';

export const CONVERSATION_BATCH_BODY_LIMIT = '1mb';

const BATCH_PATH = /^\/chatbot-api\/conversations\/[^/]+\/messages:batch\/?$/;

export function installConversationBatchBodyParser(
  app: INestApplication,
): void {
  const jsonParser = express.json({ limit: CONVERSATION_BATCH_BODY_LIMIT });
  const scoped: RequestHandler = (request, response, next) => {
    // `app.use('/chatbot-api', …)` strips the mount point: rebuild the path.
    const path = `${request.baseUrl}${request.path}`;
    if (request.method !== 'POST' || !BATCH_PATH.test(path)) {
      next();
      return;
    }
    jsonParser(request, response, next);
  };
  app.use('/chatbot-api', scoped);
}
