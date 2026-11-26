import { CustomersController } from './customers.controller';
import { CustomersModule } from './customers.module';
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
});
