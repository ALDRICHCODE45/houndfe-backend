/**
 * cash-register-closing / S10 — characterization of POS ledger movement
 * planning (`cash-adapter-ledger-movements`).
 *
 * One tender per non-zero payment, one change row per sale, catalog snapshot
 * used for non-cash labels. Pure planning only — persistence is out of scope.
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CASH_APPLICATION_CODES } from '../application/cash-application.errors';
import type { CashLedgerPayment } from '../cash-ledger.port';
import { CASH_LEDGER } from '../cash-ledger.port';
import { CASH_METHOD_LABELS, CASH_RULE_CODES } from '../domain';
import { planLedgerPayments } from './cash-adapter-ledger-movements';

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

describe('cash-adapter-ledger-movements — planLedgerPayments', () => {
  it('Given cash and card tenders with change, when planning, then tenders precede one change row', () => {
    const movements = planLedgerPayments('session-1', {
      saleId: 'sale-1',
      payments: [
        { paymentId: 'payment-1', method: 'cash', amountCents: 1000 },
        { paymentId: 'payment-2', method: 'card_credit', amountCents: 500 },
      ],
      changeDueCents: 200,
    });
    expect(movements).toHaveLength(3);
    expect(movements[0]).toMatchObject({
      sessionId: 'session-1',
      deltaCents: 1000,
      method: 'CASH',
      channelKey: 'CASH',
      kind: 'SALE_PAYMENT',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
    });
    expect(movements[1]).toMatchObject({
      method: 'CARD_CREDIT',
      channelKey: 'METHOD:CARD_CREDIT',
      channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
      deltaCents: 500,
      sourceId: 'payment-2',
    });
    expect(movements[2]).toMatchObject({
      deltaCents: -200,
      method: 'CASH',
      channelKey: 'CASH',
      kind: 'SALE_CHANGE',
      sourceType: 'SALE',
      sourceId: 'sale-1',
    });
  });

  it('Given only zero-value payments and no change, when planning, then nothing is stored', () => {
    expect(
      planLedgerPayments('session-1', {
        saleId: 'sale-1',
        payments: [{ paymentId: 'payment-1', method: 'cash', amountCents: 0 }],
        changeDueCents: 0,
      }),
    ).toEqual([]);
  });

  it('Given catalog metadata, when planning a non-cash tender, then the channel keeps the catalog identity', () => {
    const movements = planLedgerPayments('session-1', {
      saleId: 'sale-1',
      payments: [
        {
          paymentId: 'payment-1',
          method: 'card_credit',
          amountCents: 500,
          metadataJson: {
            catalog: { paymentMethodId: 'pm-1', name: 'Visa' },
          },
        },
      ],
      changeDueCents: 0,
    });
    expect(movements[0]).toMatchObject({
      channelKey: 'PM:pm-1',
      channelLabel: 'Visa',
    });
  });

  it('Given an unsupported ledger method, when planning, then it is rejected', () => {
    expectCode(
      () =>
        planLedgerPayments('session-1', {
          saleId: 'sale-1',
          payments: [
            {
              paymentId: 'payment-1',
              method: 'credit' as unknown as CashLedgerPayment['method'],
              amountCents: 100,
            },
          ],
          changeDueCents: 0,
        }),
      CASH_APPLICATION_CODES.LEDGER_METHOD_INVALID,
    );
  });

  it('Given a negative or fractional tender, when planning, then it is rejected', () => {
    expectCode(
      () =>
        planLedgerPayments('session-1', {
          saleId: 'sale-1',
          payments: [
            { paymentId: 'payment-1', method: 'cash', amountCents: -1 },
          ],
          changeDueCents: 0,
        }),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
    expectCode(
      () =>
        planLedgerPayments('session-1', {
          saleId: 'sale-1',
          payments: [
            { paymentId: 'payment-1', method: 'cash', amountCents: 1.5 },
          ],
          changeDueCents: 0,
        }),
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
    );
  });

  it('Given a negative change due, when planning, then it is rejected', () => {
    expectCode(
      () =>
        planLedgerPayments('session-1', {
          saleId: 'sale-1',
          payments: [],
          changeDueCents: -1,
        }),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
  });
});

describe('cash-adapter-ledger-movements — ledger port leaf', () => {
  it('Given the ledger token, when inspected, then it is a distinct injection symbol', () => {
    expect(typeof CASH_LEDGER).toBe('symbol');
    expect(String(CASH_LEDGER)).toBe('Symbol(CASH_LEDGER)');
  });
});
