import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../../shared/prisma/prisma.module';
import {
  PostgresRouteRateLimiter,
  ROUTE_RATE_LIMITER,
} from './route-rate-limiter';

/**
 * Global on purpose: `ServiceAuthGuard` is instantiated in the module of each
 * controller that uses it (chatbot-api, human-decisions, chatbot-requests),
 * and its limiter is an optional dependency. A module-local provider would
 * leave the guards of the other modules on the per-process fallback without
 * any error.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: ROUTE_RATE_LIMITER, useClass: PostgresRouteRateLimiter },
  ],
  exports: [ROUTE_RATE_LIMITER],
})
export class BotRateLimitModule {}
