/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed any */
/**
 * customer-collection / T2 (S2, S3) — pure allocation of a «Cobrar todo»
 * (contract v1 §3, §4; owner Q1 «Vencimiento más viejo primero», Q2 «En
 * orden; la última queda parcial», Q3 «Sí, solo hasta el efectivo entregado»).
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  allocateCollection,
  orderCollectionCandidates,
  type CollectionCandidate,
  type CollectionTender,
} from './collection-allocation';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function sale(
  saleId: string,
  debtCents: number,
  dueDate: string | null,
  confirmedAt = '2026-10-01T15:00:00.000Z',
): CollectionCandidate {
  return {
    saleId,
    debtCents,
    dueDate: dueDate ? day(dueDate) : null,
    confirmedAt: new Date(confirmedAt),
  };
}

const card = (amountCents: number): CollectionTender => ({
  method: 'card_debit',
  amountCents,
});
const cash = (amountCents: number): CollectionTender => ({
  method: 'cash',
  amountCents,
});

function expectRuleError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleViolationError);
    expect((error as BusinessRuleViolationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('orderCollectionCandidates (Q1)', () => {
  it('orders by due day ascending, sales without due date last', () => {
    const ordered = orderCollectionCandidates([
      sale('c', 100, null),
      sale('b', 100, '2026-11-10'),
      sale('a', 100, '2026-11-01'),
    ]);
    expect(ordered.map((s) => s.saleId)).toEqual(['a', 'b', 'c']);
  });

  it('compares the UTC due DAY, so two due dates of the same day tie and fall to confirmedAt', () => {
    const ordered = orderCollectionCandidates([
      {
        saleId: 'late-hour',
        debtCents: 1,
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        confirmedAt: new Date('2026-10-02T00:00:00.000Z'),
      },
      {
        saleId: 'early-confirmed',
        debtCents: 1,
        dueDate: new Date('2026-11-01T23:00:00.000Z'),
        confirmedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
    expect(ordered.map((s) => s.saleId)).toEqual([
      'early-confirmed',
      'late-hour',
    ]);
  });

  it('breaks due-day ties by confirmedAt, then by id', () => {
    const ordered = orderCollectionCandidates([
      sale('z', 1, '2026-11-01', '2026-10-01T10:00:00.000Z'),
      sale('y', 1, '2026-11-01', '2026-10-01T09:00:00.000Z'),
      sale('x2', 1, null, '2026-10-01T09:00:00.000Z'),
      sale('x1', 1, null, '2026-10-01T09:00:00.000Z'),
    ]);
    expect(ordered.map((s) => s.saleId)).toEqual(['y', 'z', 'x1', 'x2']);
  });

  it('does not mutate its input', () => {
    const input = [sale('b', 1, null), sale('a', 1, '2026-11-01')];
    orderCollectionCandidates(input);
    expect(input.map((s) => s.saleId)).toEqual(['b', 'a']);
  });
});

describe('allocateCollection', () => {
  it('§3 example: A 300 (01/11), B 500 (10/11), C 400 (no due); card 600 + cash 300', () => {
    const result = allocateCollection(
      [
        sale('C', 400, null),
        sale('B', 500, '2026-11-10'),
        sale('A', 300, '2026-11-01'),
      ],
      [card(600), cash(300)],
    );

    expect(result.sales).toEqual([
      {
        candidate: expect.objectContaining({ saleId: 'A' }),
        appliedCents: 300,
        parts: [{ tenderIndex: 0, method: 'card_debit', amountCents: 300 }],
      },
      {
        candidate: expect.objectContaining({ saleId: 'B' }),
        appliedCents: 500,
        parts: [
          { tenderIndex: 0, method: 'card_debit', amountCents: 300 },
          { tenderIndex: 1, method: 'cash', amountCents: 200 },
        ],
      },
      {
        candidate: expect.objectContaining({ saleId: 'C' }),
        appliedCents: 100,
        parts: [{ tenderIndex: 1, method: 'cash', amountCents: 100 }],
      },
    ]);
    expect(result).toMatchObject({
      debtCents: 1200,
      tenderedCents: 900,
      appliedCents: 900,
      changeDueCents: 0,
    });
  });

  it('consumes cash LAST even when it comes first in the request; parts keep the request tender index', () => {
    const result = allocateCollection(
      [sale('A', 300, '2026-11-01'), sale('B', 500, '2026-11-10')],
      [cash(300), card(500)],
    );
    expect(result.sales.map((s) => s.parts)).toEqual([
      [{ tenderIndex: 1, method: 'card_debit', amountCents: 300 }],
      [
        { tenderIndex: 1, method: 'card_debit', amountCents: 200 },
        { tenderIndex: 0, method: 'cash', amountCents: 300 },
      ],
    ]);
  });

  it('keeps the request order among non-cash tenders and among cash tenders', () => {
    const result = allocateCollection(
      [sale('A', 1000, '2026-11-01')],
      [
        cash(100),
        { method: 'transfer', amountCents: 200 },
        cash(50),
        card(300),
      ],
    );
    expect(result.sales[0].parts.map((p) => p.tenderIndex)).toEqual([
      1, 3, 0, 2,
    ]);
    expect(result.sales[0].appliedCents).toBe(650);
  });

  it('lists every candidate in order, the unreached ones with appliedCents 0 and no parts (Q2 partial last)', () => {
    const result = allocateCollection(
      [
        sale('A', 300, '2026-11-01'),
        sale('B', 500, '2026-11-10'),
        sale('C', 400, null),
      ],
      [card(450)],
    );
    expect(
      result.sales.map((s) => [
        s.candidate.saleId,
        s.appliedCents,
        s.parts.length,
      ]),
    ).toEqual([
      ['A', 300, 1],
      ['B', 150, 1],
      ['C', 0, 0],
    ]);
    expect(result).toMatchObject({
      tenderedCents: 450,
      appliedCents: 450,
      changeDueCents: 0,
    });
  });

  it('pays exactly the whole debt with no change', () => {
    const result = allocateCollection(
      [sale('A', 300, '2026-11-01'), sale('B', 500, null)],
      [card(800)],
    );
    expect(result.sales.map((s) => s.appliedCents)).toEqual([300, 500]);
    expect(result.changeDueCents).toBe(0);
  });

  it('gives change from cash when the cash covers the excess (Q3)', () => {
    const result = allocateCollection(
      [sale('A', 300, '2026-11-01'), sale('B', 500, null)],
      [card(600), cash(500)],
    );
    expect(result).toMatchObject({
      debtCents: 800,
      tenderedCents: 1100,
      appliedCents: 800,
      changeDueCents: 300,
    });
    expect(result.sales[1].parts).toEqual([
      { tenderIndex: 0, method: 'card_debit', amountCents: 300 },
      { tenderIndex: 1, method: 'cash', amountCents: 200 },
    ]);
  });

  it('allows change equal to the whole cash tendered (card covers the debt exactly)', () => {
    const result = allocateCollection(
      [sale('A', 800, null)],
      [card(800), cash(200)],
    );
    expect(result.changeDueCents).toBe(200);
    expect(result.sales[0].parts).toEqual([
      { tenderIndex: 0, method: 'card_debit', amountCents: 800 },
    ]);
  });

  it('rejects an excess without cash with COLLECTION_EXCEEDS_DEBT', () => {
    expectRuleError(
      () => allocateCollection([sale('A', 800, null)], [card(801)]),
      'COLLECTION_EXCEEDS_DEBT',
    );
  });

  it('rejects an excess larger than the cash tendered with COLLECTION_EXCEEDS_DEBT', () => {
    expectRuleError(
      () => allocateCollection([sale('A', 800, null)], [card(900), cash(50)]),
      'COLLECTION_EXCEEDS_DEBT',
    );
  });

  it('rejects any tender over no candidates with COLLECTION_NO_OPEN_DEBT', () => {
    expectRuleError(
      () => allocateCollection([], [cash(100)]),
      'COLLECTION_NO_OPEN_DEBT',
    );
  });

  it('allows an empty tender list (preview of the debt): every candidate with 0', () => {
    const result = allocateCollection([sale('A', 300, null)], []);
    expect(result.sales).toEqual([
      {
        candidate: expect.objectContaining({ saleId: 'A' }),
        appliedCents: 0,
        parts: [],
      },
    ]);
    expect(result).toMatchObject({
      debtCents: 300,
      tenderedCents: 0,
      appliedCents: 0,
      changeDueCents: 0,
    });
  });

  it('rejects non-positive or non-integer amounts with PAYMENT_AMOUNT_INVALID', () => {
    for (const amountCents of [0, -1, 1.5]) {
      expectRuleError(
        () => allocateCollection([sale('A', 300, null)], [card(amountCents)]),
        'PAYMENT_AMOUNT_INVALID',
      );
    }
  });

  it('fails loudly on a candidate without positive debt (caller invariant)', () => {
    expect(() => allocateCollection([sale('A', 0, null)], [card(1)])).toThrow(
      'collection candidate without open debt',
    );
  });

  it('applied amounts of the parts always add up per sale and in total (property over many splits)', () => {
    const debts = [137, 1, 999, 250, 42];
    const candidates = debts.map((debt, i) =>
      sale(`s${i}`, debt, i % 2 ? null : `2026-11-0${i + 1}`),
    );
    const totalDebt = debts.reduce((a, b) => a + b, 0);
    for (let tendered = 1; tendered <= totalDebt; tendered += 37) {
      const cardPart = Math.floor(tendered / 3);
      const tenders = [card(cardPart), cash(tendered - cardPart)].filter(
        (t) => t.amountCents > 0,
      );
      const result = allocateCollection(candidates, tenders);
      for (const s of result.sales) {
        expect(s.parts.reduce((a, p) => a + p.amountCents, 0)).toBe(
          s.appliedCents,
        );
        expect(s.appliedCents).toBeLessThanOrEqual(s.candidate.debtCents);
      }
      expect(result.appliedCents).toBe(tendered);
      // fill in order: once a sale is partial, every later one is untouched
      const firstPartial = result.sales.findIndex(
        (s) => s.appliedCents < s.candidate.debtCents,
      );
      if (firstPartial >= 0) {
        expect(
          result.sales
            .slice(firstPartial + 1)
            .every((s) => s.appliedCents === 0),
        ).toBe(true);
      }
    }
  });
});
