/**
 * HD-04d2a — route-scoped, sanitizing body parser for `/human-decisions`.
 *
 * WHY THIS HELPER EXISTS
 * Nest (v11, Express adapter) registers its default `json`/`urlencoded` body
 * parsers during `NestApplication.init()`, BEFORE any route or controller
 * scoped exception filter can run. When a request body cannot be parsed —
 * invalid JSON syntax, a JSON primitive under the default `strict` mode, or a
 * URL-encoded body that exceeds the parser limits — the parser calls
 * `next(err)` and the error reaches Nest's router-level default handler, which
 * answers `BadRequestException(err.message)`. That message can carry a snippet
 * of the raw request body, and NO controller-scoped filter
 * (`HumanDecisionHttpFilter`) can intercept it because the request never
 * reaches the router.
 *
 * This helper installs a NARROW, path-scoped parser pipeline for
 * `/human-decisions` (the human reviewer read + resolve routes). The bot route
 * at `/chatbot-api/human-decisions` and every other route keep Nest's default
 * behavior untouched:
 *
 *   - `express.json({ strict: false })` accepts JSON primitives so the exact
 *     pure parser (`parseResolveHumanDecisionRequest`) — not the transport —
 *     produces the sanitized 400.
 *   - `express.urlencoded({ extended: true })` mirrors Nest's default limits
 *     for the form/AJAX content type.
 *   - a four-argument Express error handler sits IMMEDIATELY after both
 *     parsers and answers a FIXED, value-free envelope for any parser failure
 *     (syntax errors, invalid content, oversized bodies, parser range errors).
 *
 * ORDER AND NO DOUBLE PARSING
 * `installHumanDecisionBodyParser` must be called BEFORE `app.init()` (which
 * is the first thing `app.listen()` does), so these layers are mounted ahead
 * of Nest's default parsers. Express runs matching middleware in registration
 * order; the scoped parser consumes the request stream and body-parser then
 * short-circuits the later default parser for the same request. The wrappers
 * are deliberately NOT named `jsonParser` / `urlencodedParser`: Nest's
 * `isMiddlewareApplied` matches a global parser by that exact handle name, and
 * an unrenamed route-scoped parser would make Nest SKIP installing the global
 * defaults app-wide, silently disabling body parsing for every other route.
 *
 * AUTH NOTE
 * Body parsing is transport-level and always runs before guards — the same is
 * true of Nest's default parsers. A MALFORMED body therefore answers 400
 * before authentication; a VALID body is still handed to the exact guard
 * chain, so a successful parse never bypasses auth.
 *
 * SCOPE: this file only adds the path-scoped parser + sanitizing error handler.
 * It does not widen the global JSON policy, the bot route, CORS, auth or any
 * global filter.
 */
import { HttpStatus, type INestApplication } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRequire } from 'node:module';

/** The path prefix this narrow parser pipeline owns. */
const SCOPED_PATH = '/human-decisions';

/**
 * The bot terminal-ACK route is a SINGLE POST under the shared
 * `chatbot-api/human-decisions` prefix. The scoped parser is mounted on that
 * prefix and matched internally with a method+path check on `originalUrl`, so
 * the sibling bot `POST /chatbot-api/human-decisions` intake and
 * `GET /chatbot-api/human-decisions/:id` poll keep Nest's default parser
 * behavior untouched. `originalUrl` is used instead of `url`/`path` because
 * Express strips the mount prefix from `req.url` inside `app.use(path, ...)`.
 *
 * ROUTING-EQUIVALENCE (the gate MUST mirror the router, or a malformed body on
 * an equivalent URL bypasses the sanitizer and reaches Nest's default parser):
 * Express defaults — `case sensitive routing = false` and
 * `strict routing = false`, neither changed by Nest or `main.ts` — make the ACK
 * route reachable through case variants and a single trailing `/`. The pattern
 * is therefore case-insensitive (`/i`) and allows exactly one optional trailing
 * `/`. It still requires exactly ONE id segment and the exact
 * `application-outcome` terminal, so sibling intake/poll paths, other verbs and
 * nearby suffixes (`application-outcome-typo`) are never matched.
 */
const BOT_ACK_SCOPED_PREFIX = '/chatbot-api/human-decisions';
const BOT_ACK_METHOD = 'POST';
const BOT_ACK_PATH_PATTERN =
  /^\/chatbot-api\/human-decisions\/[^/]+\/application-outcome\/?$/i;

/** True only for `POST /chatbot-api/human-decisions/:id/application-outcome`. */
function isBotApplicationOutcomeRequest(request: Request): boolean {
  if (request.method !== BOT_ACK_METHOD) {
    return false;
  }

  const originalUrl = request.originalUrl ?? request.url ?? '';
  const pathname = originalUrl.split('?')[0];

  return BOT_ACK_PATH_PATTERN.test(pathname);
}

const DEFAULT_PARSE_ERROR_STATUS = HttpStatus.BAD_REQUEST;

/**
 * Fixed, value-free envelopes keyed by the status a parser failure maps to.
 * Nothing here is derived from the error, so a raw body snippet, upstream
 * message or nested payload can never leak through this transport handler.
 * `413` keeps its status but reuses the global filter's `REQUEST_ERROR`
 * vocabulary; every other parser failure collapses to the contract
 * `VALIDATION_ERROR` / `Invalid request`.
 */
const FIXED_ERROR_BODIES: Record<number, { code: string; message: string }> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request',
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: 'REQUEST_ERROR',
    message: 'Request failed',
  },
};

/**
 * `express` is a transitive dependency of `@nestjs/platform-express`, so under
 * pnpm's strict layout it is not resolvable from this package by bare name.
 * Resolve it THROUGH the platform package instead of adding a dependency or
 * reaching into `.pnpm` internals directly.
 */
const platformRequire = createRequire(__filename);
const platformExpressEntry = platformRequire.resolve(
  '@nestjs/platform-express',
);
const express = createRequire(platformExpressEntry)(
  'express',
) as typeof import('express');

/** Map a body-parser failure to its preserved status (413) or a safe 400. */
function resolveParseErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = candidate.status ?? candidate.statusCode;
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      return HttpStatus.PAYLOAD_TOO_LARGE;
    }
  }

  return DEFAULT_PARSE_ERROR_STATUS;
}

/**
 * Write the fixed, value-free envelope for a parser failure. Nothing is
 * derived from the error, so a raw body snippet, upstream message or nested
 * payload can never leak through this transport handler.
 */
function sendFixedParseError(error: unknown, response: Response): void {
  const statusCode = resolveParseErrorStatus(error);
  const fixed =
    FIXED_ERROR_BODIES[statusCode] ??
    FIXED_ERROR_BODIES[DEFAULT_PARSE_ERROR_STATUS];

  response.status(statusCode).json({
    statusCode,
    code: fixed.code,
    message: fixed.message,
  });
}

/**
 * Four-argument Express error handler placed right after the scoped parsers.
 * It only ever sees failures from those preceding parsers; router/guard and
 * filter errors happen further down the stack and never reach it.
 */
function humanDecisionBodyParseErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }

  sendFixedParseError(error, response);
}

/**
 * Four-argument Express error handler for the bot ACK parser. It is mounted on
 * the shared bot prefix, so it re-checks the exact method+path before
 * answering and otherwise forwards the error unchanged, keeping every sibling
 * bot route on Nest's default behavior.
 */
function botApplicationOutcomeBodyParseErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!isBotApplicationOutcomeRequest(request) || response.headersSent) {
    next(error);
    return;
  }

  sendFixedParseError(error, response);
}

/**
 * Mount the sanitizing, path-scoped body parsers on the underlying Express
 * instance. Call this AFTER `NestFactory.create(...)` / `createNestApplication()`
 * and BEFORE `app.init()` / `app.listen()`.
 */
export function installHumanDecisionBodyParser(app: INestApplication): void {
  const jsonParser = express.json({ strict: false });
  const urlencodedParser = express.urlencoded({ extended: true });

  // Named wrappers keep Nest's `jsonParser`/`urlencodedParser` detection from
  // matching these route-scoped layers and disabling the defaults app-wide.
  const scopedJsonParser: RequestHandler = (request, response, next) =>
    jsonParser(request, response, next);
  const scopedUrlencodedParser: RequestHandler = (request, response, next) =>
    urlencodedParser(request, response, next);

  app.use(SCOPED_PATH, scopedJsonParser);
  app.use(SCOPED_PATH, scopedUrlencodedParser);
  app.use(SCOPED_PATH, humanDecisionBodyParseErrorHandler);
}

/**
 * Mount the sanitizing, route-scoped body parsers for the bot terminal-ACK
 * route ONLY: `POST /chatbot-api/human-decisions/:id/application-outcome`.
 *
 * Why this is separate from `installHumanDecisionBodyParser`: the bot ACK body
 * is validated by the exact pure parser `parseBotApplicationOutcomeRequest`,
 * but Nest's default `json` parser (`strict: true`, registered during
 * `init()`) would reject a JSON primitive or echo a raw body snippet on a
 * malformed body BEFORE any controller-scoped filter can run. This helper
 * mirrors the human-decision pipeline for exactly ONE method+path pair:
 *
 *   - `express.json({ strict: false })` + `express.urlencoded({ extended:
 *     true })` accept the transport form and defer the exact shape to the pure
 *     parser.
 *   - a four-argument error handler, gated by the SAME method+path check,
 *     answers a FIXED value-free 400/413 envelope for any parser failure.
 *
 * The wrappers only run the parsers when the request matches; every other
 * route under the shared prefix (the bot POST intake, the GET poll) calls
 * `next()` WITHOUT consuming the stream, so Nest's default parsers handle it
 * exactly as before. The layers are mounted on the shared prefix (matched
 * case-insensitively by Express's default routing, which Nest does not change)
 * and gated internally, so their handle names never collide with Nest's
 * `jsonParser`/`urlencodedParser` detection.
 *
 * Call this AFTER `enableCors` and BEFORE `app.init()` / `app.listen()`,
 * mirroring `main.ts`, so a malformed-body short-circuit still carries the
 * allowlisted CORS header.
 */
export function installBotApplicationOutcomeBodyParser(
  app: INestApplication,
): void {
  const jsonParser = express.json({ strict: false });
  const urlencodedParser = express.urlencoded({ extended: true });

  const scopedJsonParser: RequestHandler = (request, response, next) => {
    if (!isBotApplicationOutcomeRequest(request)) {
      next();
      return;
    }

    jsonParser(request, response, next);
  };
  const scopedUrlencodedParser: RequestHandler = (request, response, next) => {
    if (!isBotApplicationOutcomeRequest(request)) {
      next();
      return;
    }

    urlencodedParser(request, response, next);
  };

  app.use(BOT_ACK_SCOPED_PREFIX, scopedJsonParser);
  app.use(BOT_ACK_SCOPED_PREFIX, scopedUrlencodedParser);
  app.use(BOT_ACK_SCOPED_PREFIX, botApplicationOutcomeBodyParseErrorHandler);
}
