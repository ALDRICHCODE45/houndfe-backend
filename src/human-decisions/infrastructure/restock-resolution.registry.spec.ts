import { Logger } from '@nestjs/common';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { RestockResolvedEvent } from '../domain/restock-resolution.listener';
import { RestockResolutionRegistry } from './restock-resolution.registry';

const EVENT: RestockResolvedEvent = {
  tenantId: 't-1',
  decisionId: 'd-1',
  action: 'PROVIDE_RESTOCK_ESTIMATE',
  restockDays: 5,
  resolvedAt: new Date('2026-11-20T10:00:00.000Z'),
};

function build() {
  const statements: string[] = [];
  const db = {
    $executeRaw: jest.fn((strings: TemplateStringsArray) => {
      statements.push(strings.join('').trim());
      return Promise.resolve(0);
    }),
  };
  const tenantPrisma = { getClient: jest.fn(() => db) };
  const registry = new RestockResolutionRegistry(
    tenantPrisma as unknown as TenantPrismaService,
  );
  return { registry, db, statements, tenantPrisma };
}

describe('RestockResolutionRegistry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does nothing (not even a savepoint) without listeners', async () => {
    const { registry, db, tenantPrisma } = build();
    await registry.notify(EVENT);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(tenantPrisma.getClient).not.toHaveBeenCalled();
  });

  it('runs every listener inside a savepoint, in registration order', async () => {
    const { registry, statements } = build();
    const order: string[] = [];
    registry.register({
      onRestockResolved: () => {
        order.push('a');
        return Promise.resolve();
      },
    });
    registry.register({
      onRestockResolved: () => {
        order.push('b');
        return Promise.resolve();
      },
    });
    await registry.notify(EVENT);
    expect(order).toEqual(['a', 'b']);
    expect(statements).toEqual([
      'SAVEPOINT restock_resolution_listener',
      'RELEASE SAVEPOINT restock_resolution_listener',
      'SAVEPOINT restock_resolution_listener',
      'RELEASE SAVEPOINT restock_resolution_listener',
    ]);
  });

  it('hands the listener the exact event', async () => {
    const { registry } = build();
    const seen: RestockResolvedEvent[] = [];
    registry.register({
      onRestockResolved: (event) => {
        seen.push(event);
        return Promise.resolve();
      },
    });
    await registry.notify(EVENT);
    expect(seen).toEqual([EVENT]);
  });

  it('a failing listener is rolled back to its savepoint, logged, and never rejects; the next one still runs', async () => {
    const { registry, statements } = build();
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const after = jest.fn().mockResolvedValue(undefined);
    registry.register({
      onRestockResolved: () => Promise.reject(new Error('boom')),
    });
    registry.register({ onRestockResolved: after });

    await expect(registry.notify(EVENT)).resolves.toBeUndefined();

    expect(statements.slice(0, 3)).toEqual([
      'SAVEPOINT restock_resolution_listener',
      'ROLLBACK TO SAVEPOINT restock_resolution_listener',
      'RELEASE SAVEPOINT restock_resolution_listener',
    ]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('d-1'));
  });

  it('registering the same listener twice notifies it once', async () => {
    const { registry } = build();
    const listener = {
      onRestockResolved: jest.fn().mockResolvedValue(undefined),
    };
    registry.register(listener);
    registry.register(listener);
    await registry.notify(EVENT);
    expect(listener.onRestockResolved).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });
});
