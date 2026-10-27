import { Prisma } from '@prisma/client';
import { emptyDocument, validateDocument } from '../domain/document';
import { readLockedEditorialReferences } from './prisma-locked-editorial-references';

const scope = { tenantId: 'tenant-1', productId: 'product-1' };
const rows = (...ids: string[]) => ids.map((id) => ({ id }));
type Query = jest.Mock<Promise<{ id: string }[]>, [Prisma.Sql]>;
function fixture(variants = rows('v1', 'v2'), assets = rows('a1', 'a2')) {
  const query = jest
    .fn<Promise<{ id: string }[]>, [Prisma.Sql]>()
    .mockResolvedValueOnce(variants)
    .mockResolvedValueOnce(assets);
  const execute = jest.fn();
  const tx = {
    $queryRaw: query,
    $executeRaw: execute,
  } as unknown as Prisma.TransactionClient;
  return { tx, query, execute };
}
function sql(query: Query, index: number): Prisma.Sql {
  return query.mock.calls[index][0];
}
const text = (query: Prisma.Sql) => query.sql.replace(/\s+/g, ' ').trim();

describe('readLockedEditorialReferences (caller already holds Product gate)', () => {
  it('reads all qualified variants first, then selected assets ordered FOR SHARE', async () => {
    const { tx, query, execute } = fixture();
    const result = await readLockedEditorialReferences(tx, scope, [
      'a2',
      'a1',
      'a2',
    ]);
    expect(result).toEqual({
      ...scope,
      variantIds: ['v1', 'v2'],
      assetIds: ['a1', 'a2'],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(text(sql(query, 0))).toBe(
      'SELECT id FROM variants WHERE "tenantId" = ? AND "productId" = ? ORDER BY id',
    );
    expect(sql(query, 0).values).toEqual(['tenant-1', 'product-1']);
    expect(text(sql(query, 1))).toBe(
      'SELECT id FROM private_media_assets WHERE "tenantId" = ? AND "productId" = ? AND id IN (?,?) ORDER BY id FOR SHARE',
    );
    expect(sql(query, 1).values).toEqual(['tenant-1', 'product-1', 'a1', 'a2']);
    expect(result).not.toHaveProperty('families');
    expect(execute).not.toHaveBeenCalled();
  });

  it('captures scope and union selections before the first await', async () => {
    const { tx, query } = fixture();
    let release!: (value: { id: string }[]) => void;
    query
      .mockReset()
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      );
    query.mockResolvedValueOnce(rows('a1', 'a2'));
    const mutableScope = { ...scope };
    const selections = ['a2', 'a1', 'a2'];
    const pending = readLockedEditorialReferences(tx, mutableScope, selections);
    expect(query).toHaveBeenCalledTimes(1);
    mutableScope.tenantId = 'other-tenant';
    mutableScope.productId = 'other-product';
    selections.splice(0, selections.length, 'injected');
    release(rows('v1'));
    expect(await pending).toEqual({
      ...scope,
      variantIds: ['v1'],
      assetIds: ['a1', 'a2'],
    });
    expect(sql(query, 1).values).toEqual(['tenant-1', 'product-1', 'a1', 'a2']);
  });

  it('observes real empty sources, including a qualified false-membership asset query', async () => {
    const { tx, query, execute } = fixture([], []);
    expect(await readLockedEditorialReferences(tx, scope, [])).toEqual({
      ...scope,
      variantIds: [],
      assetIds: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(text(sql(query, 1))).toBe(
      'SELECT id FROM private_media_assets WHERE "tenantId" = ? AND "productId" = ? AND FALSE ORDER BY id FOR SHARE',
    );
    expect(sql(query, 1).values).toEqual(['tenant-1', 'product-1']);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'propagates source failure at query %i without writes or fallback',
    async (index) => {
      const { tx, query, execute } = fixture();
      const failure = new Error('source unavailable');
      query.mockReset();
      if (index === 1) query.mockResolvedValueOnce([]);
      query.mockRejectedValueOnce(failure);
      await expect(readLockedEditorialReferences(tx, scope, [])).rejects.toBe(
        failure,
      );
      expect(query).toHaveBeenCalledTimes(index + 1);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('keeps absent positives missing so strict validation still rejects them', async () => {
    const { tx } = fixture([], rows('a1'));
    const references = await readLockedEditorialReferences(tx, scope, [
      'missing',
      'a1',
    ]);
    expect(references.assetIds).toEqual(['a1']);
    const authority = { ...references, families: [] };
    expect(() =>
      validateDocument(
        { ...emptyDocument(), mediaRefs: ['missing'] },
        authority,
      ),
    ).toThrow('MALFORMED');
    expect(
      validateDocument({ ...emptyDocument(), mediaRefs: ['a1'] }, authority),
    ).toEqual({ ...emptyDocument(), mediaRefs: ['a1'] });
  });

  it('detaches the returned snapshot from source row arrays', async () => {
    const variants = rows('v1');
    const assets = rows('a1');
    const { tx } = fixture(variants, assets);
    const result = await readLockedEditorialReferences(tx, scope, ['a1']);
    variants[0].id = 'changed';
    variants.push({ id: 'added' });
    assets[0].id = 'changed';
    expect(result.variantIds).toEqual(['v1']);
    expect(result.assetIds).toEqual(['a1']);
  });

  it('binds SQL-looking IDs as values, not executable SQL', async () => {
    const { tx, query } = fixture([], []);
    const hostile = "a'); DELETE FROM variants; --";
    await readLockedEditorialReferences(tx, scope, [hostile]);
    expect(sql(query, 1).values).toEqual([
      scope.tenantId,
      scope.productId,
      hostile,
    ]);
    expect(text(sql(query, 1))).not.toContain(hostile);
  });

  it.each([
    [null, []],
    [{ tenantId: '', productId: 'p' }, []],
    [{ tenantId: 't', productId: ' ' }, []],
    [{ tenantId: 1, productId: 'p' }, []],
    [scope, null],
    [scope, ['a1', 1]],
    [scope, new Array(1)],
  ])(
    'rejects invalid internal inputs before any source observation (%j, %j)',
    async (inputScope, ids) => {
      const { tx, query, execute } = fixture();
      await expect(
        readLockedEditorialReferences(
          tx,
          inputScope as typeof scope,
          ids as string[],
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(query).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
