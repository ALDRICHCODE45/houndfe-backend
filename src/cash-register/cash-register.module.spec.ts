import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module';
import { CaslAbilityFactory } from '../auth/authorization/casl-ability.factory';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { CASH_APPLICATION } from './cash-application.port';
import { CASH_LEDGER } from './cash-ledger.port';
import { CashRegisterModule } from './cash-register.module';
import { PrismaCashRegisterApplication } from './infrastructure/prisma-cash-register';
import {
  CashClosingController,
  CashHandoverController,
  CashRegisterController,
  CashSessionController,
} from './presentation';

@Module({
  providers: [{ provide: TenantPrismaService, useValue: {} }],
  exports: [TenantPrismaService],
})
class IsolatedDatabaseModule {}

@Module({
  providers: [{ provide: CaslAbilityFactory, useValue: {} }],
  exports: [CaslAbilityFactory],
})
class IsolatedAuthModule {}

// A consumer must resolve both ports from exports, not root-wide lookup.
@Module({
  imports: [CashRegisterModule],
  providers: [
    {
      provide: 'CASH_PORT_CONSUMER',
      inject: [CASH_APPLICATION, CASH_LEDGER],
      useFactory: (application: unknown, ledger: unknown) => ({
        application,
        ledger,
      }),
    },
  ],
})
class ConsumerModule {}

describe('CashRegisterModule wiring', () => {
  it('exports one shared adapter and registers all four HTTP controllers without database access', async () => {
    const module = await Test.createTestingModule({ imports: [ConsumerModule] })
      .overrideModule(DatabaseModule)
      .useModule(IsolatedDatabaseModule)
      .overrideModule(AuthModule)
      .useModule(IsolatedAuthModule)
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantContextGuard)
      .useValue({ canActivate: () => true })
      .compile();
    try {
      const consumer = module.get<{ application: unknown; ledger: unknown }>(
        'CASH_PORT_CONSUMER',
      );
      expect(consumer.application).toBeInstanceOf(
        PrismaCashRegisterApplication,
      );
      expect(consumer.ledger).toBe(consumer.application);
      for (const controller of [
        CashRegisterController,
        CashSessionController,
        CashHandoverController,
        CashClosingController,
      ]) {
        expect(module.get(controller)).toBeInstanceOf(controller);
      }
    } finally {
      await module.close();
    }
  });
});
