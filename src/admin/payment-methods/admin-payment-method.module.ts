/**
 * AdminPaymentMethodModule — custom-payment-methods / WU1.
 *
 * Self-contained module for the `PaymentMethod` admin CRUD. Mirrors
 * `AdminPaymentDetailModule`: imports `AuthModule` so the controller's
 * guards + `@RequirePermissions` resolve without making `AuthModule`
 * global. Wires the `PAYMENT_METHOD_REPOSITORY` symbol to the Prisma
 * adapter and additionally provides the
 * `PaymentMethodCatalogResolver` under the `PAYMENT_METHOD_RESOLVER`
 * symbol — exporting the latter is the D3 seam that lets
 * `SalesModule` consume the narrow read port.
 *
 * Exports: `PAYMENT_METHOD_RESOLVER` (consumed by SalesModule) +
 * `PAYMENT_METHOD_REPOSITORY` (consumed by SalesModule tests if any
 * want to assert the cross-module symbol wiring directly — not used at
 * runtime by sales).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AdminPaymentMethodController } from './admin-payment-method.controller';
import { AdminPaymentMethodService } from './admin-payment-method.service';
import { PrismaPaymentMethodRepository } from './infrastructure/prisma-payment-method.repository';
import { PAYMENT_METHOD_REPOSITORY } from './domain/payment-method.repository';
import { PAYMENT_METHOD_RESOLVER } from './domain/payment-method.resolver';
import { PaymentMethodCatalogResolver } from './payment-method-catalog.resolver';

@Module({
  imports: [AuthModule],
  controllers: [AdminPaymentMethodController],
  providers: [
    AdminPaymentMethodService,
    {
      provide: PAYMENT_METHOD_REPOSITORY,
      useClass: PrismaPaymentMethodRepository,
    },
    PaymentMethodCatalogResolver,
    {
      // Bind the concrete resolver class under the symbol SalesModule
      // consumes (`@Inject(PAYMENT_METHOD_RESOLVER)`).
      provide: PAYMENT_METHOD_RESOLVER,
      useExisting: PaymentMethodCatalogResolver,
    },
  ],
  exports: [
    PAYMENT_METHOD_RESOLVER,
    PAYMENT_METHOD_REPOSITORY,
    PaymentMethodCatalogResolver,
  ],
})
export class AdminPaymentMethodModule {}