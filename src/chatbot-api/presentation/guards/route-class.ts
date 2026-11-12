import { SetMetadata } from '@nestjs/common';

/**
 * Budget class of a bot route (R2, contract §10.1).
 *   - `default`: every chatbot-api route that existed before the
 *     human-intervention contract (catalog, checkout, receipts…); it keeps the
 *     credential's own `rateLimit` per minute.
 *   - `humanDecisions`: the bot-facing stock, expiration and delivery-zone
 *     routes (`/chatbot-api/human-decisions`, owner decision M1). Same budget
 *     as `default` (the credential's `rateLimit`), counted in its own bucket so
 *     the two never spend from each other.
 *   - `write`, `read`, `feed`: the new routes; a long-poll never spends from
 *     `write` or `read`.
 *   - `control` (unit 11, S16 1c): `session-ack` only. A tiny bucket of its
 *     own so a mirror burst (`write`) can never starve the mute/unmute
 *     confirmation the backend's 60 s revert waits for.
 */
export type BotRouteClassName =
  | 'default'
  | 'humanDecisions'
  | 'write'
  | 'read'
  | 'feed'
  | 'control';

/** Classes whose budget is the credential's own `rateLimit`. */
export const CREDENTIAL_LIMIT_CLASSES: readonly BotRouteClassName[] = [
  'default',
  'humanDecisions',
];

export const ROUTE_CLASS_KEY = 'bot_route_class';

export const BotRouteClass = (
  routeClass: Exclude<BotRouteClassName, 'default'>,
) => SetMetadata(ROUTE_CLASS_KEY, routeClass);
