import 'reflect-metadata';
import { BackorderError } from '../domain/backorder-error';
import {
  parseCancelBackorderRequest,
  parseCreateBackorderRequest,
  parseListBackordersQuery,
} from './backorder-request.parsers';

const UUID = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`;

const valid = (over: Record<string, unknown> = {}) => ({
  phoneCountryCode: '52',
  phone: '5512349901',
  customer: { mode: 'existing', customerId: UUID(1) },
  productId: UUID(2),
  variantId: null,
  quantity: 2,
  expectedReferencePriceCents: 114900,
  sourceDecisionId: UUID(3),
  chatbotRequestId: null,
  ...over,
});

function invalidCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof BackorderError) return error.code;
    throw error;
  }
  throw new Error('expected a BackorderError');
}

describe('parseCreateBackorderRequest (§6.1 body)', () => {
  it('parses the contract example into an intent', () => {
    expect(parseCreateBackorderRequest(valid())).toEqual({
      phoneCountryCode: '52',
      phone: '5512349901',
      customer: { mode: 'existing', customerId: UUID(1) },
      productId: UUID(2),
      variantId: null,
      quantity: 2,
      expectedReferencePriceCents: 114900,
      sourceDecisionId: UUID(3),
      chatbotRequestId: null,
    });
  });

  it('parses createIfAbsent with an optional last name', () => {
    expect(
      parseCreateBackorderRequest(
        valid({ customer: { mode: 'createIfAbsent', firstName: 'Rosa' } }),
      ).customer,
    ).toEqual({ mode: 'createIfAbsent', firstName: 'Rosa', lastName: null });
    expect(
      parseCreateBackorderRequest(
        valid({
          customer: {
            mode: 'createIfAbsent',
            firstName: 'Rosa',
            lastName: 'Díaz',
          },
        }),
      ).customer,
    ).toEqual({ mode: 'createIfAbsent', firstName: 'Rosa', lastName: 'Díaz' });
  });

  it('treats the optional members as omitted when absent or null', () => {
    const {
      variantId: _variant,
      expectedReferencePriceCents: _price,
      chatbotRequestId: _wrapper,
      ...minimal
    } = valid();
    void [_variant, _price, _wrapper];
    expect(parseCreateBackorderRequest(minimal)).toMatchObject({
      variantId: null,
      expectedReferencePriceCents: null,
      chatbotRequestId: null,
    });
  });

  it('keeps a variant and a wrapper request when sent', () => {
    expect(
      parseCreateBackorderRequest(
        valid({ variantId: UUID(4), chatbotRequestId: UUID(5) }),
      ),
    ).toMatchObject({ variantId: UUID(4), chatbotRequestId: UUID(5) });
  });

  it.each([
    ['a non-object body', 'text'],
    ['an array body', []],
    ['null', null],
    ['a missing phone', valid({ phone: undefined })],
    ['a non-numeric phone', valid({ phone: '55-1234' })],
    ['an over-long phone', valid({ phone: '1'.repeat(21) })],
    ['a bad country code', valid({ phoneCountryCode: '+52' })],
    ['a missing customer', valid({ customer: undefined })],
    ['an unknown customer mode', valid({ customer: { mode: 'other' } })],
    [
      'an existing customer without id',
      valid({ customer: { mode: 'existing' } }),
    ],
    [
      'a non-UUID customer id',
      valid({ customer: { mode: 'existing', customerId: 'nope' } }),
    ],
    [
      'a blank first name',
      valid({ customer: { mode: 'createIfAbsent', firstName: '   ' } }),
    ],
    ['a non-UUID product', valid({ productId: 'nope' })],
    ['a non-UUID variant', valid({ variantId: 'nope' })],
    ['a zero quantity', valid({ quantity: 0 })],
    ['a negative quantity', valid({ quantity: -1 })],
    ['a fractional quantity', valid({ quantity: 1.5 })],
    ['a string quantity', valid({ quantity: '2' })],
    ['a quantity above int32', valid({ quantity: 2_147_483_648 })],
    ['a negative expected price', valid({ expectedReferencePriceCents: -1 })],
    [
      'a fractional expected price',
      valid({ expectedReferencePriceCents: 10.5 }),
    ],
    ['a non-UUID source decision', valid({ sourceDecisionId: 'nope' })],
    ['a missing source decision', valid({ sourceDecisionId: undefined })],
    ['a non-UUID wrapper request', valid({ chatbotRequestId: 'nope' })],
    ['an unknown member', valid({ tenantId: UUID(9) })],
    [
      'an address (none is accepted before checkout)',
      valid({ deliveryAddress: {} }),
    ],
  ])('400 INVALID_BACKORDER_REQUEST for %s', (_label, body) => {
    expect(invalidCode(() => parseCreateBackorderRequest(body))).toBe(
      'INVALID_BACKORDER_REQUEST',
    );
  });
});

describe('parseCancelBackorderRequest (§6.4 body)', () => {
  it('accepts an absent body and an empty object', () => {
    expect(parseCancelBackorderRequest(undefined)).toEqual({ reason: null });
    expect(parseCancelBackorderRequest(null)).toEqual({ reason: null });
    expect(parseCancelBackorderRequest({})).toEqual({ reason: null });
  });

  it('trims the reason and stores a blank one as null', () => {
    expect(
      parseCancelBackorderRequest({ reason: '  ya no lo necesito ' }),
    ).toEqual({
      reason: 'ya no lo necesito',
    });
    expect(parseCancelBackorderRequest({ reason: '   ' })).toEqual({
      reason: null,
    });
  });

  it('accepts exactly 280 characters and rejects 281', () => {
    expect(
      parseCancelBackorderRequest({ reason: 'x'.repeat(280) }).reason,
    ).toHaveLength(280);
    expect(
      invalidCode(() =>
        parseCancelBackorderRequest({ reason: 'x'.repeat(281) }),
      ),
    ).toBe('INVALID_BACKORDER_REQUEST');
  });

  it.each([
    ['a non-string reason', { reason: 5 }],
    ['an unknown member', { reason: 'x', version: 1 }],
    ['an array', []],
    ['a string body', 'text'],
  ])('400 INVALID_BACKORDER_REQUEST for %s', (_label, body) => {
    expect(invalidCode(() => parseCancelBackorderRequest(body))).toBe(
      'INVALID_BACKORDER_REQUEST',
    );
  });
});

describe('parseListBackordersQuery (§6.3 query)', () => {
  it('accepts an empty query', () => {
    expect(parseListBackordersQuery({})).toEqual({});
  });

  it('parses the phone pair, the status list and updatedSince', () => {
    expect(
      parseListBackordersQuery({
        phoneCountryCode: '52',
        phone: '5512349901',
        status: 'WAITING,RESERVED',
        updatedSince: '2026-11-20T10:00:00.000Z',
      }),
    ).toEqual({
      phoneCountryCode: '52',
      phone: '5512349901',
      statuses: ['WAITING', 'RESERVED'],
      updatedSince: new Date('2026-11-20T10:00:00.000Z'),
    });
  });

  it('accepts an offset in updatedSince and de-duplicates statuses', () => {
    const parsed = parseListBackordersQuery({
      status: 'WAITING, WAITING',
      updatedSince: '2026-11-20T04:00:00-06:00',
    });
    expect(parsed.statuses).toEqual(['WAITING']);
    expect(parsed.updatedSince?.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it.each([
    ['only the country code', { phoneCountryCode: '52' }],
    ['only the phone', { phone: '5512349901' }],
    ['a non-numeric phone', { phoneCountryCode: '52', phone: 'abc' }],
    ['an unknown status', { status: 'WAITING,DONE' }],
    ['a lowercase status', { status: 'waiting' }],
    ['an empty status element', { status: 'WAITING,' }],
    ['an updatedSince without a zone', { updatedSince: '2026-11-20T10:00:00' }],
    ['a date-only updatedSince', { updatedSince: '2026-11-20' }],
    ['an impossible updatedSince', { updatedSince: '2026-13-40T10:00:00Z' }],
    ['an unknown key', { limit: '5' }],
    ['a repeated key (array)', { status: ['WAITING', 'RESERVED'] }],
  ])('400 INVALID_BACKORDER_REQUEST for %s', (_label, query) => {
    expect(invalidCode(() => parseListBackordersQuery(query))).toBe(
      'INVALID_BACKORDER_REQUEST',
    );
  });
});
