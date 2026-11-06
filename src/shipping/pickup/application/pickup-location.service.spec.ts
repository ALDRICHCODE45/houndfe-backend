import type { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import { OpeningHoursService } from './opening-hours.service';
import { PickupLocationService } from './pickup-location.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const closedWeek = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
].map((day) => ({ day, ranges: [] as Array<{ open: string; close: string }> }));

function build(rows: {
  tenant: { name: string; address: string | null } | null;
  origin: Record<string, unknown> | null;
  hours: Record<string, unknown> | null;
}) {
  const client = {
    tenant: { findUnique: jest.fn().mockResolvedValue(rows.tenant) },
    shippingOrigin: { findFirst: jest.fn().mockResolvedValue(rows.origin) },
    tenantOpeningHours: { findFirst: jest.fn().mockResolvedValue(rows.hours) },
  };
  const tenantPrisma = {
    getClient: () => client,
  } as unknown as TenantPrismaService;
  return {
    client,
    service: new PickupLocationService(
      tenantPrisma,
      new OpeningHoursService(tenantPrisma),
    ),
  };
}

describe('PickupLocationService', () => {
  it('builds name, origin address and formatted hours', async () => {
    const days = closedWeek.map((d) =>
      d.day === 'SATURDAY'
        ? { ...d, ranges: [{ open: '10:00', close: '14:00' }] }
        : d,
    );
    const { service, client } = build({
      tenant: { name: 'Sucursal Centro', address: 'texto libre' },
      origin: {
        addressLine1: 'Av. Juárez 123',
        addressLine2: 'Local 4',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
      },
      hours: {
        timeZone: 'America/Mexico_City',
        days,
        updatedAt: new Date(),
      },
    });

    const location = await service.resolve(TENANT);

    expect(client.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: TENANT },
      select: { name: true, address: true },
    });
    expect(client.shippingOrigin.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
    });
    expect(location.hours?.days).toHaveLength(7);
    expect({ ...location, hours: { ...location.hours, days: [] } }).toEqual({
      name: 'Sucursal Centro',
      address: {
        addressLine1: 'Av. Juárez 123',
        addressLine2: 'Local 4',
        neighborhood: 'Centro',
        municipality: 'Cuauhtémoc',
        state: 'Ciudad de México',
        postalCode: '06000',
        formatted:
          'Av. Juárez 123, Local 4, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000',
      },
      hours: {
        timeZone: 'America/Mexico_City',
        days: [],
        summary:
          'Lunes a viernes: cerrado. Sábado: 10:00–14:00. Domingo: cerrado.',
      },
    });
  });

  it('falls back to the free-text tenant address and null hours', async () => {
    const { service } = build({
      tenant: { name: 'Sucursal Norte', address: '  Calle 5 #10, Monterrey ' },
      origin: null,
      hours: null,
    });

    expect(await service.resolve(TENANT)).toEqual({
      name: 'Sucursal Norte',
      address: {
        addressLine1: null,
        addressLine2: null,
        neighborhood: null,
        municipality: null,
        state: null,
        postalCode: null,
        formatted: 'Calle 5 #10, Monterrey',
      },
      hours: null,
    });
  });

  it('returns a null address when nothing is configured', async () => {
    const { service } = build({
      tenant: { name: 'Sucursal Sur', address: null },
      origin: null,
      hours: null,
    });

    expect((await service.resolve(TENANT)).address).toBeNull();
  });
});
