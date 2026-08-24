/**
 * AdminPaymentDetailModule — Q1 / WU1.
 *
 * Self-contained module for the `PaymentDetail` admin CRUD. Imports
 * `AuthModule` so the controller's guards (`JwtAuthGuard`,
 * `TenantContextGuard`, `PermissionsGuard`) + the `@RequirePermissions`
 * decorator resolve without making `AuthModule` global. Wires the
 * `PAYMENT_DETAIL_REPOSITORY` symbol to the Prisma adapter (mirrors the
 * `ROLE_REPOSITORY` / `PERMISSION_REPOSITORY` precedent).
 *
 * Leaf module (no exports): consumed via `AdminModule.imports`.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AdminPaymentDetailController } from './admin-payment-detail.controller';
import { AdminPaymentDetailService } from './admin-payment-detail.service';
import { PrismaPaymentDetailRepository } from './infrastructure/prisma-payment-detail.repository';
import { PAYMENT_DETAIL_REPOSITORY } from './domain/payment-detail.repository';

@Module({
  imports: [AuthModule],
  controllers: [AdminPaymentDetailController],
  providers: [
    AdminPaymentDetailService,
    {
      provide: PAYMENT_DETAIL_REPOSITORY,
      useClass: PrismaPaymentDetailRepository,
    },
  ],
})
export class AdminPaymentDetailModule {}
