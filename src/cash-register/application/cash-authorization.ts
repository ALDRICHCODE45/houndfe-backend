/**
 * cash-register-closing / T3 — CASL instance-condition rechecks (S3).
 *
 * The HTTP guard already gates the coarse permission, and it may evaluate
 * subject conditions on `request.params.id`. The application layer must not
 * trust that: it rechecks the ability on EVERY action against the actual row
 * and context (tenant, ownership, receiver) with `@casl/ability`'s `subject()`
 * helper, so a conditional rule (present or future) is evaluated against a
 * tagged instance instead of short-circuiting on a string subject.
 *
 * There are NO named-role checks. Permissions are arbitrary role
 * compositions; ownership/state/receiver constraints are enforced separately
 * by the adapter.
 */
import { subject as caslSubject } from '@casl/ability';
import type {
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { CashActor, CashCommand } from '../cash-application.port';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from './cash-application.errors';

export interface CashAbilityRequirement {
  readonly action: AppActions;
  readonly subject: AppSubjects;
}

/**
 * Coarse permission required by each write command. The guard uses the same
 * subject/action vocabulary; the adapter still rechecks instance conditions.
 */
export const CASH_COMMAND_ABILITY: Readonly<
  Record<CashCommand['kind'], CashAbilityRequirement>
> = {
  CREATE_REGISTER: { action: 'create', subject: 'CashRegister' },
  UPDATE_REGISTER: { action: 'update', subject: 'CashRegister' },
  OPEN_SESSION: { action: 'create', subject: 'CashSession' },
  CASH_IN: { action: 'create', subject: 'CashIn' },
  CASH_OUT: { action: 'create', subject: 'CashOut' },
  START_COUNT: { action: 'create', subject: 'CashCount' },
  DECLARE: { action: 'create', subject: 'CashCount' },
  ANNOTATE_DECLARATION: { action: 'create', subject: 'CashCount' },
  VERIFY: { action: 'create', subject: 'CashVerification' },
  CREATE_HANDOVER: { action: 'create', subject: 'CashHandover' },
  RECEIVE_HANDOVER: { action: 'update', subject: 'CashHandover' },
  // Release of the drawer is part of the outgoing custody allocation the
  // owner performs; the controller gates it with `create:CashHandover`.
  // Receipt (`update:CashHandover`) stays a separate recipient duty.
  RELEASE_DRAWER: { action: 'create', subject: 'CashHandover' },
  CLOSE: { action: 'create', subject: 'CashClosing' },
};

/**
 * Recheck a permission. When `instance` is supplied the check is evaluated
 * against a tagged CASL subject so conditional rules apply to the real row.
 */
export function assertAbility(
  actor: CashActor,
  requirement: CashAbilityRequirement,
  instance?: Record<string, unknown>,
): void {
  const target: unknown = instance
    ? caslSubject(requirement.subject, { ...instance })
    : requirement.subject;
  if (!actor.ability.can(requirement.action, target as AppSubjects)) {
    throw cashAppError(
      CASH_APPLICATION_CODES.PERMISSION_DENIED,
      `Missing permission ${requirement.action}:${requirement.subject}`,
      {
        action: requirement.action,
        subject: requirement.subject,
        userId: actor.userId,
      },
    );
  }
}

/** Convenience check returning a boolean (used for list-scope decisions). */
export function canAbility(
  actor: CashActor,
  requirement: CashAbilityRequirement,
): boolean {
  return actor.ability.can(requirement.action, requirement.subject);
}

/**
 * Per-row instance check returning a boolean. Unlike `canAbility`, the target
 * is a tagged CASL subject built from authoritative server-owned context, so
 * conditional rules ARE evaluated per row instead of short-circuiting on the
 * bare string subject. Used for list filtering and projection widening where
 * dropping the row (not throwing) is the correct fail-closed behavior.
 */
export function canInstanceAbility(
  actor: CashActor,
  requirement: CashAbilityRequirement,
  instance: Record<string, unknown>,
): boolean {
  // CASL's `subject()` mutates the target with a non-enumerable type tag, so
  // each check tags a shallow clone: the same row context can be checked
  // against several subjects (e.g. base then audit) without a re-cast error.
  const target: unknown = caslSubject(requirement.subject, { ...instance });
  return actor.ability.can(requirement.action, target as AppSubjects);
}

/** Wider session/custody reads require the granular audit subject. */
export const CASH_AUDIT_REQUIREMENT: CashAbilityRequirement = {
  action: 'read',
  subject: 'CashSessionAudit',
};

/** Any authenticated cash actor may list/read registers they can see. */
export const CASH_REGISTER_READ_REQUIREMENT: CashAbilityRequirement = {
  action: 'read',
  subject: 'CashRegister',
};

/** Any authenticated cash actor may list/read their own sessions. */
export const CASH_SESSION_READ_REQUIREMENT: CashAbilityRequirement = {
  action: 'read',
  subject: 'CashSession',
};

/**
 * S2 — recipient custody discovery (`read:CashHandover`). Granular on purpose:
 * `read:CashSessionAudit` is a wider session-visibility grant and must NOT be
 * accepted as a substitute for listing one's own pending/received handovers.
 */
export const CASH_HANDOVER_READ_REQUIREMENT: CashAbilityRequirement = {
  action: 'read',
  subject: 'CashHandover',
};

export const CASH_CLOSING_READ_REQUIREMENT: CashAbilityRequirement = {
  action: 'read',
  subject: 'CashClosing',
};
