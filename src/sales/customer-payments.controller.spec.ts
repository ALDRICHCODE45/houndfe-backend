/**
 * customers-listing T2 (S5, contract §7) — `GET /customers/:customerId/
 * payments`: route, `read:Sale`, guards, delegation and module registration.
 * Non-UUID 400 and the 404 envelope over HTTP are pinned by the PostgreSQL
 * integration spec.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { CustomerPaymentsController } from './customer-payments.controller';
import { PrismaCustomerPaymentsReader } from './customer-payments.prisma-reader';
import { CUSTOMER_PAYMENTS_READER } from './customer-payments.reader';
import { CustomerPaymentsService } from './customer-payments.service';
import type { CustomerPaymentsResponseDto } from './dto/customer-payments.dto';
import { SalesModule } from './sales.module';

const CUSTOMER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('CustomerPaymentsController', () => {
  const handler = (
    CustomerPaymentsController.prototype as unknown as Record<string, object>
  ).list;

  it('is mapped to GET /customers/:customerId/payments', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CustomerPaymentsController)).toBe(
      'customers/:customerId/payments',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
  });

  it('requires exactly read:Sale behind the JWT → tenant → permissions guards', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      ['read', 'Sale'],
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CustomerPaymentsController),
    ).toEqual([JwtAuthGuard, TenantContextGuard, PermissionsGuard]);
  });

  it('delegates the customer id and the validated page/limit to the service', async () => {
    const page: CustomerPaymentsResponseDto = {
      data: [],
      pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
    };
    const service = { list: jest.fn().mockResolvedValue(page) };
    const controller = new CustomerPaymentsController(
      service as unknown as CustomerPaymentsService,
    );

    await expect(
      controller.list(CUSTOMER_ID, { page: 2, limit: 10 }),
    ).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(CUSTOMER_ID, {
      page: 2,
      limit: 10,
    });
  });
});

describe('SalesModule customer payments feed registration (customers-listing T2)', () => {
  it('registers the controller, the service and the Prisma reader binding', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      SalesModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      SalesModule,
    ) as unknown[];

    expect(controllers).toContain(CustomerPaymentsController);
    expect(providers).toContain(CustomerPaymentsService);
    expect(providers).toContainEqual({
      provide: CUSTOMER_PAYMENTS_READER,
      useClass: PrismaCustomerPaymentsReader,
    });
  });
});
