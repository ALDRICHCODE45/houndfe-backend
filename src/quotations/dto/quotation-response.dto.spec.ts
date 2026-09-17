/**
 * QuotationResponseDto — WU2 (T2.3) runtime validation tests.
 *
 * Proves the activated `ivaBreakdown[]` wire contract with the same
 * `plainToInstance` + `validate` machinery the bootstrap ValidationPipe
 * uses (whitelist / forbidNonWhitelisted semantics are unchanged — this
 * spec only pins the response-side contract):
 *
 *   - the classification enum is CLOSED over exactly the five public
 *     values (an unknown classification is rejected);
 *   - `amountCents` must be an integer >= 0 (fractional and negative
 *     amounts rejected);
 *   - `ivaBreakdown` must be an array (non-array rejected);
 *   - represented-only arrays — including zero-amount buckets — are
 *     accepted;
 *   - nested invalid entries poison the whole array (ValidateNested).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  QuotationIvaBreakdownEntryDto,
  QuotationResponseDto,
} from './quotation-response.dto';

const validWire = (overrides: Record<string, unknown> = {}) => ({
  id: 'q-1',
  sellerUserId: 'seller-1',
  status: 'DRAFT',
  customerId: null,
  globalPriceListId: null,
  priceListExplicitlySet: false,
  expiresAt: null,
  cancelReason: null,
  canceledAt: null,
  subtotalCents: 11600,
  discountCents: 0,
  totalCents: 11600,
  manuallyEnded: false,
  items: [],
  appliedPromotions: [],
  customerNotes: null,
  ivaBreakdown: [{ classification: 'IVA_16', amountCents: 1600 }],
  vetoedPromotionIds: [],
  optedInManualPromotionIds: [],
  customer: null,
  seller: null,
  createdAt: new Date('2026-09-16T10:00:00Z'),
  updatedAt: new Date('2026-09-16T10:00:00Z'),
  ...overrides,
});

const dtoOf = (payload: Record<string, unknown>) =>
  plainToInstance(QuotationResponseDto, payload);

describe('QuotationIvaBreakdownEntryDto (WU2 T2.3)', () => {
  it('accepts each of the five closed classifications (zero buckets included)', async () => {
    for (const classification of [
      'IVA_16',
      'IVA_8',
      'IVA_0',
      'IVA_EXENTO',
      'NOT_TAXABLE',
    ]) {
      const dto = plainToInstance(QuotationIvaBreakdownEntryDto, {
        classification,
        amountCents: 0,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects a classification outside the closed enum', async () => {
    const dto = plainToInstance(QuotationIvaBreakdownEntryDto, {
      classification: 'IVA_4', // not a member of the 5-value union
      amountCents: 100,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('classification');
  });

  it('rejects a fractional amountCents', async () => {
    const dto = plainToInstance(QuotationIvaBreakdownEntryDto, {
      classification: 'IVA_16',
      amountCents: 160.5,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('amountCents');
  });

  it('rejects a negative amountCents', async () => {
    const dto = plainToInstance(QuotationIvaBreakdownEntryDto, {
      classification: 'IVA_16',
      amountCents: -1,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('amountCents');
  });

  it('rejects a non-integer string amountCents', async () => {
    const dto = plainToInstance(QuotationIvaBreakdownEntryDto, {
      classification: 'IVA_16',
      amountCents: 'many',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('amountCents');
  });
});

describe('QuotationResponseDto.ivaBreakdown (WU2 T2.3 — activated wire)', () => {
  it('accepts a represented-only array including zero-amount buckets', async () => {
    const dto = dtoOf(
      validWire({
        ivaBreakdown: [
          { classification: 'IVA_16', amountCents: 1600 },
          { classification: 'IVA_8', amountCents: 800 },
          { classification: 'IVA_0', amountCents: 0 },
          { classification: 'IVA_EXENTO', amountCents: 0 },
          { classification: 'NOT_TAXABLE', amountCents: 0 },
        ],
      }),
    );
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.ivaBreakdown).toHaveLength(5);
  });

  it('accepts an empty breakdown (legacy / incomplete snapshot rows)', async () => {
    const dto = dtoOf(validWire({ ivaBreakdown: [] }));
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a single represented bucket (single-classification quotation)', async () => {
    const dto = dtoOf(
      validWire({
        ivaBreakdown: [{ classification: 'IVA_16', amountCents: 3200 }],
      }),
    );
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-array ivaBreakdown', async () => {
    const dto = dtoOf(validWire({ ivaBreakdown: 'IVA_16' }));
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('ivaBreakdown');
  });

  it('rejects the whole array when one nested entry is invalid', async () => {
    const dto = dtoOf(
      validWire({
        ivaBreakdown: [
          { classification: 'IVA_16', amountCents: 1600 },
          { classification: 'NOT_A_RATE', amountCents: 0 },
        ],
      }),
    );
    const errors = await validate(dto);
    // ValidateNested surfaces the nested failure — the array is not
    // silently accepted.
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(
        (e) => e.property === 'ivaBreakdown' && (e.children?.length ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it('rejects a nested fractional amount through ValidateNested', async () => {
    const dto = dtoOf(
      validWire({
        ivaBreakdown: [{ classification: 'IVA_16', amountCents: 1.5 }],
      }),
    );
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
