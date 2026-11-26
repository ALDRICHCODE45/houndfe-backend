/**
 * customer-collection / T2b (R1) — tender bounds of «Cobrar todo»: every
 * amount and the tendered total fit PostgreSQL INT4 (so an oversized tender is
 * a validation 400, never a 500 on the `sale_collections` insert) and the
 * reference is bounded.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  COLLECTION_MAX_REFERENCE_LENGTH,
  COLLECTION_MAX_TENDERED_CENTS,
  CreateCustomerCollectionDto,
  CustomerCollectionPreviewDto,
} from './customer-collection.dto';

const SESSION = '11111111-1111-4111-8111-111111111111';
const INT4_MAX = 2_147_483_647;

type DtoClass =
  | typeof CreateCustomerCollectionDto
  | typeof CustomerCollectionPreviewDto;

const errorsFor = (cls: DtoClass, payments: object[]) =>
  validate(plainToInstance(cls, { cashSessionId: SESSION, payments }));

describe.each([
  ['CreateCustomerCollectionDto', CreateCustomerCollectionDto],
  ['CustomerCollectionPreviewDto', CustomerCollectionPreviewDto],
] as const)('%s tender bounds', (_name, cls) => {
  it('exposes the limits: INT4 total, 120-character reference', () => {
    expect(COLLECTION_MAX_TENDERED_CENTS).toBe(INT4_MAX);
    expect(COLLECTION_MAX_REFERENCE_LENGTH).toBe(120);
  });

  it('accepts one tender of exactly INT4 max', async () => {
    expect(
      await errorsFor(cls, [{ method: 'cash', amountCents: INT4_MAX }]),
    ).toEqual([]);
  });

  it('rejects a tender above INT4 max', async () => {
    const errors = await errorsFor(cls, [
      { method: 'cash', amountCents: INT4_MAX + 1 },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('payments');
    expect(errors[0].children?.[0].children?.[0]).toMatchObject({
      property: 'amountCents',
      constraints: { max: expect.any(String) as string },
    });
  });

  it('rejects tenders whose sum exceeds INT4 max, each one valid', async () => {
    const errors = await errorsFor(cls, [
      { method: 'card_debit', amountCents: 2_000_000_000 },
      { method: 'cash', amountCents: 147_483_648 },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      property: 'payments',
      constraints: {
        collectionTenderedTotal: 'PAYMENTS_TOTAL_TOO_LARGE',
      },
    });
  });

  it('accepts tenders summing exactly INT4 max', async () => {
    expect(
      await errorsFor(cls, [
        { method: 'card_debit', amountCents: 2_000_000_000 },
        { method: 'cash', amountCents: 147_483_647 },
      ]),
    ).toEqual([]);
  });

  it('bounds the reference at 120 characters', async () => {
    expect(
      await errorsFor(cls, [
        { method: 'transfer', amountCents: 100, reference: 'x'.repeat(120) },
      ]),
    ).toEqual([]);
    const errors = await errorsFor(cls, [
      { method: 'transfer', amountCents: 100, reference: 'x'.repeat(121) },
    ]);
    expect(errors[0].children?.[0].children?.[0]).toMatchObject({
      property: 'reference',
      constraints: { maxLength: expect.any(String) as string },
    });
  });
});
