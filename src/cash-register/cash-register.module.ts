import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { CASH_APPLICATION } from './cash-application.port';
import { CASH_LEDGER } from './cash-ledger.port';
import { PrismaCashRegisterApplication } from './infrastructure/prisma-cash-register';
import {
  CashClosingController,
  CashHandoverController,
  CashRegisterController,
  CashSessionController,
} from './presentation';

/** Cash owns the ledger; Sales and PDF consume its ports without a reverse import. */
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [
    CashRegisterController,
    CashSessionController,
    CashHandoverController,
    CashClosingController,
  ],
  providers: [
    PrismaCashRegisterApplication,
    { provide: CASH_APPLICATION, useExisting: PrismaCashRegisterApplication },
    { provide: CASH_LEDGER, useExisting: PrismaCashRegisterApplication },
  ],
  exports: [CASH_APPLICATION, CASH_LEDGER],
})
export class CashRegisterModule {}
