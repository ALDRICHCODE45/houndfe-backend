import { PriceListsService } from './price-lists.service';
import {
  BusinessRuleViolationError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
} from '../shared/domain/domain-error';

function makeService(prisma: any) {
  return new PriceListsService({ getClient: jest.fn().mockReturnValue(prisma) } as any);
}

describe('PriceListsService', () => {
  it('findAll should return all global price lists', async () => {
    const prisma = {
      globalPriceList: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'publico', name: 'PUBLICO', isDefault: true },
          { id: 'mayoreo', name: 'Mayoreo', isDefault: false },
        ]),
      },
    } as any;

    const service = makeService(prisma);
    const result = await service.findAll();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('PUBLICO');
    expect(prisma.globalPriceList.findMany).toHaveBeenCalled();
  });

  it('create should create global list and initialize product/variant matrix in 0', async () => {
    const tx = {
      globalPriceList: {
        create: jest.fn().mockResolvedValue({
          id: 'gl-1',
          name: 'Mayorista',
          isDefault: false,
        }),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', hasVariants: true },
          { id: 'p2', hasVariants: false },
        ]),
      },
      priceList: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'pl-p1', productId: 'p1' }]),
      },
      variant: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', productId: 'p1' },
          { id: 'v2', productId: 'p1' },
        ]),
      },
      variantPrice: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as any;

    const prisma = {
      globalPriceList: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    } as any;

    const service = makeService(prisma);
    const created = await service.create({ name: '  Mayorista  ' });

    expect(created.name).toBe('Mayorista');
    expect(tx.priceList.createMany).toHaveBeenCalledWith({
      data: [
        { productId: 'p1', globalPriceListId: 'gl-1', priceCents: 0 },
        { productId: 'p2', globalPriceListId: 'gl-1', priceCents: 0 },
      ],
    });
    expect(tx.variantPrice.createMany).toHaveBeenCalledWith({
      data: [
        { variantId: 'v1', priceListId: 'pl-p1', priceCents: 0 },
        { variantId: 'v2', priceListId: 'pl-p1', priceCents: 0 },
      ],
    });
  });

  it('create should reject duplicated global list name', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest.fn().mockResolvedValue({ id: 'gl-1' }),
      },
    } as any;

    const service = makeService(prisma);

    await expect(service.create({ name: 'PUBLICO' })).rejects.toThrow(
      EntityAlreadyExistsError,
    );
  });

  it('remove should delete non-default global list', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'gl-2', isDefault: false }),
        delete: jest.fn().mockResolvedValue({ id: 'gl-2' }),
      },
    } as any;

    const service = makeService(prisma);
    await service.remove('gl-2');

    expect(prisma.globalPriceList.delete).toHaveBeenCalledWith({
      where: { id: 'gl-2' },
    });
  });

  it('remove should reject default PUBLICO list', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'gl-publico', isDefault: true }),
        delete: jest.fn(),
      },
    } as any;

    const service = makeService(prisma);

    await expect(service.remove('gl-publico')).rejects.toThrow(
      BusinessRuleViolationError,
    );
    expect(prisma.globalPriceList.delete).not.toHaveBeenCalled();
  });

  it('update should rename non-default list', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'gl-2', isDefault: false })
          .mockResolvedValueOnce(null),
        update: jest.fn().mockResolvedValue({
          id: 'gl-2',
          name: 'Minorista',
          isDefault: false,
        }),
      },
    } as any;

    const service = makeService(prisma);
    const updated = await service.update('gl-2', { name: '  Minorista ' });

    expect(updated.name).toBe('Minorista');
    expect(prisma.globalPriceList.update).toHaveBeenCalledWith({
      where: { id: 'gl-2' },
      data: { name: 'Minorista' },
    });
  });

  it('update should reject rename on default PUBLICO list', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'gl-publico', isDefault: true }),
        update: jest.fn(),
      },
    } as any;

    const service = makeService(prisma);

    await expect(
      service.update('gl-publico', { name: 'PUBLICO 2' }),
    ).rejects.toThrow(BusinessRuleViolationError);
    expect(prisma.globalPriceList.update).not.toHaveBeenCalled();
  });

  it('update should fail for missing list', async () => {
    const prisma = {
      globalPriceList: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as any;

    const service = makeService(prisma);

    await expect(service.update('missing', { name: 'X' })).rejects.toThrow(
      EntityNotFoundError,
    );
  });
});
