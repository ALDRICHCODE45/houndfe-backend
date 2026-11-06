import { PrismaPublicCatalogRepository } from './prisma-public-catalog.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

type WithEditorial = (
  items: object[],
  invalid: Set<string>,
) => Promise<object[]>;

describe('Published document removed by a concurrent unpublish', () => {
  const repository = new PrismaPublicCatalogRepository(
    {} as PrismaService,
    {} as TenantPrismaService,
  );
  // SAFETY: exercises the private projection boundary directly; the race
  // (coverage read, then unpublish, then the product query) is not
  // reproducible deterministically through the public methods.
  const withEditorial: WithEditorial = (items, invalid) =>
    (repository as unknown as { withEditorial: WithEditorial }).withEditorial(
      items,
      invalid,
    );

  it.each([
    ['a null Published document', { publishedDocument: null }],
    ['no editorial state', null],
  ])(
    'drops the item for %s instead of failing the request',
    async (_, state) => {
      const invalid = new Set<string>();

      const result = await withEditorial(
        [{ id: 'p1', editorialState: state }],
        invalid,
      );

      expect(result).toEqual([]);
      expect(invalid.size).toBe(0);
    },
  );
});
