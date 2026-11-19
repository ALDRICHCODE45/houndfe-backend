/**
 * quotation-sale-conversion / T1 (S7) — HTTP adapter contract: CASL
 * permission pairs, Idempotency-Key requirement, delegation, and module
 * registration. The use-case behavior is covered by the integration spec.
 */
import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { QuotationSaleConversionService } from '../application/quotation-sale-conversion.service';
import { QuotationsModule } from '../quotations.module';
import { QuotationSaleConversionService as ConversionServiceClass } from '../application/quotation-sale-conversion.service';
import { PrismaQuotationSaleConversionStore } from '../infrastructure/prisma-quotation-sale-conversion.store';
import { QuotationSaleConversionController } from './quotation-sale-conversion.controller';

const user = { userId: 'user-1' } as AuthenticatedUser;

describe('QuotationSaleConversionController', () => {
  const service = {
    createFromSaleDraft: jest.fn().mockResolvedValue({ ok: 'from-sale' }),
    convertToSale: jest.fn().mockResolvedValue({ ok: 'to-sale' }),
  };
  const controller = new QuotationSaleConversionController(
    service as unknown as QuotationSaleConversionService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('requires create:Quotation AND delete:Sale to turn a draft sale into a quotation', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        QuotationSaleConversionController.prototype.createFromSale,
      ),
    ).toEqual([
      ['create', 'Quotation'],
      ['delete', 'Sale'],
    ]);
  });

  it('requires create:Sale AND update:Quotation to convert a quotation into a sale', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        QuotationSaleConversionController.prototype.convertToSale,
      ),
    ).toEqual([
      ['create', 'Sale'],
      ['update', 'Quotation'],
    ]);
  });

  it('rejects a missing / blank Idempotency-Key with 400 IDEMPOTENCY_KEY_REQUIRED before calling the service', () => {
    expect(() => controller.convertToSale('q-1', undefined, user)).toThrow(
      BadRequestException,
    );
    expect(() => controller.createFromSale('s-1', {}, '   ', user)).toThrow(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(service.convertToSale).not.toHaveBeenCalled();
    expect(service.createFromSaleDraft).not.toHaveBeenCalled();
  });

  it('delegates with the actor, the trimmed key and the notes', async () => {
    await expect(
      controller.createFromSale(
        's-1',
        { customerNotes: 'hola' },
        ' k-1 ',
        user,
      ),
    ).resolves.toEqual({ ok: 'from-sale' });
    expect(service.createFromSaleDraft).toHaveBeenCalledWith(
      's-1',
      'user-1',
      { customerNotes: 'hola' },
      'k-1',
    );

    await expect(controller.convertToSale('q-1', 'k-2', user)).resolves.toEqual(
      { ok: 'to-sale' },
    );
    expect(service.convertToSale).toHaveBeenCalledWith('q-1', 'user-1', 'k-2');
  });

  it('is registered in QuotationsModule with its service and store', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      QuotationsModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      QuotationsModule,
    ) as unknown[];
    expect(controllers).toContain(QuotationSaleConversionController);
    expect(providers).toEqual(
      expect.arrayContaining([
        ConversionServiceClass,
        PrismaQuotationSaleConversionStore,
      ]),
    );
  });
});
