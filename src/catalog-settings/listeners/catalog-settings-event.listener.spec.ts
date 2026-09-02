import { Logger } from '@nestjs/common';
import {
  CATALOG_SETTINGS_UPDATED,
  CatalogSettingsUpdatedEvent,
} from '../application/events/catalog-settings.events';
import { CatalogSettingsEventListener } from './catalog-settings-event.listener';

const event = () =>
  new CatalogSettingsUpdatedEvent(
    't1',
    'actor-1',
    CATALOG_SETTINGS_UPDATED,
    '2024-06-01T10:00:00.000Z',
    ['catalogPublished', 'publicPriceListIds'],
  );

describe('CatalogSettingsEventListener', () => {
  const listener = () => new CatalogSettingsEventListener();
  const logSpy = () => jest.spyOn(Logger.prototype, 'log').mockImplementation();

  afterEach(() => jest.restoreAllMocks());

  it('logs a structured audit line without setting values or ids', () => {
    const spy = logSpy();
    listener().onCatalogSettingsUpdated(event());
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(
      [
        'actorUserId',
        'changedFields',
        'eventType',
        'occurredAt',
        'tenantId',
      ].sort(),
    );
    expect(line).toEqual({
      eventType: 'catalog-settings.updated',
      tenantId: 't1',
      actorUserId: 'actor-1',
      changedFields: ['catalogPublished', 'publicPriceListIds'],
      occurredAt: '2024-06-01T10:00:00.000Z',
    });
  });

  it('never throws when the logger fails', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(() => listener().onCatalogSettingsUpdated(event())).not.toThrow();
  });
});
