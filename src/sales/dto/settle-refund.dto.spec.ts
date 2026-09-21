import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SettleRefundDto } from './settle-refund.dto';
import {
  isRefundSettlementResponseDto,
  RefundSettlementResponseDto,
} from './refund-settlement-response.dto';

const VALID = {
  amountCents: 500,
  method: 'cash',
  reference: 'REF-1',
  settledAt: '2024-01-15T10:00:00.000Z',
};

const toDto = (overrides: Record<string, unknown> = {}) =>
  plainToInstance(SettleRefundDto, { ...VALID, ...overrides });

const errorProperties = async (overrides: Record<string, unknown>) =>
  (await validate(toDto(overrides))).map((error) => error.property);

describe('SettleRefundDto', () => {
  it('accepts every domain tender method with a string reference', async () => {
    for (const method of [
      'cash',
      'card_credit',
      'card_debit',
      'transfer',
      'credit',
    ]) {
      expect(await validate(toDto({ method }))).toHaveLength(0);
    }
  });

  it('accepts an omitted reference and keeps settledAt untransformed', async () => {
    const dto = plainToInstance(SettleRefundDto, {
      amountCents: VALID.amountCents,
      method: VALID.method,
      settledAt: VALID.settledAt,
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reference).toBeUndefined();
    expect(dto.settledAt).toBe(VALID.settledAt);
  });

  it.each([1, 2147483647])(
    'accepts the amountCents boundary %i',
    async (amountCents) => {
      expect(await validate(toDto({ amountCents }))).toHaveLength(0);
    },
  );

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 12.5],
    ['over the Int ceiling', 2147483648],
    ['a numeric string', '500'],
    ['missing', undefined],
  ])('rejects %s amountCents', async (_label, amountCents) => {
    expect(await errorProperties({ amountCents })).toContain('amountCents');
  });

  it.each([
    ['missing', undefined],
    ['unsupported', 'bitcoin'],
    ['non-string', 7],
  ])('rejects a %s method', async (_label, method) => {
    expect(await errorProperties({ method })).toContain('method');
  });

  it.each([[123], [null], [{ ref: 'x' }]])(
    'rejects a non-string reference (%p)',
    async (reference) => {
      expect(await errorProperties({ reference })).toContain('reference');
    },
  );

  it.each([
    ['missing', undefined],
    ['not a date', 'yesterday'],
    ['a non-string', 1705312800000],
  ])('rejects a %s settledAt', async (_label, settledAt) => {
    expect(await errorProperties({ settledAt })).toContain('settledAt');
  });

  it.each(['2024-01-15T10:00:00.000', '2024-01-15T10:00:00', '2024-01-15'])(
    'rejects the timezone-less settledAt %s',
    async (settledAt) => {
      expect(await errorProperties({ settledAt })).toContain('settledAt');
    },
  );
});

// The response DTO's own spec file is outside this change's edit surface, so
// the guard suite lives beside the sibling request DTO spec.
describe('isRefundSettlementResponseDto', () => {
  const validResponse = (): RefundSettlementResponseDto => ({
    settlementId: '11111111-1111-4111-8111-111111111111',
    refundId: '22222222-2222-4222-8222-222222222222',
    saleId: '33333333-3333-4333-8333-333333333333',
    amountCents: 500,
    method: 'card_credit',
    reference: null,
    settledAt: '2024-01-15T10:00:00.000Z',
    settledCents: 500,
    outstandingCents: 1500,
  });

  it('accepts a persisted payload with a non-null reference', () => {
    expect(isRefundSettlementResponseDto(validResponse())).toBe(true);
    expect(
      isRefundSettlementResponseDto({
        ...validResponse(),
        method: 'credit',
        reference: 'REF-9',
      }),
    ).toBe(true);
  });

  it.each([
    ['a non-object payload', 'nope'],
    ['a non-UUID settlementId', { settlementId: 'stl-1' }],
    ['a non-UUID refundId', { refundId: 'rfd-1' }],
    ['a missing saleId', { saleId: undefined }],
    ['an unsupported method', { method: 'bitcoin' }],
    ['a negative balance', { outstandingCents: -1 }],
    ['a fractional balance', { settledCents: 10.5 }],
    ['an over-ceiling balance', { settledCents: 2147483648 }],
    ['a zero installment', { amountCents: 0 }],
    ['an out-of-range installment', { amountCents: 2147483648 }],
    ['a settled total below the installment', { settledCents: 499 }],
    [
      'a balance sum over the ceiling',
      {
        settledCents: 2147483647,
        outstandingCents: 1,
      },
    ],
    ['a non-string reference', { reference: 123 }],
    ['a missing reference', { reference: undefined }],
    ['a non-canonical timestamp', { settledAt: '2024-01-15' }],
    ['an invalid timestamp', { settledAt: 'not-a-date' }],
    ['a non-string timestamp', { settledAt: 1705312800000 }],
  ])('rejects %s', (_label, overrides) => {
    const payload =
      typeof overrides === 'object' && overrides !== null
        ? { ...validResponse(), ...overrides }
        : overrides;

    expect(isRefundSettlementResponseDto(payload)).toBe(false);
  });
});
