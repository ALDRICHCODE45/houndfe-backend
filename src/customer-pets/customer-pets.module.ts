import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomerPetsService } from './application/customer-pets.service';
import { CUSTOMER_PET_REPOSITORY } from './domain/customer-pet.repository';
import { PrismaCustomerPetRepository } from './infrastructure/prisma-customer-pet.repository';
import { CustomerPetsController } from './presentation/customer-pets.controller';

/**
 * Customer pets (contract v1). T1: the model, the rules and the POS routes
 * under `/customers/:customerId/pets`. `CustomerPetsService` is exported for
 * the bot API (T2) and the sale lines (T3). `AuthModule` supplies the guards;
 * `TenantPrismaService` and `ConfigService` come from the global modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [CustomerPetsController],
  providers: [
    CustomerPetsService,
    {
      provide: CUSTOMER_PET_REPOSITORY,
      useClass: PrismaCustomerPetRepository,
    },
  ],
  exports: [CustomerPetsService],
})
export class CustomerPetsModule {}
