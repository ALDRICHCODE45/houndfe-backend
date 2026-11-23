/**
 * restock-backorder / T1b — customer delete rules (owner decision L5): block
 * with a clear 409 while a WAITING/RESERVED backorder exists, otherwise delete
 * the terminal backorders (CONFIRMED/EXPIRED/CANCELLED) with the customer.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { CustomerHasActiveBackordersError } from '../domain/customer-has-active-backorders.error';
import { PrismaCustomerRepository } from './prisma-customer.repository';

function makeRepo(activeBackorder: { id: string } | null) {
  const calls: string[] = [];
  const client = {
    $queryRaw: jest.fn<Promise<unknown>, [TemplateStringsArray, ...unknown[]]>(
      () => {
        calls.push('lock');
        return Promise.resolve([{ id: 'cust-1' }]);
      },
    ),
    backorder: {
      findFirst: jest.fn(() => {
        calls.push('findActive');
        return Promise.resolve(activeBackorder);
      }),
      deleteMany: jest.fn(() => {
        calls.push('deleteTerminal');
        return Promise.resolve({ count: 2 });
      }),
    },
    customer: {
      delete: jest.fn(() => {
        calls.push('deleteCustomer');
        return Promise.resolve({});
      }),
    },
  };
  const tenantPrisma = {
    getClient: jest.fn(() => client),
    getTenantId: jest.fn(() => 'tenant-1'),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      calls.push('begin');
      const result = await work();
      calls.push('commit');
      return result;
    }),
  };
  const repo = new PrismaCustomerRepository(
    tenantPrisma as unknown as TenantPrismaService,
  );
  return { repo, client, tenantPrisma, calls };
}

describe('PrismaCustomerRepository.delete — backorders (T1b)', () => {
  it('locks the customer, deletes terminal backorders, then the customer, in one transaction', async () => {
    const { repo, client, tenantPrisma, calls } = makeRepo(null);

    await repo.delete('cust-1');

    expect(tenantPrisma.runInTransaction).toHaveBeenCalledTimes(1);
    // Three raw locks (customer-pets T3): customer, its sale rows, its pets;
    // the exact order is pinned in prisma-customer.repository.spec.ts.
    expect(calls).toEqual([
      'begin',
      'lock',
      'lock',
      'lock',
      'findActive',
      'deleteTerminal',
      'deleteCustomer',
      'commit',
    ]);
    expect(client.backorder.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: 'cust-1',
        status: { in: ['WAITING', 'RESERVED'] },
      },
      select: { id: true },
    });
    expect(client.backorder.deleteMany).toHaveBeenCalledWith({
      where: {
        customerId: 'cust-1',
        status: { in: ['CONFIRMED', 'EXPIRED', 'CANCELLED'] },
      },
    });
    expect(client.customer.delete).toHaveBeenCalledWith({
      where: { id: 'cust-1' },
    });
  });

  it('locks the customer row scoped to the tenant (FOR UPDATE)', async () => {
    const { repo, client } = makeRepo(null);

    await repo.delete('cust-1');

    const [strings, ...values] = client.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(/FROM customers/);
    expect(strings.join('?')).toMatch(/FOR UPDATE/);
    expect(values).toEqual(['cust-1', 'tenant-1']);
  });

  it('throws CUSTOMER_HAS_ACTIVE_BACKORDERS and deletes nothing when one is WAITING/RESERVED', async () => {
    const { repo, client } = makeRepo({ id: 'bo-1' });

    await expect(repo.delete('cust-1')).rejects.toBeInstanceOf(
      CustomerHasActiveBackordersError,
    );

    expect(client.backorder.deleteMany).not.toHaveBeenCalled();
    expect(client.customer.delete).not.toHaveBeenCalled();
  });

  it('propagates a customer delete failure unchanged (rolls back the transaction)', async () => {
    const { repo, client } = makeRepo(null);
    const failure = new Error('FK violation');
    client.customer.delete.mockRejectedValueOnce(failure);

    await expect(repo.delete('cust-1')).rejects.toBe(failure);
  });
});
