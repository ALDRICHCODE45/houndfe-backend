/**
 * CatalogSettingsEventListener — structured audit logging for
 * `catalog-settings.updated` (online-catalog-publishing / WU3B3).
 *
 * Mirrors the `SaleEventListener` conventions (`src/sales/listeners/
 * sale-event.listener.ts`): `@Injectable()`, one `@OnEvent` handler per
 * event, and a single structured `logger.log({...})` object. The log
 * carries only the allowlisted payload fields (who/when/which settings) —
 * it must never contain setting values, price-list ids, or snapshots.
 *
 * Logging is best effort: a logger failure is caught and never propagates
 * back to the emitter (the PATCH that already committed must not fail).
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CATALOG_SETTINGS_UPDATED,
  CatalogSettingsUpdatedEvent,
} from '../application/events/catalog-settings.events';

@Injectable()
export class CatalogSettingsEventListener {
  private readonly logger = new Logger(CatalogSettingsEventListener.name);

  @OnEvent(CATALOG_SETTINGS_UPDATED)
  onCatalogSettingsUpdated(event: CatalogSettingsUpdatedEvent): void {
    try {
      this.logger.log({
        eventType: CATALOG_SETTINGS_UPDATED,
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        changedFields: event.changedFields,
        occurredAt: event.occurredAt,
      });
    } catch {
      // Best effort: a logger failure must never reach the event emitter.
    }
  }
}
