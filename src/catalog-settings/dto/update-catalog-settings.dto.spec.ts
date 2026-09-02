/**
 * UpdateCatalogSettingsDto — validation tests for the PATCH
 * catalog-settings write contract (design.md §5.4), run under the same
 * `whitelist` + `forbidNonWhitelisted` + `transform` assumptions as the
 * global ValidationPipe (no implicit conversion). Covers strict types,
 * v4 UUID arrays/uniqueness, nullable default clearing, the
 * stock-presentation enum, the §927 conditional custom quantity, and
 * unknown-property rejection. Also covers the review-hardened
 * boundaries: explicit `null` is rejected on non-nullable PATCH fields
 * (omission is the only absence), and empty/whitespace `customQuantity`
 * strings never coerce to a passing zero. Repository/domain-dependent rules (list
 * existence, default being public, publish-requires-default) belong to
 * the use-case slice and are intentionally not tested here.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  StockPresentationSettingDto,
  UpdateCatalogSettingsDto,
} from './update-catalog-settings.dto';

const UUID_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const UUID_B = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_V1 = '6fa459ea-ee8a-11ca-b5fb-0800270e5b6e';

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(UpdateCatalogSettingsDto, input);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

function firstMessage(errors: ValidationError[]): string {
  return errors[0]?.constraints ? Object.values(errors[0].constraints)[0] : '';
}

describe('UpdateCatalogSettingsDto', () => {
  it('accepts an empty PATCH body', async () => {
    const { dto, errors } = await validateDto({});
    expect(errors).toHaveLength(0);
    expect(dto.catalogPublished).toBeUndefined();
    expect(dto.publicPriceListIds).toBeUndefined();
    expect(dto.catalogDefaultPriceListId).toBeUndefined();
    expect(dto.stockPresentationDefault).toBeUndefined();
  });

  it('accepts a full valid payload', async () => {
    const { dto, errors } = await validateDto({
      catalogPublished: true,
      publicPriceListIds: [UUID_A, UUID_B],
      catalogDefaultPriceListId: UUID_A,
      stockPresentationDefault: { mode: 'CUSTOM_QUANTITY', customQuantity: 4 },
    });
    expect(errors).toHaveLength(0);
    expect(dto.catalogPublished).toBe(true);
    expect(dto.publicPriceListIds).toEqual([UUID_A, UUID_B]);
    expect(dto.catalogDefaultPriceListId).toBe(UUID_A);
    expect(dto.stockPresentationDefault).toBeInstanceOf(
      StockPresentationSettingDto,
    );
    expect(dto.stockPresentationDefault?.mode).toBe('CUSTOM_QUANTITY');
    expect(dto.stockPresentationDefault?.customQuantity).toBe(4);
  });

  describe('catalogPublished', () => {
    it.each([true, false])('accepts %s', async (value) => {
      const { errors } = await validateDto({ catalogPublished: value });
      expect(errors).toHaveLength(0);
    });

    it.each(['true', 1])('rejects non-boolean %p', async (value) => {
      const { errors } = await validateDto({ catalogPublished: value });
      expect(errors[0].property).toBe('catalogPublished');
    });
  });

  describe('publicPriceListIds', () => {
    it('accepts an empty array and unique v4 UUIDs', async () => {
      expect(
        (await validateDto({ publicPriceListIds: [] })).errors,
      ).toHaveLength(0);
      const { errors } = await validateDto({
        publicPriceListIds: [UUID_A, UUID_B],
      });
      expect(errors).toHaveLength(0);
    });

    it.each([
      ['rejects duplicate UUIDs', [UUID_A, UUID_A]],
      ['rejects a non-v4 UUID', [UUID_V1]],
      ['rejects a malformed value', ['not-a-uuid']],
      ['rejects a non-array value', UUID_A],
    ])('%s', async (_name, value) => {
      const { errors } = await validateDto({ publicPriceListIds: value });
      expect(errors[0].property).toBe('publicPriceListIds');
    });
  });

  describe('catalogDefaultPriceListId', () => {
    it('accepts a v4 UUID', async () => {
      const { dto, errors } = await validateDto({
        catalogDefaultPriceListId: UUID_B,
      });
      expect(errors).toHaveLength(0);
      expect(dto.catalogDefaultPriceListId).toBe(UUID_B);
    });

    it('accepts an explicit null (clearing the default)', async () => {
      const { dto, errors } = await validateDto({
        catalogDefaultPriceListId: null,
      });
      expect(errors).toHaveLength(0);
      expect(dto.catalogDefaultPriceListId).toBeNull();
    });

    it.each([
      ['rejects a non-v4 UUID', UUID_V1],
      ['rejects a number', 42],
    ])('%s', async (_name, value) => {
      const { errors } = await validateDto({
        catalogDefaultPriceListId: value,
      });
      expect(errors[0].property).toBe('catalogDefaultPriceListId');
    });
  });

  describe('explicit null on non-nullable PATCH fields', () => {
    it.each([
      'catalogPublished',
      'publicPriceListIds',
      'stockPresentationDefault',
    ])('rejects null %s (omission is the only absence)', async (property) => {
      const { errors } = await validateDto({ [property]: null });
      expect(errors[0].property).toBe(property);
    });
  });

  describe('stockPresentationDefault', () => {
    it.each([
      ['SYSTEM_STATUS', null],
      ['ABSTRACT_STATUS', undefined],
      ['CUSTOM_QUANTITY', 0],
      ['HIDDEN', null],
    ])('accepts mode %s with customQuantity %p', async (mode, qty) => {
      const { dto, errors } = await validateDto({
        stockPresentationDefault: { mode, customQuantity: qty },
      });
      expect(errors).toHaveLength(0);
      expect(dto.stockPresentationDefault?.mode).toBe(mode);
    });

    it.each([
      ['rejects an unknown enum value', { mode: 'EVERYWHERE' }],
      ['rejects a missing mode', { customQuantity: 2 }],
    ])('%s', async (_name, payload) => {
      const { errors } = await validateDto({
        stockPresentationDefault: payload,
      });
      expect(errors[0].property).toBe('stockPresentationDefault');
      expect(errors[0].children?.[0].property).toBe('mode');
    });

    it.each([
      ['rejects a non-object payload', 'HIDDEN'],
      ['rejects an array payload', []],
    ])('%s', async (_name, payload) => {
      const { errors } = await validateDto({
        stockPresentationDefault: payload,
      });
      expect(errors[0].property).toBe('stockPresentationDefault');
      expect(errors[0].children).toHaveLength(0);
    });
  });

  describe('conditional custom quantity (design.md §927)', () => {
    it.each([
      ['missing qty', { mode: 'CUSTOM_QUANTITY' }],
      ['null qty', { mode: 'CUSTOM_QUANTITY', customQuantity: null }],
      ['negative qty', { mode: 'CUSTOM_QUANTITY', customQuantity: -1 }],
      ['non-integer qty', { mode: 'CUSTOM_QUANTITY', customQuantity: 1.5 }],
      ['non-numeric qty', { mode: 'CUSTOM_QUANTITY', customQuantity: 'abc' }],
      ['qty for non-CUSTOM mode', { mode: 'HIDDEN', customQuantity: 3 }],
    ])('rejects %s', async (_name, payload) => {
      const { errors } = await validateDto({
        stockPresentationDefault: payload,
      });
      expect(errors[0].children?.[0].property).toBe('customQuantity');
    });

    it.each([
      ['', 'CUSTOM_QUANTITY'],
      ['  ', 'CUSTOM_QUANTITY'],
      [true, 'CUSTOM_QUANTITY'],
      ['', 'HIDDEN'],
    ])('rejects %p customQuantity for mode %s', async (qty, mode) => {
      const { errors } = await validateDto({
        stockPresentationDefault: { mode, customQuantity: qty },
      });
      expect(errors[0].children?.[0].property).toBe('customQuantity');
    });

    it('accepts numeric-string qty and preserves null', async () => {
      const numeric = await validateDto({
        stockPresentationDefault: {
          mode: 'CUSTOM_QUANTITY',
          customQuantity: '4',
        },
      });
      expect(numeric.errors).toHaveLength(0);
      expect(numeric.dto.stockPresentationDefault?.customQuantity).toBe(4);
      const nullQty = await validateDto({
        stockPresentationDefault: {
          mode: 'SYSTEM_STATUS',
          customQuantity: null,
        },
      });
      expect(nullQty.errors).toHaveLength(0);
      expect(nullQty.dto.stockPresentationDefault?.customQuantity).toBeNull();
    });

    it('messages state the cross-field rule', async () => {
      const missing = await validateDto({
        stockPresentationDefault: { mode: 'CUSTOM_QUANTITY' },
      });
      expect(firstMessage(missing.errors[0].children ?? [])).toContain('>= 0');
      const extra = await validateDto({
        stockPresentationDefault: { mode: 'HIDDEN', customQuantity: 3 },
      });
      expect(firstMessage(extra.errors[0].children ?? [])).toContain(
        'CUSTOM_QUANTITY',
      );
    });
  });

  describe('unknown properties (forbidNonWhitelisted)', () => {
    it('rejects unknown top-level and nested properties', async () => {
      const { errors } = await validateDto({ catalogPublised: true });
      expect(errors[0].property).toBe('catalogPublised');
      expect(errors[0].constraints?.whitelistValidation).toBeDefined();
      const nested = await validateDto({
        stockPresentationDefault: { mode: 'HIDDEN', qty: 3 },
      });
      expect(nested.errors[0].children?.[0].property).toBe('qty');
      expect(
        nested.errors[0].children?.[0].constraints?.whitelistValidation,
      ).toBeDefined();
    });
  });
});
