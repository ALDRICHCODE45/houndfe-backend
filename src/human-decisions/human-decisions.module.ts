/**
 * HD-03b2 — HumanDecisionsModule.
 *
 * Wires the bot RESTOCK intake route without touching the existing chatbot
 * API. Imports:
 *   - `ChatbotApiModule` for the exported `ServiceAuthGuard` and its
 *     `SERVICE_CREDENTIAL_REPOSITORY` binding (plus the CLS context the guard
 *     populates).
 *   - `DatabaseModule` for the Prisma-backed intake/read adapters.
 *   - `AuthModule` (HD-04d1) for the `JwtAuthGuard`,
 *     `CaslAbilityFactory` and `PermissionsGuard` the human reviewer
 *     controller declares. `TenantContextGuard` is instantiated by Nest and
 *     injects the globally-provided `ClsService`.
 *
 * Binds the `RESTOCK_INTAKE_REPOSITORY` port to the Prisma intake adapter, the
 * `HUMAN_DECISION_REVIEW_READ_REPOSITORY` port to the Prisma read adapter and
 * (HD-04d2a) the `HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY` port to the Prisma
 * resolve adapter consumed by the guarded `POST /human-decisions/:id/resolve`
 * route. It registers the scoped filter so `@UseFilters(HumanDecisionHttpFilter)`
 * can be resolved from this module's injector.
 *
 * HD-05c registers `BotRestockPollController` and binds the
 * `BOT_RESTOCK_POLL_REPOSITORY` port to `PrismaBotRestockPollRepository`, so
 * `GET /chatbot-api/human-decisions/:id` serves the bot's tenant-scoped
 * CURRENT-state poll alongside the untouched bot `POST` intake.
 *
 * HD-05c2a registers `BotApplicationOutcomeController` and binds the
 * `BOT_APPLICATION_OUTCOME_REPOSITORY` port to
 * `PrismaBotApplicationOutcomeRepository`, so
 * `POST /chatbot-api/human-decisions/:id/application-outcome` serves the
 * tenant-scoped terminal ACK without disturbing the intake/poll bindings.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { BOT_APPLICATION_OUTCOME_REPOSITORY } from './domain/bot-application-outcome.repository';
import { BOT_RESTOCK_POLL_REPOSITORY } from './domain/bot-restock-poll.repository';
import { HUMAN_DECISION_REVIEW_READ_REPOSITORY } from './domain/human-decision-review-read.repository';
import { HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY } from './domain/human-decision-review-resolve.repository';
import { RESTOCK_INTAKE_REPOSITORY } from './domain/restock-intake.repository';
import { PrismaBotApplicationOutcomeRepository } from './infrastructure/prisma-bot-application-outcome.repository';
import { PrismaBotRestockPollRepository } from './infrastructure/prisma-bot-restock-poll.repository';
import { PrismaHumanDecisionReviewReadRepository } from './infrastructure/prisma-human-decision-review-read.repository';
import { PrismaHumanDecisionReviewResolveRepository } from './infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from './infrastructure/prisma-restock-intake.repository';
import { BotApplicationOutcomeController } from './presentation/bot-application-outcome.controller';
import { BotRestockIntakeController } from './presentation/bot-restock-intake.controller';
import { BotRestockPollController } from './presentation/bot-restock-poll.controller';
import { HumanDecisionHttpFilter } from './presentation/filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './presentation/guards/human-decision-active-reviewer.guard';
import { HumanDecisionReviewController } from './presentation/human-decision-review.controller';

@Module({
  imports: [ChatbotApiModule, DatabaseModule, AuthModule],
  controllers: [
    BotRestockIntakeController,
    BotRestockPollController,
    BotApplicationOutcomeController,
    HumanDecisionReviewController,
  ],
  providers: [
    HumanDecisionHttpFilter,
    HumanDecisionActiveReviewerGuard,
    {
      provide: RESTOCK_INTAKE_REPOSITORY,
      useClass: PrismaRestockIntakeRepository,
    },
    {
      provide: BOT_RESTOCK_POLL_REPOSITORY,
      useClass: PrismaBotRestockPollRepository,
    },
    {
      provide: BOT_APPLICATION_OUTCOME_REPOSITORY,
      useClass: PrismaBotApplicationOutcomeRepository,
    },
    {
      provide: HUMAN_DECISION_REVIEW_READ_REPOSITORY,
      useClass: PrismaHumanDecisionReviewReadRepository,
    },
    {
      provide: HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
      useClass: PrismaHumanDecisionReviewResolveRepository,
    },
  ],
})
export class HumanDecisionsModule {}
