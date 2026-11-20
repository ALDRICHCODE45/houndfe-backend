/**
 * PORT: what a module learns when staff resolve a RESTOCK decision
 * (restock-backorder / T4; contract v1 §8). The resolve adapter
 * (`PrismaHumanDecisionReviewResolveRepository`, reached by
 * `POST /human-decisions/:id/resolve` and by the common request `resolve`
 * command) notifies the registered listeners AFTER the one-winner CAS wrote the
 * resolution and the wrapping request was closed, INSIDE the same transaction:
 * the listener's writes commit or roll back with the resolution.
 *
 * `human-decisions` knows nothing about the listener's domain (backorders
 * import this module, not the other way round): the listener registers itself
 * in its constructor with `RestockResolutionRegistry`, like the stock journal's
 * increase listener (no lifecycle hook: the pca-5b boot harness fails closed on
 * unreviewed ones).
 *
 * A replay (the resolution was already committed) never notifies: the event is
 * produced exactly once, by the winner of the CAS.
 */

/** The RESTOCK resolution the CAS just wrote (the only RESTOCK actions). */
export interface RestockResolvedEvent {
  tenantId: string;
  decisionId: string;
  action: 'PROVIDE_RESTOCK_ESTIMATE' | 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE';
  /** Set only for `PROVIDE_RESTOCK_ESTIMATE`. */
  restockDays: number | null;
  /** The `resolvedAt` written by the CAS (server clock). */
  resolvedAt: Date;
}

export interface RestockResolutionListener {
  /**
   * Runs in the resolver's ambient tenant transaction (`TenantPrismaService`
   * client). It may throw: the registry isolates it with a savepoint, so a
   * failing listener never blocks or rolls back the staff resolution.
   */
  onRestockResolved(event: RestockResolvedEvent): Promise<void>;
}
