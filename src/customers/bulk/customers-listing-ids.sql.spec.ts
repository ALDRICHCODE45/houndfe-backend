import {
  buildListingPageSql,
  buildListingSummarySql,
} from '../listing/customers-listing.sql';
import type { CustomersListingReadInput } from '../listing/customer-listing.types';

const TENANT = 'tenant-1';
const ID_A = '3f2a9c1e-0000-4000-8000-00000000000a';
const ID_B = '3f2a9c1e-0000-4000-8000-00000000000b';

const base: CustomersListingReadInput = {
  filters: { city: ['León'] },
  sortBy: 'createdAt',
  sortOrder: 'desc',
  page: 1,
  limit: 50,
  metrics: null,
};

const builders = [
  ['page', buildListingPageSql],
  ['summary', buildListingSummarySql],
] as const;

describe('listing SQL — internal bulk id conditions (contract §2.3)', () => {
  it.each(builders)(
    '%s: without ids the statement has no id condition (GET /customers/listing unchanged)',
    (_name, build) => {
      const sql = build(TENANT, base);
      expect(sql.sql).not.toMatch(/c\."id" = ANY|c\."id" <> ALL/);
      // Same text and values as an explicit `ids: undefined`.
      const same = build(TENANT, { ...base, ids: undefined });
      expect(same.sql).toBe(sql.sql);
      expect(same.values).toEqual(sql.values);
    },
  );

  it.each(builders)(
    '%s: include → c."id" = ANY(bound ids) inside the candidates, tenant kept',
    (_name, build) => {
      const sql = build(TENANT, { ...base, ids: { include: [ID_A, ID_B] } });
      expect(sql.sql).toMatch(/c\."tenantId" = \?/);
      expect(sql.sql).toMatch(/c\."id" = ANY \(\?::text\[\]\)/);
      expect(sql.values).toContainEqual([ID_A, ID_B]);
    },
  );

  it.each(builders)(
    '%s: exclude → c."id" <> ALL(bound ids); an empty exclude list adds nothing',
    (_name, build) => {
      const sql = build(TENANT, { ...base, ids: { exclude: [ID_A] } });
      expect(sql.sql).toMatch(/c\."id" <> ALL \(\?::text\[\]\)/);
      expect(sql.values).toContainEqual([ID_A]);
      expect(build(TENANT, { ...base, ids: { exclude: [] } }).sql).toBe(
        build(TENANT, base).sql,
      );
    },
  );
});
