/**
 * HD-03b2 — HumanDecisionsModule.
 *
 * Wires the bot RESTOCK intake route without touching the existing chatbot
 * API. Imports:
 *   - `ChatbotApiModule` for the exported `ServiceAuthGuard` and its
 *     `SERVICE_CREDENTIAL_REPOSITORY` binding (plus the CLS context the guard
 *     populates).
 *   - `DatabaseModule` for the Prisma-backed intake adapter.
 *
 * Binds the `RESTOCK_INTAKE_REPOSITORY` port to the Prisma adapter and
 * registers the scoped filter so `@UseFilters(HumanDecisionHttpFilter)` can be
 * resolved from this module's injector.
 */
import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { RESTOCK_INTAKE_REPOSITORY } from './domain/restock-intake.repository';
import { PrismaRestockIntakeRepository } from './infrastructure/prisma-restock-intake.repository';
import { BotRestockIntakeController } from './presentation/bot-restock-intake.controller';
import { HumanDecisionHttpFilter } from './presentation/filters/human-decision-http.filter';

@Module({
  imports: [ChatbotApiModule, DatabaseModule],
  controllers: [BotRestockIntakeController],
  providers: [
    HumanDecisionHttpFilter,
    {
      provide: RESTOCK_INTAKE_REPOSITORY,
      useClass: PrismaRestockIntakeRepository,
    },
  ],
})
export class HumanDecisionsModule {}
