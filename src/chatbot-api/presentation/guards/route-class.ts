import { SetMetadata } from '@nestjs/common';

/**
 * Budget class of a bot route (R2, contract §10.1). `default` is every route
 * that existed before the human-intervention contract: it keeps the
 * credential's own `rateLimit` per minute. The new routes pick `write`, `read`
 * or `feed`; a long-poll never spends from `write` or `read`.
 */
export type BotRouteClassName = 'default' | 'write' | 'read' | 'feed';

export const ROUTE_CLASS_KEY = 'bot_route_class';

export const BotRouteClass = (
  routeClass: Exclude<BotRouteClassName, 'default'>,
) => SetMetadata(ROUTE_CLASS_KEY, routeClass);
