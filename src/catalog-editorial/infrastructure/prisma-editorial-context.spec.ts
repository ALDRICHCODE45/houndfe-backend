import type { Prisma } from '@prisma/client';
import { PrismaEditorialContext } from './prisma-editorial-context';

const scope = { tenantId: 'tenant', productId: 'product' };
it('queries the complete real list with parent/child tenant qualification and stable ordering', async () => {
  const variants = [
    { id: 'a', name: 'Same' },
    { id: 'b', name: 'Same' },
    { id: 'c', name: 'Z' },
  ];
  const query = jest.fn().mockResolvedValue([{ variants }]);
  const reader = new PrismaEditorialContext({ $queryRaw: query });
  expect(await reader.read(scope)).toEqual({ variants });
  expect(query).toHaveBeenCalledTimes(1);
  const [sql] = query.mock.calls[0] as [Prisma.Sql];
  expect(sql.values).toEqual(['tenant', 'product']);
  const text = sql.sql.replace(/\s+/g, ' ');
  expect(text).toContain('FROM products p');
  expect(text).toContain('p."tenantId" = ? AND p.id = ?');
  expect(text).toContain('FROM variants v');
  expect(text).toContain(
    'v."tenantId" = p."tenantId" AND v."productId" = p.id',
  );
  expect(text).toContain("jsonb_build_object('id', v.id, 'name', v.name)");
  expect(text).toContain('ORDER BY v.name, v.id');
  expect(text).toContain("'[]'::jsonb");
  expect(text).not.toMatch(/hasVariants|LIMIT|OFFSET|sku|price|stock/i);
});
it('distinguishes an empty list from a vanished qualified product and never caches', async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ variants: [] }])
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('unavailable'));
  const reader = new PrismaEditorialContext({ $queryRaw: query });
  await expect(reader.read(scope)).resolves.toEqual({ variants: [] });
  await expect(reader.read(scope)).rejects.toThrow('NOT_FOUND');
  await expect(reader.read(scope)).rejects.toThrow('unavailable');
});
