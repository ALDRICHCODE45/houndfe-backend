/**
 * APPLICATION SPEC: eligible-sales CASL Sale row scope — delivery-routes / T4.
 *
 * `buildSaleReadScope` must be EQUIVALENT to CASL's own `ability.can` for
 * every row, including SQL NULL semantics:
 *   - `$ne` / `$nin` accept a NULL field value in CASL (null !== x, null not
 *     in [...]), while a bare Prisma `not`/`notIn` excludes NULL — so nullable
 *     fields must compile an explicit `IS NULL` branch;
 *   - a priority `NOT` complement must not turn a NULL row into UNKNOWN — the
 *     inner predicate is made total (never UNKNOWN) so SQL `NOT` matches the
 *     CASL complement exactly.
 *
 * The evaluator below models Prisma/SQL three-valued logic (TRUE/FALSE/
 * UNKNOWN) instead of JS negation, so a NULL regression is observable.
 */
import { createMongoAbility, subject as caslSubject } from '@casl/ability';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { buildSaleReadScope } from './eligible-sales-sale-scope';

const ability = (rules: unknown[]): AppAbility =>
  createMongoAbility(rules as never) as unknown as AppAbility;

const IMPOSSIBLE = { id: { in: [] } };

interface SaleRow {
  id: string;
  userId: string;
  sellerUserId: string | null;
  customerId: string | null;
  tenantId: string;
}

type Tri = 'TRUE' | 'FALSE' | 'UNKNOWN';

const andTri = (values: Tri[]): Tri =>
  values.includes('FALSE')
    ? 'FALSE'
    : values.includes('UNKNOWN')
      ? 'UNKNOWN'
      : 'TRUE';

const orTri = (values: Tri[]): Tri =>
  values.includes('TRUE')
    ? 'TRUE'
    : values.includes('UNKNOWN')
      ? 'UNKNOWN'
      : 'FALSE';

const notTri = (value: Tri): Tri =>
  value === 'TRUE' ? 'FALSE' : value === 'FALSE' ? 'TRUE' : 'UNKNOWN';

/** Test-only SQL three-valued evaluator for the Prisma shapes emitted. */
function evalScope(scope: unknown, row: SaleRow): Tri {
  if (scope === null || scope === undefined) return 'TRUE';
  const clause = scope as Record<string, unknown>;
  if (Object.keys(clause).length === 0) return 'TRUE';
  if ('AND' in clause) {
    return andTri((clause.AND as unknown[]).map((c) => evalScope(c, row)));
  }
  if ('OR' in clause) {
    return orTri((clause.OR as unknown[]).map((c) => evalScope(c, row)));
  }
  if ('NOT' in clause) return notTri(evalScope(clause.NOT, row));
  return andTri(
    Object.entries(clause).map(([field, condition]) =>
      evalField((row as unknown as Record<string, unknown>)[field], condition),
    ),
  );
}

function evalField(value: unknown, condition: unknown): Tri {
  if (condition === null) return value === null ? 'TRUE' : 'FALSE';
  if (typeof condition === 'string') {
    return value === null ? 'UNKNOWN' : value === condition ? 'TRUE' : 'FALSE';
  }
  return andTri(
    Object.entries(condition as Record<string, unknown>).map(([op, operand]) =>
      evalOperator(value, op, operand),
    ),
  );
}

function evalOperator(value: unknown, op: string, operand: unknown): Tri {
  if (op === 'not' && operand === null) {
    // Prisma `{ not: null }` compiles to IS NOT NULL (total, not UNKNOWN).
    return value === null ? 'FALSE' : 'TRUE';
  }
  if (value === null) return 'UNKNOWN';
  switch (op) {
    case 'equals':
      return value === operand ? 'TRUE' : 'FALSE';
    case 'not':
      return value !== operand ? 'TRUE' : 'FALSE';
    case 'in':
      return (operand as unknown[]).includes(value) ? 'TRUE' : 'FALSE';
    case 'notIn':
      return !(operand as unknown[]).includes(value) ? 'TRUE' : 'FALSE';
    case 'gt':
      return (value as string) > (operand as string) ? 'TRUE' : 'FALSE';
    case 'gte':
      return (value as string) >= (operand as string) ? 'TRUE' : 'FALSE';
    case 'lt':
      return (value as string) < (operand as string) ? 'TRUE' : 'FALSE';
    case 'lte':
      return (value as string) <= (operand as string) ? 'TRUE' : 'FALSE';
    default:
      throw new Error(`unsupported matcher operator: ${op}`);
  }
}

const matches = (scope: unknown, row: SaleRow): boolean =>
  evalScope(scope, row) === 'TRUE';

describe('buildSaleReadScope — strict operator translation', () => {
  it('does not treat non-CASL keys (in/notIn/equals) as operators', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { userId: { in: ['u1'] } },
          },
        ]),
      ),
    ).toEqual(IMPOSSIBLE);
  });

  it('rejects a mix of known and unknown operators instead of dropping the unknown', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { userId: { $in: ['u1'], $regex: 'u' } },
          },
        ]),
      ),
    ).toEqual(IMPOSSIBLE);
  });

  it('rejects a nested object value without operators', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { userId: { foo: 'bar' } },
          },
        ]),
      ),
    ).toEqual(IMPOSSIBLE);
  });

  it('rejects an array value', () => {
    expect(
      buildSaleReadScope(
        ability([
          { action: 'read', subject: 'Sale', conditions: { userId: ['u1'] } },
        ]),
      ),
    ).toEqual(IMPOSSIBLE);
  });

  it('rejects a top-level logical operator', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { $or: [{ userId: 'u1' }] },
          },
        ]),
      ),
    ).toEqual(IMPOSSIBLE);
  });

  it('translates the real CASL/Mongo operators on non-null fields', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: {
              userId: { $in: ['u1', 'u2'] },
              tenantId: { $gt: 't1', $lte: 't9' },
            },
          },
        ]),
      ),
    ).toEqual({
      AND: [
        { userId: { in: ['u1', 'u2'] } },
        { tenantId: { gt: 't1', lte: 't9' } },
      ],
    });
  });

  it('translates a bare scalar value as equality on a non-null field', () => {
    expect(
      buildSaleReadScope(
        ability([
          { action: 'read', subject: 'Sale', conditions: { userId: 'u9' } },
        ]),
      ),
    ).toEqual({ userId: 'u9' });
  });

  it('expands a nullable $ne with an explicit IS NULL branch', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { customerId: { $ne: 'c2' } },
          },
        ]),
      ),
    ).toEqual({
      OR: [
        { customerId: null },
        {
          AND: [{ customerId: { not: null } }, { customerId: { not: 'c2' } }],
        },
      ],
    });
  });

  it('guards a nullable equality with IS NOT NULL so NOT stays total', () => {
    expect(
      buildSaleReadScope(
        ability([
          {
            action: 'read',
            subject: 'Sale',
            conditions: { customerId: 'c2' },
          },
        ]),
      ),
    ).toEqual({
      AND: [{ customerId: { not: null } }, { customerId: 'c2' }],
    });
  });
});

describe('buildSaleReadScope — equivalence with ability.can on tagged Sale rows', () => {
  const rows: SaleRow[] = [
    {
      id: 's1',
      userId: 'u1',
      sellerUserId: 's1',
      customerId: 'c1',
      tenantId: 't1',
    },
    {
      id: 's2',
      userId: 'u2',
      sellerUserId: 's2',
      customerId: 'c2',
      tenantId: 't1',
    },
    {
      id: 's3',
      userId: 'u1',
      sellerUserId: 's2',
      customerId: 'c2',
      tenantId: 't2',
    },
    // NULL customerId / sellerUserId — the under-return regression rows.
    {
      id: 's4',
      userId: 'u3',
      sellerUserId: null,
      customerId: null,
      tenantId: 't1',
    },
    {
      id: 's5',
      userId: 'u1',
      sellerUserId: null,
      customerId: 'c2',
      tenantId: 't2',
    },
  ];

  const ruleSets: Array<{ name: string; rules: unknown[] }> = [
    {
      name: 'unconditional allow',
      rules: [{ action: 'read', subject: 'Sale' }],
    },
    { name: 'manage all', rules: [{ action: 'manage', subject: 'all' }] },
    {
      name: 'conditional equals (non-null)',
      rules: [
        { action: 'read', subject: 'Sale', conditions: { userId: 'u1' } },
      ],
    },
    {
      name: 'conditional equals (nullable)',
      rules: [
        { action: 'read', subject: 'Sale', conditions: { customerId: 'c2' } },
      ],
    },
    {
      name: 'nullable $ne allow',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          conditions: { customerId: { $ne: 'c2' } },
        },
      ],
    },
    {
      name: 'nullable $nin allow',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          conditions: { customerId: { $nin: ['c2'] } },
        },
      ],
    },
    {
      name: 'conditional $in',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          conditions: { userId: { $in: ['u1', 'u2'] } },
        },
      ],
    },
    {
      name: 'two conditional grants OR',
      rules: [
        { action: 'read', subject: 'Sale', conditions: { userId: 'u1' } },
        { action: 'read', subject: 'Sale', conditions: { sellerUserId: 's2' } },
      ],
    },
    {
      name: 'deny-only rule',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { tenantId: 't2' },
        },
      ],
    },
    {
      name: 'deny then allow (later rule wins)',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { tenantId: 't2' },
        },
        { action: 'read', subject: 'Sale' },
      ],
    },
    {
      name: 'allow then deny non-null (later rule wins)',
      rules: [
        { action: 'read', subject: 'Sale' },
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { tenantId: 't2' },
        },
      ],
    },
    {
      name: 'allow then deny nullable equality (NULL complement)',
      rules: [
        { action: 'read', subject: 'Sale' },
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { customerId: 'c2' },
        },
      ],
    },
    {
      name: 'allow then deny nullable $ne (NULL complement)',
      rules: [
        { action: 'read', subject: 'Sale' },
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { customerId: { $ne: 'c2' } },
        },
      ],
    },
    {
      name: 'allow conditional then deny conditional',
      rules: [
        { action: 'read', subject: 'Sale', conditions: { userId: 'u1' } },
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { tenantId: 't2' },
        },
      ],
    },
    {
      name: 'deny conditional then allow conditional',
      rules: [
        {
          action: 'read',
          subject: 'Sale',
          inverted: true,
          conditions: { userId: 'u1' },
        },
        { action: 'read', subject: 'Sale', conditions: { customerId: 'c2' } },
      ],
    },
  ];

  for (const ruleSet of ruleSets) {
    it(`matches ability.can for: ${ruleSet.name}`, () => {
      const subjectAbility = ability(ruleSet.rules);
      const scope = buildSaleReadScope(subjectAbility);

      for (const row of rows) {
        // SAFETY: `caslSubject()` returns a tagged object whose runtime tag
        // drives CASL condition matching; the cast only satisfies the ability
        // overload's subject type.
        const tagged = caslSubject('Sale', row) as unknown as Parameters<
          typeof subjectAbility.can
        >[1];
        const expected = subjectAbility.can('read', tagged);
        expect(matches(scope, row)).toBe(expected);
      }
    });
  }
});
