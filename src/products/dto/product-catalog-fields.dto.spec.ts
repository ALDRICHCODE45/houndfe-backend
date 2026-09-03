/**
 * Product online-catalog scalar fields — DTO validation contract tests
 * (design.md §6.1). Options mirror the global ValidationPipe in
 * `src/main.ts`: `transform: true`, `whitelist: true`,
 * `forbidNonWhitelisted: true`, no implicit conversion.
 * `supportedCatalogPriceListIds` carries the strict WU4c1 request contract:
 * omitted/`[]` accepted, otherwise a UUID v4 array unique case-insensitively
 * (textual case variants of the same UUID are duplicates) — an explicit `null`
 * is rejected on create AND PATCH (undefined-only optionality via
 * `ValidateIf`, never null-skipping `@IsOptional`).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { isUUID, validate, ValidationError } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './variant.dto';

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

/**
 * Variant online-catalog fields — DTO validation contract tests (design.md
 * §6.2). Same pipe-equivalent options as the product contract above. Only
 * `UpdateVariantDto` carries the catalog fields: variant create and
 * inline-create must not accept them (create by reference, not copy).
 * `catalogPublishMode` uses undefined-only optionality — an explicit `null`
 * is validated and rejected, never silently skipped.
 */
describe('Variant DTOs — online-catalog fields (variant PATCH)', () => {
  const PUBLISH_MODES = ['INHERIT', 'ON', 'OFF'] as const;

  const validCases: [string, Record<string, unknown>][] = [
    ...PUBLISH_MODES.map(
      (mode) =>
        [`catalogPublishMode ${mode}`, { catalogPublishMode: mode }] as [
          string,
          Record<string, unknown>,
        ],
    ),
    [
      'a full presentation update',
      {
        catalogPublishMode: 'ON',
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 3,
      },
    ],
    [
      'CUSTOM_QUANTITY with custom quantity 0',
      {
        onlineStockPresentation: 'CUSTOM_QUANTITY',
        onlineStockPresentationCustomQty: 0,
      },
    ],
    [
      'explicit null mode with null quantity',
      { onlineStockPresentation: null, onlineStockPresentationCustomQty: null },
    ],
    [
      'explicit null mode with omitted quantity',
      { onlineStockPresentation: null },
    ],
    [
      'an omitted mode with a quantity (deferred to merged-state service validation)',
      { onlineStockPresentationCustomQty: 5 },
    ],
    ['a partial update without catalog fields', { name: 'Nuevo nombre' }],
  ];

  it.each(validCases)('accepts %s', async (_label, fields) => {
    await expectValid(UpdateVariantDto, fields);
  });

  const invalidCases: [string, Record<string, unknown>, string][] = [
    [
      'an explicit null catalogPublishMode',
      { catalogPublishMode: null },
      'catalogPublishMode',
    ],
    [
      'an unknown catalogPublishMode',
      { catalogPublishMode: 'VISIBLE' },
      'catalogPublishMode',
    ],
    [
      'an unknown presentation mode',
      { onlineStockPresentation: 'VISIBLE' },
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
      'CUSTOM_QUANTITY with an omitted quantity',
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
    ...[-1, 1.5, 'abc', ''].map(
      (qty) =>
        [
          `a malformed custom quantity ${JSON.stringify(qty)}`,
          {
            onlineStockPresentation: 'CUSTOM_QUANTITY',
            onlineStockPresentationCustomQty: qty,
          },
          'onlineStockPresentationCustomQty',
        ] as [string, Record<string, unknown>, string],
    ),
    ['an unknown property', { bogus: true }, 'bogus'],
  ];

  it.each(invalidCases)('rejects %s', async (_label, fields, property) => {
    await expectRejected(UpdateVariantDto, fields, property);
  });
});

describe('Variant DTOs — create stays free of catalog fields', () => {
  it.each(['INHERIT', 'ON', 'OFF'] as const)(
    'rejects catalogPublishMode %s on create-variant',
    async (mode) => {
      await expectRejected(
        CreateVariantDto,
        { catalogPublishMode: mode },
        'catalogPublishMode',
      );
    },
  );

  it('rejects onlineStockPresentation on create-variant', async () => {
    await expectRejected(
      CreateVariantDto,
      { onlineStockPresentation: 'HIDDEN' },
      'onlineStockPresentation',
    );
  });
});

const UUID_V4_A = '0d5c1f4e-8a2b-4c3d-9e1f-2a3b4c5d6e7f';
const UUID_V4_B = '6f2a9b3c-1d4e-4f5a-b7c8-9d0e1f2a3b4c';
const UUID_V1 = 'c232ab00-9414-1f4c-a1c2-4f5d6e7f8a9b';

describe.each([
  ['create', CreateProductDto, CREATE_BASE],
  ['PATCH', UpdateProductDto, {}],
])(
  'supportedCatalogPriceListIds strict contract on %s',
  (_name, dtoClass, base) => {
    it('uses real version-tagged UUID fixtures', () => {
      expect(isUUID(UUID_V4_A, '4')).toBe(true);
      expect(isUUID(UUID_V4_B, '4')).toBe(true);
      expect(isUUID(UUID_V1, '4')).toBe(false);
      expect(isUUID(UUID_V1, '1')).toBe(true);
    });

    const validCases: [string, unknown][] = [
      [
        'omitted (all-public semantics live in the service, not the DTO)',
        undefined,
      ],
      ['an empty array', []],
      ['a single UUID v4', [UUID_V4_A]],
      ['unique UUID v4 values', [UUID_V4_A, UUID_V4_B]],
    ];

    const invalidCases: [string, unknown][] = [
      ['an explicit null', null],
      ['a scalar UUID string', UUID_V4_A],
      ['a scalar number', 5],
      ['an object in place of the array', { 0: UUID_V4_A }],
      ['a malformed UUID element', [UUID_V4_A, 'not-a-uuid']],
      ['a null element', [UUID_V4_A, null]],
      ['a UUID v1 element', [UUID_V1]],
      ['duplicate elements', [UUID_V4_A, UUID_V4_A]],
      [
        'case-variant duplicates of the same UUID',
        [UUID_V4_A, UUID_V4_A.toUpperCase()],
      ],
    ];

    it.each(validCases)('accepts %s', async (_label, value) => {
      const payload: Record<string, unknown> = { ...base };
      if (value !== undefined) {
        payload.supportedCatalogPriceListIds = value;
      }
      await expectValid(dtoClass, payload);
    });

    it.each(invalidCases)('rejects %s', async (_label, value) => {
      await expectRejected(
        dtoClass,
        { ...base, supportedCatalogPriceListIds: value },
        'supportedCatalogPriceListIds',
      );
    });
  },
);
