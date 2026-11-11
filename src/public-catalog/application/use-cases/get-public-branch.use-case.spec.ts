import { GetPublicBranchUseCase } from './get-public-branch.use-case';
import type { IPublicCatalogRepository } from '../ports/public-catalog.repository';
import type { PickupLocationService } from '../../../shipping/pickup/application/pickup-location.service';
import type { PublicCatalogConfig } from '../services/public-catalog-config';

const tenant = { id: 't1', slug: 'centro', name: 'Centro' };

function build(opts: {
  location?: Awaited<ReturnType<PickupLocationService['resolve']>>;
  profile?: { phone: string | null; deliveryAvailable: boolean };
  whatsapp?: string | null;
}) {
  const resolve = jest.fn().mockResolvedValue(
    opts.location ?? {
      name: 'Sucursal Centro',
      address: null,
      hours: null,
    },
  );
  const findPublicBranchProfile = jest
    .fn()
    .mockResolvedValue(
      opts.profile ?? { phone: null, deliveryAvailable: false },
    );
  const useCase = new GetPublicBranchUseCase(
    { findPublicBranchProfile } as unknown as IPublicCatalogRepository,
    { resolve } as unknown as PickupLocationService,
    {
      botWhatsappNumber: () => opts.whatsapp ?? null,
    } as unknown as PublicCatalogConfig,
  );
  return { useCase, resolve, findPublicBranchProfile };
}

const hours = {
  timeZone: 'America/Mexico_City',
  days: [
    {
      day: 'MONDAY' as const,
      label: 'Lunes',
      closed: false,
      ranges: [{ open: '09:00', close: '18:00' }],
    },
  ],
  summary: 'Lunes 09:00–18:00',
};
const address = {
  addressLine1: 'Av. Juárez 123',
  addressLine2: null,
  neighborhood: 'Centro',
  municipality: 'CDMX',
  state: 'CDMX',
  postalCode: '06000',
  formatted: 'Av. Juárez 123, Centro, CDMX, CDMX, C.P. 06000',
};

describe('GetPublicBranchUseCase', () => {
  it('assembles the branch card from the pickup location, the profile and the bot number', async () => {
    const { useCase, resolve, findPublicBranchProfile } = build({
      location: { name: 'Sucursal Centro', address, hours },
      profile: { phone: '+525512345678', deliveryAvailable: true },
      whatsapp: '+5215500000000',
    });

    await expect(useCase.execute(tenant)).resolves.toEqual({
      name: 'Sucursal Centro',
      phone: '+525512345678',
      address,
      hours,
      pickupAvailable: true,
      deliveryAvailable: true,
      whatsappNumber: '+5215500000000',
    });
    expect(resolve).toHaveBeenCalledWith('t1');
    expect(findPublicBranchProfile).toHaveBeenCalledWith('t1');
  });

  it('answers nulls and false flags for a branch with nothing configured', async () => {
    const { useCase } = build({});
    await expect(useCase.execute(tenant)).resolves.toEqual({
      name: 'Sucursal Centro',
      phone: null,
      address: null,
      hours: null,
      pickupAvailable: false,
      deliveryAvailable: false,
      whatsappNumber: null,
    });
  });

  it('pickupAvailable follows the address even when hours are missing', async () => {
    const { useCase } = build({
      location: { name: 'Centro', address, hours: null },
    });
    const result = await useCase.execute(tenant);
    expect(result.pickupAvailable).toBe(true);
    expect(result.hours).toBeNull();
  });

  it('never exposes the internal contact phone or tenant identifiers', async () => {
    const { useCase } = build({
      location: { name: 'Centro', address, hours },
    });
    const result = await useCase.execute(tenant);
    expect(Object.keys(result).sort()).toEqual([
      'address',
      'deliveryAvailable',
      'hours',
      'name',
      'phone',
      'pickupAvailable',
      'whatsappNumber',
    ]);
    expect(JSON.stringify(result)).not.toContain('contactPhone');
    expect(JSON.stringify(result)).not.toContain('t1');
  });
});
