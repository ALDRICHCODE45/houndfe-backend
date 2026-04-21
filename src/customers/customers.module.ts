import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PrismaCustomerRepository } from './infrastructure/prisma-customer.repository';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  controllers: [CustomersController],
  providers: [
    CustomersService,
    {
      provide: CUSTOMER_REPOSITORY,
      useClass: PrismaCustomerRepository,
    },
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
