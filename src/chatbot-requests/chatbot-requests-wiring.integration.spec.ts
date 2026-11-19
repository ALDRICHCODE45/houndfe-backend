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
      // Every guard instance Nest built for a controller, per host module
      // (the one that actually runs on a request), not just one of them.
      const container = (
        moduleRef as unknown as {
          container: {
            getModules(): Map<
              string,
              {
                metatype: { name: string };
                injectables: Map<
                  unknown,
                  { metatype: unknown; instance: unknown }
                >;
              }
            >;
          };
        }
      ).container;
      const hostsOfGuard = new Map<string, unknown[]>();
      for (const host of container.getModules().values()) {
        for (const wrapper of host.injectables.values()) {
          if (wrapper.metatype === ServiceAuthGuard) {
            const list = hostsOfGuard.get(host.metatype.name) ?? [];
            list.push(wrapper.instance);
            hostsOfGuard.set(host.metatype.name, list);
          }
        }
      }
      expect([...hostsOfGuard.keys()]).toEqual(
        expect.arrayContaining([
          HumanDecisionsModule.name,
          ChatbotApiModule.name,
          ChatbotRequestsModule.name,
        ]),
      );
      for (const guards of hostsOfGuard.values()) {
        for (const guard of guards) {
          expect((guard as { sharedLimiter?: unknown }).sharedLimiter).toBe(
            shared,
          );
        }
      }
      expect(
        moduleRef.get(BotRequestsController, { strict: false }),
      ).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
