/**
 * The real application graph compiles and the optional wrapper hook is
 * actually injected into the legacy flows (unit 3). Their own specs build
 * them without it, so this is the proof that production keeps wrapping.
 */
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import {
  PostgresRouteRateLimiter,
  ROUTE_RATE_LIMITER,
} from '../chatbot-api/presentation/guards/route-rate-limiter';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { ChatbotRequestsModule } from './chatbot-requests.module';
import { ReceiptUploadService } from '../receipts/application/receipt-upload.service';
import { ReceiptReviewService } from '../sales/review/receipt-review.service';
import { CHATBOT_REQUEST_RESOLVER } from './application/chatbot-request-commands.service';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('chatbot request wiring (real application graph)', () => {
  it('injects one wrapper into the flows and binds the resolver', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      const wrapper = moduleRef.get(ChatbotRequestWrapper, { strict: false });
      const wrapperOf = (target: object) =>
        (target as { wrapper?: ChatbotRequestWrapper }).wrapper;
      expect(
        wrapperOf(moduleRef.get(ReceiptUploadService, { strict: false })),
      ).toBe(wrapper);
      expect(
        wrapperOf(moduleRef.get(ReceiptReviewService, { strict: false })),
      ).toBe(wrapper);
      expect(
        moduleRef.get(CHATBOT_REQUEST_RESOLVER, { strict: false }),
      ).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  }, 60_000);

  // R2: the guard takes its limiter as an optional dependency, so a module
  // that cannot see the provider would silently fall back to per-process
  // counting. Every module that uses the guard must get the shared one.
  it('gives the bot guard of every module the shared PostgreSQL limiter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      const shared: unknown = moduleRef.get(ROUTE_RATE_LIMITER, {
        strict: false,
      });
      expect(shared).toBeInstanceOf(PostgresRouteRateLimiter);
      for (const module of [
        ChatbotApiModule,
        HumanDecisionsModule,
        ChatbotRequestsModule,
      ]) {
        const guard = moduleRef
          .select(module)
          .get(ServiceAuthGuard, { strict: false });
        expect(
          (guard as unknown as { sharedLimiter?: unknown }).sharedLimiter,
        ).toBe(shared);
      }
      expect(
        moduleRef.get(BotRequestsController, { strict: false }),
      ).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
