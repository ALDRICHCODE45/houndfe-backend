/**
 * Catalog-settings audit events (online-catalog-publishing / WU3B3).
 *
 * The literal `catalog-settings.updated` follows the existing project
 * event-naming convention (`sale.confirmed`, `sale.payment.received`, …):
 * dotted lowercase past-tense literals. The payload is deliberately
 * minimal and allowlisted: it names WHICH settings changed — never any
 * values, snapshots, binding ids, or other DTO/domain data.
 */
import type { UpdateCatalogSettingsDto } from '../../dto/update-catalog-settings.dto';

/** Canonical event name / `action` literal for the settings PATCH audit. */
export const CATALOG_SETTINGS_UPDATED = 'catalog-settings.updated' as const;

export type CatalogSettingsUpdatedEventName = typeof CATALOG_SETTINGS_UPDATED;

/**
 * The only PATCH keys that may appear in `changedFields`. Derived fields
 * are computed by filtering THIS list against the keys actually supplied
 * on the PATCH DTO, so the allowlist is the single source of truth.
 */
export const CATALOG_SETTINGS_CHANGED_FIELDS = [
  'catalogPublished',
  'publicPriceListIds',
  'catalogDefaultPriceListId',
  'stockPresentationDefault',
] as const;

export type CatalogSettingsChangedField =
  (typeof CATALOG_SETTINGS_CHANGED_FIELDS)[number];

/**
 * Audit payload emitted only AFTER `repository.replace` resolves
 * successfully. Top-level properties are exactly the five declared
 * constructor fields — nothing else may ride along.
 */
export class CatalogSettingsUpdatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly actorUserId: string,
    public readonly action: CatalogSettingsUpdatedEventName,
    public readonly occurredAt: string,
    public readonly changedFields: readonly CatalogSettingsChangedField[],
  ) {}
}

/**
 * Derives `changedFields` from the PATCH keys actually supplied
 * (`!== undefined`), restricted to the allowlist. Nested stock-presentation
 * objects contribute the field NAME only — never `mode`/`customQuantity`
 * values.
 */
export function deriveCatalogSettingsChangedFields(
  data: UpdateCatalogSettingsDto,
): CatalogSettingsChangedField[] {
  return CATALOG_SETTINGS_CHANGED_FIELDS.filter(
    (field) => data[field] !== undefined,
  );
}
