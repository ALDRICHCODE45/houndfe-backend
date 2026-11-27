import 'reflect-metadata';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import type { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';
import type { CustomersBulkExportService } from './customers-bulk-export.service';
import { CustomersBulkController } from './customers-bulk.controller';

function ability(grants: Array<[AppActions, AppSubjects]>): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of grants) can(action, subject);
  return build();
}

function world() {
  const csv = Buffer.from('\uFEFFx\r\n', 'utf8');
  const service = {
    export: jest.fn().mockResolvedValue({
      filename: 'clientes-2026-11-27.csv',
      csv,
      rowCount: 0,
      withMetrics: false,
    }),
  };
  const controller = new CustomersBulkController(
    service as unknown as CustomersBulkExportService,
  );
  const res = { set: jest.fn().mockReturnThis(), send: jest.fn() };
  return { controller, service, res, csv };
}

const body = {
  selection: { mode: 'filter', filter: {} },
} as CustomersBulkExportBodyDto;
const user = {
  userId: 'u1',
  tenantId: 't1',
  email: 'x@y',
  tenantSlug: 't',
  isSuperAdmin: false,
};

describe('CustomersBulkController — POST /customers/bulk/export', () => {
  it('route guard needs read:Customer AND export:Customer', () => {
    const handler = Object.getOwnPropertyDescriptor(
      CustomersBulkController.prototype,
      'export',
    )?.value as object;
    const required = Reflect.getMetadata(PERMISSIONS_KEY, handler) as unknown;
    expect(required).toEqual([
      ['read', 'Customer'],
      ['export', 'Customer'],
    ]);
  });

  it('manage:Customer without the explicit row → standard 403 INSUFFICIENT_PERMISSIONS, nothing exported', async () => {
    const { controller, service, res } = world();
    await expect(
      controller.export(
        body,
        { ability: ability([['manage', 'Customer']]), user } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(InsufficientPermissionsError);
    expect(service.export).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('export:Customer → CSV headers and body', async () => {
    const { controller, service, res, csv } = world();
    const a = ability([
      ['read', 'Customer'],
      ['export', 'Customer'],
    ]);
    await controller.export(body, { ability: a, user } as never, res as never);
    expect(service.export).toHaveBeenCalledWith(body, a, {
      userId: 'u1',
      tenantId: 't1',
    });
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="clientes-2026-11-27.csv"',
      'Cache-Control': 'no-store',
    });
    expect(res.send).toHaveBeenCalledWith(csv);
  });
});
