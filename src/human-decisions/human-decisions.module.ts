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
 * Binds the `RESTOCK_INTAKE_REPOSITORY` port to the Prisma intake adapter and
 * the `HUMAN_DECISION_REVIEW_READ_REPOSITORY` port to the Prisma read adapter,
 * and registers the scoped filter so `@UseFilters(HumanDecisionHttpFilter)` can
 * be resolved from this module's injector. The HD-04c2 resolve port/adapter is
 * intentionally NOT bound yet: HD-04d1 exposes read routes only and there is no
 * POST resolve route to consume it.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { HUMAN_DECISION_REVIEW_READ_REPOSITORY } from './domain/human-decision-review-read.repository';
import { RESTOCK_INTAKE_REPOSITORY } from './domain/restock-intake.repository';
import { PrismaHumanDecisionReviewReadRepository } from './infrastructure/prisma-human-decision-review-read.repository';
import { PrismaRestockIntakeRepository } from './infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './presentation/bot-restock-intake.controller';
import { HumanDecisionHttpFilter } from './presentation/filters/human-decision-http.filter';
import { HumanDecisionActiveReviewerGuard } from './presentation/guards/human-decision-active-reviewer.guard';
import { HumanDecisionReviewController } from './presentation/human-decision-review.controller';

@Module({
  imports: [ChatbotApiModule, DatabaseModule, AuthModule],
  controllers: [BotRestockIntakeController, HumanDecisionReviewController],
  providers: [
    HumanDecisionHttpFilter,
    HumanDecisionActiveReviewerGuard,
    {
      provide: RESTOCK_INTAKE_REPOSITORY,
      useClass: PrismaRestockIntakeRepository,
    },
    {
      provide: HUMAN_DECISION_REVIEW_READ_REPOSITORY,
      useClass: PrismaHumanDecisionReviewReadRepository,
    },
  ],
})
export class HumanDecisionsModule {}
