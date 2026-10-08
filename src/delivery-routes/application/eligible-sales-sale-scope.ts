/**
 * APPLICATION HELPER: eligible-sales CASL Sale row scope — delivery-routes / T4.
 *
 * Translates the caller's `read:Sale` CASL rules into a Prisma
 * `SaleWhereInput` that is EQUIVALENT to CASL's own `ability.can` for every
 * row, including SQL NULL semantics, instead of assuming a coarse blanket
 * grant.
 *
 * STRICT OPERATORS. Only the real CASL/Mongo operators are accepted:
 * `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte` (plus a bare
 * scalar meaning equality). Any other operator, a non-operator key, a
 * logical operator, an array or a nested object is rejected — the whole
 * scope fails closed (`{ id: { in: [] } }`), so an unknown/extra key can
 * NEVER be silently dropped into a wider scope.
 *
 * NULLABLE FIELDS. `sale.sellerUserId` and `sale.customerId` are nullable
 * (see Prisma schema). CASL compares in JS (`null !== x`, `null` not in
 * `[...]`), while a bare Prisma `not`/`notIn` excludes NULL. Each nullable
 * field therefore compiles an explicit `IS NULL` branch (for `$ne`/`$nin`)
 * or an `IS NOT NULL` guard, so the field predicate is TOTAL (never UNKNOWN).
 *
 * PRIORITY. `ability.rulesFor` returns rules from highest to lowest
 * precedence; CASL's `can` is "first matching rule wins". Because every
 * rule predicate is total, the display is exactly:
 *
 *   OR over each non-inverted rule i:
 *     matches(rule_i) AND NOT( matches(rule_1) OR … OR matches(rule_{i-1}) )
 *
 * emitted as nested Prisma `OR` / `AND` / `NOT` clauses. An unconditional
 * rule is represented by `{}` (matches every row).
 */
import type { Prisma } from '@prisma/client';
import type { AppAbility } from '../../auth/authorization/domain/permission';

const IMPOSSIBLE_SALE_SCOPE: Prisma.SaleWhereInput = { id: { in: [] } };

const SUPPORTED_SALE_CONDITION_KEYS = new Set([
  'id',
  'userId',
  'sellerUserId',
  'customerId',
  'tenantId',
]);

/** Nullable Sale columns — see prisma/schema.prisma (String?). */
const NULLABLE_SALE_CONDITION_KEYS = new Set(['sellerUserId', 'customerId']);

type RuleLike = {
  inverted?: boolean;
  conditions?: Record<string, unknown>;
};

type TranslateResult =
  | { ok: true; where: Prisma.SaleWhereInput }
  | { ok: false };

type FieldTranslation =
  | {
      ok: true;
      /** Condition is exactly `null` (IS NULL). */
      exactNull: boolean;
      /** CASL predicate is true for a NULL field value. */
      nullMatches: boolean;
      /** Prisma filter for the non-null values. */
      nonNullFilter: Prisma.StringFilter | string | null;
    }
  | { ok: false };

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * Translate a CASL condition VALUE for one scalar field. Rejects every
 * unsupported operator/shape; never drops an extra key.
 */
function translateFieldCondition(value: unknown): FieldTranslation {
  if (value === null) {
    return {
      ok: true,
      exactNull: true,
      nullMatches: true,
      nonNullFilter: null,
    };
  }
  if (typeof value === 'string') {
    return {
      ok: true,
      exactNull: false,
      nullMatches: false,
      nonNullFilter: value,
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };

  const raw = value as Record<string, unknown>;
  const operators = Object.keys(raw);
  if (operators.length === 0) return { ok: false };

  const filter: Prisma.StringFilter = {};
  let nullMatches = true;
  for (const operator of operators) {
    const operand = raw[operator];
    switch (operator) {
      case '$eq':
        if (typeof operand !== 'string') return { ok: false };
        filter.equals = operand;
        nullMatches = false;
        break;
      case '$ne':
        if (typeof operand !== 'string') return { ok: false };
        filter.not = operand;
        break;
      case '$in':
        if (!isStringArray(operand)) return { ok: false };
        filter.in = operand;
        nullMatches = false;
        break;
      case '$nin':
        if (!isStringArray(operand)) return { ok: false };
        filter.notIn = operand;
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (typeof operand !== 'string') return { ok: false };
        filter[operator.slice(1) as 'gt' | 'gte' | 'lt' | 'lte'] = operand;
        nullMatches = false;
        break;
      default:
        // Unknown/extra operator → reject the whole condition.
        return { ok: false };
    }
  }
  return { ok: true, exactNull: false, nullMatches, nonNullFilter: filter };
}

function fieldValueClause(
  field: string,
  value: string | Prisma.StringFilter | null,
): Prisma.SaleWhereInput {
  return { [field]: value } as Prisma.SaleWhereInput;
}

function fieldNotNullClause(field: string): Prisma.SaleWhereInput {
  return { [field]: { not: null } } as Prisma.SaleWhereInput;
}

/**
 * Build a TOTAL (never UNKNOWN) per-field clause so a later `NOT` in the
 * priority composition complements it exactly. Non-null columns are already
 * total; nullable columns get an explicit NULL branch.
 */
function buildFieldClause(
  field: string,
  translation: Extract<FieldTranslation, { ok: true }>,
): Prisma.SaleWhereInput {
  if (translation.exactNull) return fieldValueClause(field, null);

  const nonNull = fieldValueClause(field, translation.nonNullFilter);
  if (!NULLABLE_SALE_CONDITION_KEYS.has(field)) return nonNull;

  if (translation.nullMatches) {
    // `$ne`/`$nin`: NULL satisfies the CASL predicate → IS NULL OR (IS NOT
    // NULL AND filter).
    return {
      OR: [
        fieldValueClause(field, null),
        { AND: [fieldNotNullClause(field), nonNull] },
      ],
    };
  }
  // Equality / `$in` / range: NULL never matches, but must be FALSE (not
  // UNKNOWN) so a higher-precedence NOT complements it correctly.
  return { AND: [fieldNotNullClause(field), nonNull] };
}

function translateConditions(
  conditions: Record<string, unknown>,
): TranslateResult {
  const clauses: Prisma.SaleWhereInput[] = [];
  for (const [key, value] of Object.entries(conditions)) {
    // Logical operators ($and/$or/$nor/$not) are not translated.
    if (key.startsWith('$')) return { ok: false };
    if (!SUPPORTED_SALE_CONDITION_KEYS.has(key)) return { ok: false };
    const translated = translateFieldCondition(value);
    if (!translated.ok) return { ok: false };
    clauses.push(buildFieldClause(key, translated));
  }
  return {
    ok: true,
    where: clauses.length === 1 ? clauses[0] : { AND: clauses },
  };
}

interface CompiledRule {
  inverted: boolean;
  matchesAll: boolean;
  where: Prisma.SaleWhereInput;
}

export function buildSaleReadScope(
  ability: AppAbility,
): Prisma.SaleWhereInput | null {
  // SAFETY: CASL types `conditions` as `any` on this open-conditions ability;
  // `RuleLike` is the structural subset this translator reads, and the
  // `conditions` keys/operators are re-validated against the allowlists above.
  const rules = ability.rulesFor('read', 'Sale') as unknown as RuleLike[];
  if (rules.length === 0) return IMPOSSIBLE_SALE_SCOPE;

  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const conditions = rule.conditions;
    const hasConditions = Boolean(
      conditions && Object.keys(conditions).length > 0,
    );
    if (!hasConditions) {
      compiled.push({
        inverted: Boolean(rule.inverted),
        matchesAll: true,
        where: {},
      });
      continue;
    }
    const translated = translateConditions(
      conditions as Record<string, unknown>,
    );
    if (!translated.ok) return IMPOSSIBLE_SALE_SCOPE;
    compiled.push({
      inverted: Boolean(rule.inverted),
      matchesAll: false,
      where: translated.where,
    });
  }

  // First-match-wins: readable(x) = OR_i [ non-inverted(rule_i) AND
  // matches(rule_i) AND NOT(OR_{j<i} matches(rule_j)) ].
  const terms: Prisma.SaleWhereInput[] = [];
  for (let index = 0; index < compiled.length; index++) {
    const rule = compiled[index];
    if (rule.inverted) continue;

    const prior = compiled.slice(0, index);
    if (prior.length === 0) {
      terms.push(rule.matchesAll ? {} : rule.where);
      continue;
    }
    // A higher-precedence rule that matches every row makes every later term
    // unreachable (the first match already decided).
    const priorMatchesAll = prior.some((priorRule) => priorRule.matchesAll);
    const notPrior: Prisma.SaleWhereInput = priorMatchesAll
      ? IMPOSSIBLE_SALE_SCOPE
      : {
          NOT:
            prior.length === 1
              ? prior[0].where
              : { OR: prior.map((priorRule) => priorRule.where) },
        };
    terms.push(rule.matchesAll ? notPrior : { AND: [rule.where, notPrior] });
  }

  if (terms.length === 0) return IMPOSSIBLE_SALE_SCOPE;
  // The highest-precedence rule is an unconditional allow → tenant-wide.
  if (Object.keys(terms[0]).length === 0) return null;
  return terms.length === 1 ? terms[0] : { OR: terms };
}
