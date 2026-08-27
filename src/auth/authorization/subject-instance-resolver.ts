/**
 * SUBJECT-INSTANCE RESOLVER REGISTRY — delivery-routes / WU2 (ADR-5).
 *
 * Backward-compatible seam the `PermissionsGuard` consults to evaluate
 * CASL subject conditions on instance-scoped subjects. The base guard
 * evaluates `ability.can(action, subject)` with a STRING subject — CASL
 * does NOT evaluate rule conditions against string subjects, so a
 * `can('read', 'DeliveryRoute', { driverUserId })` rule is a false
 * positive. The guard re-checks with `subject('DeliveryRoute', {…})`
 * only when:
 *   1. the route exposes `request.params.id`,
 *   2. the registry has a resolver for the requested subject.
 *
 * Resolvers MUST:
 *   - Return `null` when the subject instance cannot be resolved
 *     (cross-tenant or missing). The guard does NOT throw on null — the
 *     service layer surfaces the proper 404.
 *   - Return a plain object that will be passed to `@casl/ability`'s
 *     `subject()` helper so the rule conditions evaluate against a
 *     typed subject.
 *
 * WU2 ships ONE resolver: `{ DeliveryRoute: ... }` registered by
 * `DeliveryRoutesModule` at module init time (via the static
 * `SubjectInstanceResolverRegistry` so we avoid a circular DI between
 * `AuthModule` (where the guard lives) and `DeliveryRoutesModule` (where
 * the resolver lives). The registry is a mutable Map; modules `register`
 * their resolver at bootstrap. The `PermissionsGuard` reads the
 * registry on every `canActivate` call so late registration works
 * without re-instantiating the guard.
 *
 * The seam is generic so future bounded contexts (e.g. promotions,
 * stock alerts) can register their own resolvers at boot.
 */
import type { Request } from 'express';
import type { AppSubjects } from './domain/permission';

export const SUBJECT_INSTANCE_RESOLVERS = Symbol.for(
  'SubjectInstanceResolvers',
);

export interface SubjectInstanceResolver {
  /**
   * Resolve the subject instance fields from the request. MUST return
   * `null` on miss (cross-tenant, not found) — the guard defers to the
   * service-layer 404. MUST return a plain object on hit (e.g.
   * `{ driverUserId }`).
   */
  resolveSubject(
    request: Request,
  ): Promise<Record<string, unknown> | null>;
}

export type SubjectInstanceResolverMap = Partial<
  Record<AppSubjects, SubjectInstanceResolver>
>;

/**
 * Module-scoped static registry used by the bounded contexts to wire
 * their resolver into the guard at module init time. Decoupled from
 * NestJS DI to keep the AuthModule ↔ DeliveryRoutesModule graph
 * acyclic; the Guard reads this map on every `canActivate` call so
 * late registration is safe.
 */
export class SubjectInstanceResolverRegistry {
  private static readonly map: SubjectInstanceResolverMap = {};

  static register(
    subject: AppSubjects,
    resolver: SubjectInstanceResolver,
  ): void {
    SubjectInstanceResolverRegistry.map[subject] = resolver;
  }

  static get(subject: AppSubjects): SubjectInstanceResolver | undefined {
    return SubjectInstanceResolverRegistry.map[subject];
  }

  /** Test seam — clears the registry between specs. Not used by prod. */
  static __resetForTests(): void {
    for (const key of Object.keys(SubjectInstanceResolverRegistry.map)) {
      delete SubjectInstanceResolverRegistry.map[
        key as keyof SubjectInstanceResolverMap
      ];
    }
  }
}
