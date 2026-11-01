import { PriceListsService } from './price-lists.service';
import { lockCatalogLifecycle } from '../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import {
  BusinessRuleViolationError,
  EntityNotFoundError,
} from '../shared/domain/domain-error';

it.each(['shared', 'exclusive'] as const)(
  'uses the exact lifecycle mode %s and propagates lock failure',
  async (mode) => {
    const execute = jest.fn().mockResolvedValue(0);
    const tx = { $executeRaw: execute };
    await expect(lockCatalogLifecycle(tx, mode)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith([
      `LOCK TABLE "global_price_lists" IN ${mode === 'shared' ? 'SHARE' : 'SHARE ROW EXCLUSIVE'} MODE`,
    ]);
    const error = new Error('lock denied');
    execute.mockRejectedValue(error);
    await expect(lockCatalogLifecycle(tx, mode)).rejects.toBe(error);
  },
);

type List = { id: string; isDefault: boolean };
function setup(context: string | null = null) {
  let rows: List[] = [
    { id: 'target', isDefault: false },
    { id: 'untouched', isDefault: false },
  ];
  let inside = false;
  const events: string[] = [];
  const record = (event: string) => {
    if (!inside) throw new Error(`Root ${event}`);
    events.push(event);
  };
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('gate');
      return Promise.resolve(0);
    }),
    globalPriceList: {
      findUnique: jest.fn(
        ({ where }: { where: { id: string }; select: unknown }) => {
          record('read');
          return Promise.resolve(rows.find((r) => r.id === where.id) ?? null);
        },
      ),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        record('delete');
        rows = rows.filter((r) => r.id !== where.id);
        return Promise.resolve({ id: where.id });
      }),
    },
  };
  async function transaction<T>(work: () => Promise<T>) {
    if (inside) return work();
    const before = structuredClone(rows);
    inside = true;
    events.push('begin');
    try {
      const result = await work();
      events.push('commit');
      return result;
    } catch (e) {
      rows = before;
      events.push('rollback');
      throw e;
    } finally {
      inside = false;
    }
  }
  const tenant = {
    getTenantId: jest.fn(() => {
      throw new Error(`Unexpected context ${context}`);
    }),
    getClient: () => {
      record('client');
      return tx;
    },
    runInTransaction: jest.fn(transaction),
  };
  const root = {
    globalPriceList: {
      findUnique: jest.fn(() => {
        throw new Error('Root read');
      }),
      delete: jest.fn(() => {
        throw new Error('Root delete');
      }),
    },
  };
  type Args = ConstructorParameters<typeof PriceListsService>;
  const service = new PriceListsService(
    root as unknown as Args[0],
    tenant as unknown as Args[1],
  );
  return {
    service,
    tenant,
    tx,
    root,
    events,
    transaction,
    snapshot: () => structuredClone(rows),
    change: (value: List | null) => {
      rows = value ? [value, rows[1]] : [rows[1]];
    },
  };
}
it.each([null, 'tenant', 'foreign'])(
  'deletes globally through the gated transaction with context=%s',
  async (context) => {
    const s = setup(context);
    await expect(s.service.remove('target')).resolves.toBeUndefined();
    expect(s.events).toEqual([
      'begin',
      'client',
      'gate',
      'read',
      'delete',
      'commit',
    ]);
    expect(s.tx.$executeRaw.mock.calls[0]).toEqual([
      ['LOCK TABLE "global_price_lists" IN SHARE ROW EXCLUSIVE MODE'],
    ]);
    expect(s.tx.globalPriceList.findUnique).toHaveBeenCalledWith({
      where: { id: 'target' },
      select: { id: true, isDefault: true },
    });
    expect(s.tx.globalPriceList.delete).toHaveBeenCalledWith({
      where: { id: 'target' },
    });
    expect(s.snapshot()).toEqual([{ id: 'untouched', isDefault: false }]);
    expect(s.tenant.getTenantId).not.toHaveBeenCalled();
    expect(s.root.globalPriceList.findUnique).not.toHaveBeenCalled();
    expect(s.root.globalPriceList.delete).not.toHaveBeenCalled();
    expect(s.tenant.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
    );
  },
);
it.each([null, { id: 'target', isDefault: true }])(
  'validates fresh post-wait list state %s',
  async (value) => {
    const s = setup();
    s.tx.$executeRaw.mockImplementation(() => {
      s.events.push('gate');
      s.change(value);
      return Promise.resolve(0);
    });
    const before = s.snapshot();
    const error = value
      ? new BusinessRuleViolationError(
          'Cannot delete the default PUBLICO price list',
          'DEFAULT_PRICE_LIST_PROTECTED',
        )
      : new EntityNotFoundError('GlobalPriceList', 'target');
    await expect(s.service.remove('target')).rejects.toEqual(error);
    expect(s.events).toEqual(['begin', 'client', 'gate', 'read', 'rollback']);
    expect(s.tx.globalPriceList.delete).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
  },
);
it.each(['gate', 'read', 'delete'])(
  'propagates %s errors without persisted mutation',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    const error = new Error('sentinel');
    if (stage === 'gate') s.tx.$executeRaw.mockRejectedValue(error);
    if (stage === 'read')
      s.tx.globalPriceList.findUnique.mockRejectedValue(error);
    if (stage === 'delete')
      s.tx.globalPriceList.delete.mockImplementation(() => {
        s.change(null);
        throw error;
      });
    await expect(s.service.remove('target')).rejects.toBe(error);
    expect(s.snapshot()).toEqual(before);
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.tx.globalPriceList.findUnique).toHaveBeenCalledTimes(
      stage === 'gate' ? 0 : 1,
    );
    expect(s.tx.globalPriceList.delete).toHaveBeenCalledTimes(
      stage === 'delete' ? 1 : 0,
    );
  },
);
it('joins outer ownership, keeps deletion uncommitted and restores on outer failure', async () => {
  const s = setup();
  const before = s.snapshot();
  const error = new Error('outer');
  await expect(
    s.transaction(async () => {
      await s.service.remove('target');
      expect(s.snapshot()).toEqual([before[1]]);
      expect(s.events).not.toContain('commit');
      throw error;
    }),
  ).rejects.toBe(error);
  expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
  expect(s.snapshot()).toEqual(before);
  expect(s.events.at(-1)).toBe('rollback');
});
it('commits only once when the outer owner succeeds', async () => {
  const s = setup();
  await expect(
    s.transaction(async () => {
      await expect(s.service.remove('target')).resolves.toBeUndefined();
      expect(s.events).not.toContain('commit');
    }),
  ).resolves.toBeUndefined();
  expect(s.events.filter((e) => e === 'commit')).toHaveLength(1);
  expect(s.snapshot()).toEqual([{ id: 'untouched', isDefault: false }]);
});
