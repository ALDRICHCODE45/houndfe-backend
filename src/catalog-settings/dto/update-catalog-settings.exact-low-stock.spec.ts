/**
 * Public catalog v0 (S3) — the opt-in SYSTEM_STATUS_EXACT_LOW_STOCK mode is
 * accepted by the PATCH body and the aggregate, and takes no custom quantity.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCatalogSettingsDto } from './update-catalog-settings.dto';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';

async function errorsFor(stockPresentationDefault: unknown) {
  const dto = plainToInstance(UpdateCatalogSettingsDto, {
    stockPresentationDefault,
  });
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('stockPresentationDefault SYSTEM_STATUS_EXACT_LOW_STOCK', () => {
  it('is accepted by the PATCH DTO without a custom quantity', async () => {
    expect(
      await errorsFor({ mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK' }),
    ).toHaveLength(0);
    expect(
      await errorsFor({
        mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        customQuantity: null,
      }),
    ).toHaveLength(0);
  });

  it('rejects a custom quantity, like every non-CUSTOM mode', async () => {
    const errors = await errorsFor({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      customQuantity: 3,
    });
    expect(errors[0].children?.[0].property).toBe('customQuantity');
  });

  it('previous behavior holds: an unknown mode is still rejected', async () => {
    const errors = await errorsFor({ mode: 'EXACT' });
    expect(errors[0].children?.[0].property).toBe('mode');
  });

  it('is kept by the aggregate and exposed as the default', () => {
    const settings = TenantCatalogSettings.fromPersistence({
      tenant: {
        tenantId: 't1',
        isActive: true,
        catalogPublished: false,
        catalogRequiresPublishedEditorial: false,
        catalogStockPresentationDefault: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
        catalogStockPresentationDefaultCustomQty: null,
        updatedAt: new Date('2024-01-01'),
      },
      bindings: [],
    });
    expect(settings.stockPresentationDefault).toEqual({
      mode: 'SYSTEM_STATUS_EXACT_LOW_STOCK',
      customQuantity: null,
    });
  });
});
