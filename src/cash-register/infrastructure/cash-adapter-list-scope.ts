/**
 * cash-redesign-reads S5 — decide whether a list's per-row CASL visibility
 * can be expressed as a DB `where` clause.
 *
 * List visibility is "own rows with the base read, every row with the audit
 * read", evaluated per row against a tagged instance (S3 of the closing
 * contract). When every rule relevant to both subjects is a plain,
 * unconditional, non-inverted allow (the shape `CaslAbilityFactory` emits for
 * every Cash* permission, including `manage:all`), that per-row check
 * reduces to a constant:
 *
 *   - any audit rule        → ALL rows of the tenant are visible;
 *   - else any base rule    → OWN rows only (owner columns = the actor);
 *   - else                  → NONE.
 *
 * Any conditional, inverted or field-restricted rule returns `PER_ROW`, so
 * the caller keeps the original in-memory per-row filter (fail-closed: a
 * conditional rule can never widen the total or leak a row).
 */
import type { CashAbilityRequirement } from '../application/cash-authorization';
import type { CashActor } from '../cash-application.port';

export type CashListScope = 'ALL' | 'OWN' | 'NONE' | 'PER_ROW';

interface RuleShape {
  readonly inverted: boolean;
  readonly conditions?: unknown;
  readonly fields?: unknown;
}

function isPlainAllow(rule: RuleShape): boolean {
  return (
    !rule.inverted && rule.conditions === undefined && rule.fields === undefined
  );
}

export function resolveListScope(
  actor: CashActor,
  base: CashAbilityRequirement,
  audit: CashAbilityRequirement,
): CashListScope {
  const auditRules = actor.ability.possibleRulesFor(
    audit.action,
    audit.subject,
  );
  const baseRules = actor.ability.possibleRulesFor(base.action, base.subject);
  if (![...auditRules, ...baseRules].every((rule) => isPlainAllow(rule))) {
    return 'PER_ROW';
  }
  if (auditRules.length > 0) {
    return 'ALL';
  }
  if (baseRules.length > 0) {
    return 'OWN';
  }
  return 'NONE';
}
