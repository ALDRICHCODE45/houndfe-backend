/**
 * cash-register-closing / S10 — characterization of adapter value primitives
 * (`cash-adapter-values`) plus the shared application error/port leaves those
 * primitives depend on.
 *
 * Foundation spec: imports only same/earlier leaf modules (application errors,
 * application/ledger ports) and the value helpers. No facade, no handlers.
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  CASH_APPLICATION_CODES,
  cashAppError,
} from '../application/cash-application.errors';
import { CASH_APPLICATION } from '../cash-application.port';
import type { CashPaymentMethod } from '../cash-ledger.port';
import { CASH_LEDGER } from '../cash-ledger.port';
import {
  asCashMethod,
  canonicalize,
  document,
  documentValue,
  isRecord,
  isUniqueViolation,
  iso,
  json,
  ledgerMethodToCashMethod,
  newFolio,
  prismaJson,
} from './cash-adapter-values';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BusinessRuleViolationError);
  expect((caught as BusinessRuleViolationError).code).toBe(code);
}

describe('cash-adapter-values — primitives', () => {
  it('Given calls, when minting a folio, then it is opaque, prefixed and unique', () => {
    const first = newFolio();
    const second = newFolio();
    expect(first).toMatch(/^CC-/);
    expect(second).toMatch(/^CC-/);
    expect(first).not.toBe(second);
  });

  it('Given a date or null, when serializing, then it is ISO text or null', () => {
    expect(iso(new Date('2025-01-02T03:04:05.000Z'))).toBe(
      '2025-01-02T03:04:05.000Z',
    );
    expect(iso(null)).toBeNull();
  });

  it('Given non-record values, when narrowing, then only plain objects pass', () => {
    expect(isRecord({ id: 'r1' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('text')).toBe(false);
  });

  it('Given errors, when detecting a unique violation, then only P2002 matches', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
  });

  it('Given JSON-safe payloads, when casting, then the reference is preserved', () => {
    const payload = { id: 'r1', isActive: true };
    expect(document(payload)).toBe(payload);
    expect(documentValue(payload)).toBe(payload);
    expect(json(payload)).toBe(payload);
    expect(prismaJson(payload)).toBe(payload);
  });

  it('Given a supported method, when mapping movement methods, then uppercase passes through', () => {
    expect(asCashMethod('CASH')).toBe('CASH');
    expect(asCashMethod('CARD_CREDIT')).toBe('CARD_CREDIT');
    expect(asCashMethod('CARD_DEBIT')).toBe('CARD_DEBIT');
    expect(asCashMethod('TRANSFER')).toBe('TRANSFER');
  });

  it('Given an unsupported movement method, when mapping, then it is rejected', () => {
    expectCode(
      () => asCashMethod('CREDIT'),
      CASH_APPLICATION_CODES.LEDGER_METHOD_INVALID,
    );
  });

  it('Given a ledger method, when mapping, then it becomes the uppercase method', () => {
    expect(ledgerMethodToCashMethod('cash')).toBe('CASH');
    expect(ledgerMethodToCashMethod('card_credit')).toBe('CARD_CREDIT');
    expect(ledgerMethodToCashMethod('card_debit')).toBe('CARD_DEBIT');
    expect(ledgerMethodToCashMethod('transfer')).toBe('TRANSFER');
  });

  it('Given an unsupported ledger method, when mapping, then it is rejected', () => {
    expectCode(
      () => ledgerMethodToCashMethod('credit' as unknown as CashPaymentMethod),
      CASH_APPLICATION_CODES.LEDGER_METHOD_INVALID,
    );
  });

  it('Given nested input, when canonicalizing, then keys are sorted and unsupported values nulled', () => {
    const canonical = canonicalize({
      b: 1,
      a: [2, { d: undefined, c: 3 }],
    }) as Record<string, unknown>;
    expect(canonical).toEqual({ a: [2, { c: 3 }], b: 1 });
    expect(Object.keys(canonical)).toEqual(['a', 'b']);
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBeNull();
    expect(canonicalize(Number.NaN)).toBeNull();
    expect(canonicalize(undefined)).toBeNull();
    expect(canonicalize(null)).toBeNull();
  });

  it('Given an application code, when building an error, then the code and details survive', () => {
    const error = cashAppError(
      CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
      'Cash register not found',
      { registerId: 'r1' },
    );
    expect(error).toBeInstanceOf(BusinessRuleViolationError);
    expect(error.code).toBe('CASH_REGISTER_NOT_FOUND');
    expect(error.details).toEqual({ registerId: 'r1' });
  });
});

describe('cash-adapter-values — application/ledger port leaves', () => {
  it('Given the port tokens, when inspected, then they are distinct injection symbols', () => {
    expect(typeof CASH_APPLICATION).toBe('symbol');
    expect(typeof CASH_LEDGER).toBe('symbol');
    expect(CASH_APPLICATION).not.toBe(CASH_LEDGER);
    expect(String(CASH_APPLICATION)).toBe('Symbol(CASH_APPLICATION)');
    expect(String(CASH_LEDGER)).toBe('Symbol(CASH_LEDGER)');
  });
});
