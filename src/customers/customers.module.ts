import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { PrismaCustomerRepository } from './infrastructure/prisma-customer.repository';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';
import { CUSTOMERS_LISTING_READER } from './listing/customer-listing.types';
import { CustomersListingController } from './listing/customers-listing.controller';
import {
  CUSTOMERS_LISTING_CLOCK,
  CustomersListingService,
} from './listing/customers-listing.service';
import { PrismaCustomersListingReader } from './listing/prisma-customers-listing.reader';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  // customers-listing: `GET /customers/listing` must be registered before
  // `GET /customers/:id` (contract §3.1).
  controllers: [CustomersListingController, CustomersController],
  providers: [
    CustomersService,
    {
      provide: CUSTOMER_REPOSITORY,
      useClass: PrismaCustomerRepository,
    },
    CustomersListingService,
    {
      provide: CUSTOMERS_LISTING_READER,
      useClass: PrismaCustomersListingReader,
    },
    { provide: CUSTOMERS_LISTING_CLOCK, useValue: () => new Date() },
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
