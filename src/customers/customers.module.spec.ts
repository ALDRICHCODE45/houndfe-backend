import { CustomersController } from './customers.controller';
import { CustomersModule } from './customers.module';
import { CustomerBulkSelectionResolver } from './bulk/customer-bulk-selection.resolver';
import { CustomersBulkController } from './bulk/customers-bulk.controller';
import { CustomersListingController } from './listing/customers-listing.controller';

describe('CustomersModule route order (contract §3.1)', () => {
  it('registers GET /customers/listing before GET /customers/:id', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      CustomersModule,
    ) as unknown[];
    const listing = controllers.indexOf(CustomersListingController);
    const crud = controllers.indexOf(CustomersController);
    expect(listing).toBeGreaterThanOrEqual(0);
    expect(crud).toBeGreaterThan(listing);
  });

  it('registers the bulk controller (POST /customers/bulk/*) before CustomersController', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      CustomersModule,
    ) as unknown[];
    const bulk = controllers.indexOf(CustomersBulkController);
    expect(bulk).toBeGreaterThanOrEqual(0);
    expect(controllers.indexOf(CustomersController)).toBeGreaterThan(bulk);
  });

  it('exports the selection resolver for the bulk statements (T3)', () => {
    const exported = Reflect.getMetadata(
      'exports',
      CustomersModule,
    ) as unknown[];
    expect(exported).toContain(CustomerBulkSelectionResolver);
  });
});
