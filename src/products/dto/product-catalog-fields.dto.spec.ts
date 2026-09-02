/**
 * Product online-catalog scalar fields — DTO validation contract tests
 * (design.md §6.1). Options mirror the global ValidationPipe in
 * `src/main.ts`: `transform: true`, `whitelist: true`,
 * `forbidNonWhitelisted: true`, no implicit conversion.
 * `supportedCatalogPriceListIds` is intentionally NOT whitelisted yet (a
 * later work unit adds it), so sending it must be rejected.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';

async function validateWith(
  dtoClass: new () => object,
  input: Record<string, unknown>,
): Promise<ValidationError[]> {
  const dto = plainToInstance(dtoClass, input); // transform: true — no implicit conversion
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

async function expectValid(
  dtoClass: new () => object,
  input: Record<string, unknown>,
) {
  const errors = await validateWith(dtoClass, input);
  expect(errors).toEqual([]);
}

async function expectRejected(
  dtoClass: new () => object,
  input: Record<string, unknown>,
  property: string,
) {
  const errors = await validateWith(dtoClass, input);
  expect(errors.some((e) => e.property === property)).toBe(true);
}

const CREATE_BASE = { name: 'Ibuprofeno 400' };
const NON_CUSTOM_MODES = [
  'SYSTEM_STATUS',
  'ABSTRACT_STATUS',
  'HIDDEN',
] as const;

describe('Product DTOs — online-catalog scalar fields (create)', () => {
  const validCases: [string, Record<string, unknown>][] = [
    [
      'valid boolean and custom quantity 0',
      {
        hidePriceInOnlineCatalog: true,
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 0,
      },
    ],
    ...NON_CUSTOM_MODES.map(
      (mode) =>
        [
          `${mode} with omitted quantity`,
          { onlineStockPresentation: mode },
        ] as [string, Record<string, unknown>],
    ),
    [
      'explicit null mode with null quantity',
      { onlineStockPresentation: null, onlineStockPresentationCustomQty: null },
    ],
    [
      'explicit null mode with omitted quantity',
      { onlineStockPresentation: null },
    ],
  ];

  it.each(validCases)('accepts %s', async (_label, fields) => {
    await expectValid(CreateProductDto, { ...CREATE_BASE, ...fields });
  });

  const invalidCases: [string, Record<string, unknown>, string][] = [
    [
      'unknown presentation mode',
      { onlineStockPresentation: 'VISIBLE' },
      'onlineStockPresentation',
    ],
    [
      'non-boolean hidePriceInOnlineCatalog',
      { hidePriceInOnlineCatalog: 'yes' },
      'hidePriceInOnlineCatalog',
    ],
    [
      'CUSTOM_QUANTITY without a quantity (create is strict)',
      { onlineStockPresentation: 'CUSTOM_QUANTITY' },
      'onlineStockPresentation',
    ],
    [
      'CUSTOM_QUANTITY with an explicit null quantity',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: null,
      },
      'onlineStockPresentationCustomQty',
    ],
    [
      'explicit null mode with a non-null quantity',
      { onlineStockPresentation: null, onlineStockPresentationCustomQty: 5 },
      'onlineStockPresentationCustomQty',
    ],
    [
      'an omitted mode with a quantity (create may not defer)',
      { onlineStockPresentationCustomQty: 5 },
      'onlineStockPresentationCustomQty',
    ],
    ['an unknown property', { bogus: 1 }, 'bogus'],
    [
      'the not-yet-supported price-list allowlist',
      { supportedCatalogPriceListIds: ['x'] },
      'supportedCatalogPriceListIds',
    ],
    ...[-1, 1.5, 'abc'].map(
      (qty) =>
        [
          `bad custom quantity ${String(qty)}`,
          {
            onlineStockPresentation: 'CUSTOM_QUANTITY',
            onlineStockPresentationCustomQty: qty,
          },
          'onlineStockPresentationCustomQty',
        ] as [string, Record<string, unknown>, string],
    ),
  ];

  it.each(invalidCases)('rejects %s', async (_label, fields, property) => {
    await expectRejected(
      CreateProductDto,
      { ...CREATE_BASE, ...fields },
      property,
    );
  });
});

describe('Product DTOs — online-catalog scalar fields (PATCH)', () => {
  const validCases: [string, Record<string, unknown>][] = [
    [
      'a full presentation update',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 3,
        hidePriceInOnlineCatalog: false,
      },
    ],
    [
      'an omitted mode with a quantity (deferred to merged-state service validation)',
      { onlineStockPresentationCustomQty: 5 },
    ],
    [
      'explicit null mode with null quantity',
      { onlineStockPresentation: null, onlineStockPresentationCustomQty: null },
    ],
    [
      'explicit null mode with omitted quantity',
      { onlineStockPresentation: null },
    ],
    ['a partial update without catalog fields', { name: 'Nuevo nombre' }],
  ];

  it.each(validCases)('accepts %s', async (_label, fields) => {
    await expectValid(UpdateProductDto, fields);
  });

  const invalidCases: [string, Record<string, unknown>, string][] = [
    [
      'CUSTOM_QUANTITY with an omitted quantity (PATCH null-skip is re-checked)',
      { onlineStockPresentation: 'CUSTOM_QUANTITY' },
      'onlineStockPresentation',
    ],
    [
      'CUSTOM_QUANTITY with an explicit null quantity',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: null,
      },
      'onlineStockPresentation',
    ],
    [
      'a non-custom mode with a non-null quantity',
      {
        onlineStockPresentation: 'SYSTEM_STATUS',
        onlineStockPresentationCustomQty: 5,
      },
      'onlineStockPresentationCustomQty',
    ],
    [
      'an unknown presentation mode',
      { onlineStockPresentation: 'VISIBLE' },
      'onlineStockPresentation',
    ],
    [
      'a non-boolean hidePriceInOnlineCatalog',
      { hidePriceInOnlineCatalog: 1 },
      'hidePriceInOnlineCatalog',
    ],
    [
      'a negative custom quantity',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: -2,
      },
      'onlineStockPresentationCustomQty',
    ],
    [
      'a non-integer custom quantity',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 2.5,
      },
      'onlineStockPresentationCustomQty',
    ],
    ['an unknown property', { bogus: true }, 'bogus'],
  ];

  it.each(invalidCases)('rejects %s', async (_label, fields, property) => {
    await expectRejected(UpdateProductDto, fields, property);
  });
});
