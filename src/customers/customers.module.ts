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
import {
  CUSTOMER_BULK_SELECTION_READER,
  PrismaCustomerBulkSelectionReader,
} from './bulk/customer-bulk-selection.reader';
import { CustomerBulkSelectionResolver } from './bulk/customer-bulk-selection.resolver';
import { CustomersBulkExportService } from './bulk/customers-bulk-export.service';
import { CustomersBulkController } from './bulk/customers-bulk.controller';

@Module({
  imports: [AuthModule], // Provides JwtAuthGuard, PermissionsGuard, CaslAbilityFactory
  // customers-listing: `GET /customers/listing` must be registered before
  // `GET /customers/:id` (contract §3.1). customers-bulk-actions: the bulk
  // controller (`POST /customers/bulk/*`) is registered before it as well.
  controllers: [
    CustomersListingController,
    CustomersBulkController,
    CustomersController,
  ],
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
    // customers-bulk-actions / T1: selection resolver (also used by the bulk
    // statements, T3) and the CSV export.
    {
      provide: CUSTOMER_BULK_SELECTION_READER,
      useClass: PrismaCustomerBulkSelectionReader,
    },
    CustomerBulkSelectionResolver,
    CustomersBulkExportService,
  ],
  exports: [CustomersService, CustomerBulkSelectionResolver],
})
export class CustomersModule {}
