/**
 * customers-listing T4 (S4, contract §6.2, §10) — `GET /customers/
 * :customerId/sales-summary`: route, `read:Sale`, guards, UUID pipe,
 * delegation and module registration. The 400/404 envelopes over HTTP are
 * pinned by the PostgreSQL integration spec.
 */
import 'reflect-metadata';
import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { CustomerSalesSummaryController } from './customer-sales-summary.controller';
import { PrismaCustomerSalesSummaryReader } from './customer-sales-summary.prisma-reader';
import { CUSTOMER_SALES_SUMMARY_READER } from './customer-sales-summary.reader';
import {
  CustomerSalesSummaryService,
  type CustomerSalesSummaryResponse,
} from './customer-sales-summary.service';
import { SalesModule } from './sales.module';

const CUSTOMER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('CustomerSalesSummaryController', () => {
  const handler = (
    CustomerSalesSummaryController.prototype as unknown as Record<
      string,
      object
    >
  ).summary;

  it('is mapped to GET /customers/:customerId/sales-summary', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, CustomerSalesSummaryController),
    ).toBe('customers/:customerId/sales-summary');
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
      Reflect.getMetadata(GUARDS_METADATA, CustomerSalesSummaryController),
    ).toEqual([JwtAuthGuard, TenantContextGuard, PermissionsGuard]);
  });

  it('parses :customerId with ParseUUIDPipe (non-UUID → 400)', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      CustomerSalesSummaryController,
      'summary',
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const param = Object.values(args).find((a) => a.data === 'customerId');
    expect(param?.pipes).toContain(ParseUUIDPipe);
  });

  it('delegates the customer id to the service', async () => {
    const body: CustomerSalesSummaryResponse = {
      customerId: CUSTOMER_ID,
      metrics: {
        openDebtCents: 0,
        overdueDebtCents: 0,
        overdueCount: 0,
        oldestOverdueDueDate: null,
        salesCount: 0,
        totalSoldCents: 0,
        averageTicketCents: null,
        lastPurchaseAt: null,
      },
    };
    const service = { summary: jest.fn().mockResolvedValue(body) };
    const controller = new CustomerSalesSummaryController(
      service as unknown as CustomerSalesSummaryService,
    );

    await expect(controller.summary(CUSTOMER_ID)).resolves.toBe(body);
    expect(service.summary).toHaveBeenCalledWith(CUSTOMER_ID);
  });
});

describe('SalesModule customer sales summary registration (customers-listing T4)', () => {
  it('registers the controller, the service and the Prisma reader binding', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      SalesModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      SalesModule,
    ) as unknown[];

    expect(controllers).toContain(CustomerSalesSummaryController);
    expect(providers).toContain(CustomerSalesSummaryService);
    expect(providers).toContainEqual({
      provide: CUSTOMER_SALES_SUMMARY_READER,
      useClass: PrismaCustomerSalesSummaryReader,
    });
  });

  it('does not import CustomersModule (shares only the pure metrics fragment)', () => {
    const imports = (
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, SalesModule) as Array<{
        name?: string;
      }>
    ).map((m) => m?.name);
    expect(imports).not.toContain('CustomersModule');
  });
});
