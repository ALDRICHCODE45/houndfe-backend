/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- async-shaped test doubles; jest mock call arguments are untyped */
/**
 * customer-collection / T2 (S2, S3, S4) — `CustomerCollectionService` with
 * in-memory ports: preview (no writes), apply (one transaction, order of the
 * fence/locks/writes, per-sale rows, cash movements, events, idempotency) and
 * every §10 error the service owns.
 */
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import { CustomerCollectionService } from './customer-collection.service';
import type {
  CollectionSaleRow,
  ICustomerCollectionRepository,
} from './domain/customer-collection.repository';
import type { CreateCustomerCollectionDto } from './dto/customer-collection.dto';

const TENANT = 'tenant-1';
const CUSTOMER = 'cust-1';
const ACTOR = 'user-1';
const SESSION = '11111111-1111-4111-8111-111111111111';
// 12:00 in Mexico City on 2026-11-25 → business today 2026-11-25.
const NOW = new Date('2026-11-25T18:00:00.000Z');

function row(
  over: Partial<CollectionSaleRow> & { saleId: string },
): CollectionSaleRow {
  return {
    customerId: CUSTOMER,
    status: 'CONFIRMED',
    folio: `V-${over.saleId}`,
    confirmedAt: new Date('2026-10-01T15:00:00.000Z'),
    dueDate: null,
    totalCents: over.debtCents ?? 0,
    paidCents: 0,
    debtCents: 0,
    paymentStatus: 'CREDIT',
    ...over,
  };
}

/** §3 example: A 300 (due 01/11, overdue), B 500 (due 30/11), C 400 (no due). */
function exampleSales(): CollectionSaleRow[] {
  return [
    row({ saleId: 'C', debtCents: 400, totalCents: 400 }),
    row({
      saleId: 'B',
      debtCents: 500,
      totalCents: 700,
      paidCents: 200,
      paymentStatus: 'PARTIAL',
      dueDate: new Date('2026-11-30T00:00:00.000Z'),
    }),
    row({
      saleId: 'A',
      debtCents: 300,
      totalCents: 300,
      dueDate: new Date('2026-11-01T00:00:00.000Z'),
    }),
  ];
}

interface Harness {
  service: CustomerCollectionService;
  calls: string[];
  sales: CollectionSaleRow[];
  persisted: Array<{ saleId: string; collectionId?: string; payments: any[] }>;
  inserted: any[];
  ledger: { assertOpenSession: jest.Mock; recordPayments: jest.Mock };
  outbox: { publish: jest.Mock };
  saleRepo: Record<string, jest.Mock>;
  resolver: { resolveActive: jest.Mock };
  /** Ids of every `findSalesByIds` call with `lock: true`, per call. */
  lockedIds: string[][];
}

function harness(
  opts: {
    sales?: CollectionSaleRow[];
    customer?: boolean;
    acquire?: unknown;
    otherOpenDebtCents?: number;
    /**
     * The rows as the LOCKED read sees them (a concurrent writer committed
     * between the unlocked candidate read and the lock); defaults to `sales`.
     */
    lockedSales?: CollectionSaleRow[];
  } = {},
): Harness {
  const calls: string[] = [];
  const lockedIds: string[][] = [];
  const sales = opts.sales ?? exampleSales();
  const persisted: Harness['persisted'] = [];
  const inserted: any[] = [];
  const paidNow = new Map(
    (opts.lockedSales ?? sales).map((s) => [s.saleId, s.paidCents]),
  );

  const collectionRepo: ICustomerCollectionRepository = {
    findCustomer: jest.fn(async (id, { lock }) => {
      calls.push(`findCustomer:${lock}`);
      return opts.customer === false || id !== CUSTOMER
        ? null
        : { id: CUSTOMER, name: 'Ana López' };
    }),
    findOpenDebtSales: jest.fn(async (_id, { lock }) => {
      calls.push(`findOpenDebtSales:${lock}`);
      return sales.filter(
        (s) =>
          s.customerId === CUSTOMER &&
          s.status === 'CONFIRMED' &&
          s.debtCents > 0,
      );
    }),
    findSalesByIds: jest.fn(async (ids, { lock }) => {
      calls.push(`findSalesByIds:${lock}`);
      if (lock) lockedIds.push([...ids]);
      const source = lock ? (opts.lockedSales ?? sales) : sales;
      return source.filter((s) => ids.includes(s.saleId));
    }),
    sumOpenDebt: jest.fn(async () => {
      calls.push('sumOpenDebt');
      return (
        sales
          .filter((s) => s.customerId === CUSTOMER && s.status === 'CONFIRMED')
          .reduce((sum, s) => sum + s.debtCents, 0) +
        (opts.otherOpenDebtCents ?? 0)
      );
    }),
    insertCollection: jest.fn(async (input) => {
      calls.push('insertCollection');
      inserted.push(input);
      return { createdAt: new Date('2026-11-25T18:00:01.000Z') };
    }),
  };

  let paymentSeq = 0;
  const saleRepo = {
    acquireCollectionIdempotency: jest.fn(async () => {
      calls.push('acquire');
      return opts.acquire ?? { kind: 'acquired', token: 'tok-1' };
    }),
    markCollectionIdempotencySucceeded: jest.fn(async () => {
      calls.push('markSucceeded');
    }),
    persistCollectedPayments: jest.fn(async (input) => {
      calls.push(`persist:${input.saleId}`);
      persisted.push(input);
      const sale = (opts.lockedSales ?? sales).find(
        (s) => s.saleId === input.saleId,
      )!;
      const batch = input.payments.reduce(
        (a: number, p: any) => a + p.amountCents,
        0,
      );
      const paid = paidNow.get(sale.saleId)! + batch;
      paidNow.set(sale.saleId, paid);
      const debt = sale.totalCents - paid;
      return {
        paymentIds: input.payments.map(() => `pay-${++paymentSeq}`),
        paidCents: paid,
        debtCents: debt,
        paymentStatus: debt === 0 ? 'PAID' : paid === 0 ? 'CREDIT' : 'PARTIAL',
        totalCents: sale.totalCents,
      };
    }),
  };

  const ledger = {
    assertOpenSession: jest.fn(async () => {
      calls.push('assertOpenSession');
    }),
    recordPayments: jest.fn(async () => {
      calls.push('recordPayments');
    }),
  };
  const outbox = {
    publish: jest.fn(async (_c, _t, _a, _id, type: string) => {
      calls.push(`outbox:${type}`);
    }),
  };
  const tenantPrisma = {
    getTenantId: () => TENANT,
    getClient: () => ({ tx: true }),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      calls.push('tx');
      return work();
    }),
  };
  const resolver = {
    resolveActive: jest.fn(async () => ({
      name: 'Terminal BBVA',
      subtitle: null,
    })),
  };

  const service = new CustomerCollectionService(
    saleRepo as never,
    collectionRepo,
    outbox as never,
    tenantPrisma as never,
    resolver as never,
    ledger as never,
    () => NOW,
    undefined,
  );
  return {
    service,
    calls,
    sales,
    persisted,
    inserted,
    ledger,
    outbox,
    saleRepo,
    resolver,
    lockedIds,
  };
}

async function ruleError(
  promise: Promise<unknown>,
): Promise<BusinessRuleViolationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleViolationError);
    return error as BusinessRuleViolationError;
  }
  throw new Error('expected a BusinessRuleViolationError');
}

const body = (
  over: Partial<CreateCustomerCollectionDto> = {},
): CreateCustomerCollectionDto => ({
  payments: [
    { method: 'card_debit', amountCents: 600 },
    { method: 'cash', amountCents: 300 },
  ],
  cashSessionId: SESSION,
  ...over,
});

describe('CustomerCollectionService.preview', () => {
  it('returns the §6 shape with every candidate in Q1 order (incl. appliedCents 0) and writes nothing', async () => {
    const h = harness();

    const res = await h.service.preview(CUSTOMER, {
      payments: [{ method: 'card_debit', amountCents: 600 }],
    });

    expect(res).toEqual({
      customer: { id: CUSTOMER, name: 'Ana López' },
      debtCents: 1200,
      tenderedCents: 600,
      appliedCents: 600,
      changeDueCents: 0,
      payments: [{ method: 'card_debit', amountCents: 600, catalog: null }],
      sales: [
        {
          saleId: 'A',
          folio: 'V-A',
          confirmedAt: '2026-10-01T15:00:00.000Z',
          dueDate: '2026-11-01T00:00:00.000Z',
          overdue: true,
          appliedCents: 300,
          paidCents: 300,
          debtCents: 0,
          paymentStatus: 'PAID',
        },
        {
          saleId: 'B',
          folio: 'V-B',
          confirmedAt: '2026-10-01T15:00:00.000Z',
          dueDate: '2026-11-30T00:00:00.000Z',
          overdue: false,
          appliedCents: 300,
          paidCents: 500,
          debtCents: 200,
          paymentStatus: 'PARTIAL',
        },
        {
          saleId: 'C',
          folio: 'V-C',
          confirmedAt: '2026-10-01T15:00:00.000Z',
          dueDate: null,
          overdue: false,
          appliedCents: 0,
          paidCents: 0,
          debtCents: 400,
          paymentStatus: 'CREDIT',
        },
      ],
      remainingCustomerDebtCents: 600,
    });
    expect(h.calls).toEqual(['findCustomer:false', 'findOpenDebtSales:false']);
    expect(h.ledger.assertOpenSession).not.toHaveBeenCalled();
    expect(h.saleRepo.acquireCollectionIdempotency).not.toHaveBeenCalled();
  });

  it('accepts no tenders (shows the debt) and snapshots catalog tenders', async () => {
    const h = harness();
    const empty = await h.service.preview(CUSTOMER, {});
    expect(empty.sales.map((s) => s.appliedCents)).toEqual([0, 0, 0]);
    expect(empty.debtCents).toBe(1200);

    const catalog = await h.service.preview(CUSTOMER, {
      payments: [
        {
          method: 'card_credit',
          amountCents: 100,
          paymentMethodId: '22222222-2222-4222-8222-222222222222',
        },
      ],
    });
    expect(catalog.payments).toEqual([
      {
        method: 'card_credit',
        amountCents: 100,
        catalog: {
          paymentMethodId: '22222222-2222-4222-8222-222222222222',
          name: 'Terminal BBVA',
        },
      },
    ]);
    expect(h.resolver.resolveActive).toHaveBeenCalledWith({
      paymentMethodId: '22222222-2222-4222-8222-222222222222',
      tenantId: TENANT,
      expectedCategory: 'card_credit',
    });
  });

  it('with saleIds counts the rest of the customer debt in remainingCustomerDebtCents', async () => {
    const h = harness();
    const res = await h.service.preview(CUSTOMER, {
      saleIds: ['C'],
      payments: [{ method: 'cash', amountCents: 100 }],
    });
    expect(res.sales.map((s) => [s.saleId, s.appliedCents])).toEqual([
      ['C', 100],
    ]);
    expect(res.debtCents).toBe(400);
    expect(res.remainingCustomerDebtCents).toBe(1100);
  });

  it('answers 404 CUSTOMER_NOT_FOUND for an unknown (or foreign) customer', async () => {
    const h = harness({ customer: false });
    const error = await ruleError(h.service.preview(CUSTOMER, {}));
    expect(error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it.each([
    [
      'of another customer',
      row({ saleId: 'X', debtCents: 100, customerId: 'other' }),
    ],
    ['without debt', row({ saleId: 'X', debtCents: 0, paymentStatus: 'PAID' })],
    ['not CONFIRMED', row({ saleId: 'X', debtCents: 100, status: 'CANCELED' })],
  ])(
    'rejects a selected sale %s with COLLECTION_SALE_NOT_ELIGIBLE and its id',
    async (_label, bad) => {
      const h = harness({ sales: [...exampleSales(), bad] });
      const error = await ruleError(
        h.service.preview(CUSTOMER, { saleIds: ['A', 'X'] }),
      );
      expect(error.code).toBe('COLLECTION_SALE_NOT_ELIGIBLE');
      expect(error.details).toEqual({ saleId: 'X' });
    },
  );

  it('rejects an unknown selected sale with COLLECTION_SALE_NOT_ELIGIBLE', async () => {
    const h = harness();
    const error = await ruleError(
      h.service.preview(CUSTOMER, { saleIds: ['missing'] }),
    );
    expect(error.code).toBe('COLLECTION_SALE_NOT_ELIGIBLE');
    expect(error.details).toEqual({ saleId: 'missing' });
  });

  it('answers COLLECTION_NO_OPEN_DEBT when the customer owes nothing', async () => {
    const h = harness({ sales: [] });
    const error = await ruleError(h.service.preview(CUSTOMER, {}));
    expect(error.code).toBe('COLLECTION_NO_OPEN_DEBT');
  });

  it('answers COLLECTION_EXCEEDS_DEBT for an excess without cash', async () => {
    const h = harness();
    const error = await ruleError(
      h.service.preview(CUSTOMER, {
        payments: [{ method: 'transfer', amountCents: 1201 }],
      }),
    );
    expect(error.code).toBe('COLLECTION_EXCEEDS_DEBT');
  });
});

describe('CustomerCollectionService.apply', () => {
  it('requires a cash session (422 CASH_SESSION_REQUIRED) before any transaction or acquire', async () => {
    const h = harness();
    const error = await ruleError(
      h.service.apply(
        CUSTOMER,
        ACTOR,
        body({ cashSessionId: undefined }),
        'key-1',
      ),
    );
    expect(error.code).toBe('CASH_SESSION_REQUIRED');
    expect(h.calls).toEqual([]);
  });

  it('runs acquire → session fence → customer lock → candidate read → sale locks → writes → events → success, in ONE transaction', async () => {
    const h = harness();

    const result = await h.service.apply(CUSTOMER, ACTOR, body(), 'key-1');

    expect(result.replayed).toBe(false);
    expect(h.calls).toEqual([
      'tx',
      'acquire',
      'assertOpenSession',
      'findCustomer:true',
      'findOpenDebtSales:false',
      'findSalesByIds:true',
      'insertCollection',
      'persist:A',
      'outbox:sale.payment.received',
      'outbox:sale.fully.paid',
      'persist:B',
      'outbox:sale.payment.received',
      'outbox:sale.payment.received',
      'outbox:sale.fully.paid',
      'persist:C',
      'outbox:sale.payment.received',
      'recordPayments',
      'outbox:customer.collection.recorded',
      'markSucceeded',
    ]);
    expect(h.ledger.assertOpenSession).toHaveBeenCalledWith(SESSION, ACTOR);
  });

  it('writes one row per (sale, tender part) for the applied amount, tagged with the collection', async () => {
    const h = harness();
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body(),
      'key-1',
    );
    const collectionId = res.collectionId;

    expect(h.inserted).toEqual([
      {
        id: collectionId,
        customerId: CUSTOMER,
        actorUserId: ACTOR,
        cashSessionId: SESSION,
        tenderedCents: 900,
        appliedCents: 900,
        changeDueCents: 0,
        tendersJson: [
          { method: 'card_debit', amountCents: 600, catalog: null },
          { method: 'cash', amountCents: 300, catalog: null },
        ],
      },
    ]);
    expect(h.persisted).toEqual([
      {
        saleId: 'A',
        userId: ACTOR,
        collectionId,
        payments: [
          {
            method: 'card_debit',
            amountCents: 300,
            reference: undefined,
            metadataJson: undefined,
          },
        ],
      },
      {
        saleId: 'B',
        userId: ACTOR,
        collectionId,
        payments: [
          {
            method: 'card_debit',
            amountCents: 300,
            reference: undefined,
            metadataJson: undefined,
          },
          {
            method: 'cash',
            amountCents: 200,
            reference: undefined,
            metadataJson: undefined,
          },
        ],
      },
      {
        saleId: 'C',
        userId: ACTOR,
        collectionId,
        payments: [
          {
            method: 'cash',
            amountCents: 100,
            reference: undefined,
            metadataJson: undefined,
          },
        ],
      },
    ]);
  });

  it('returns the §6 POST shape (only sales that received money, with paymentIds) and stores it for replay', async () => {
    const h = harness({
      sales: [
        ...exampleSales(),
        row({ saleId: 'D', debtCents: 50, totalCents: 50 }),
      ],
    });
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body({ payments: [{ method: 'card_debit', amountCents: 400 }] }),
      'key-1',
    );

    expect(res).toEqual({
      collectionId: expect.any(String),
      customer: { id: CUSTOMER, name: 'Ana López' },
      createdAt: '2026-11-25T18:00:01.000Z',
      tenderedCents: 400,
      appliedCents: 400,
      changeDueCents: 0,
      payments: [{ method: 'card_debit', amountCents: 400, catalog: null }],
      sales: [
        expect.objectContaining({
          saleId: 'A',
          appliedCents: 300,
          paidCents: 300,
          debtCents: 0,
          paymentStatus: 'PAID',
          overdue: true,
          paymentIds: ['pay-1'],
        }),
        expect.objectContaining({
          saleId: 'B',
          appliedCents: 100,
          paidCents: 300,
          debtCents: 400,
          paymentStatus: 'PARTIAL',
          overdue: false,
          paymentIds: ['pay-2'],
        }),
      ],
      remainingCustomerDebtCents: 850,
    });
    expect(h.saleRepo.markCollectionIdempotencySucceeded).toHaveBeenCalledWith(
      'tok-1',
      res,
    );
  });

  it('records every payment and ONE change on the ledger: the last cash part carries the tendered cash, SALE_CHANGE the change', async () => {
    const h = harness();
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body({
        payments: [
          { method: 'cash', amountCents: 500 },
          { method: 'card_debit', amountCents: 900 },
        ],
      }),
      'key-1',
    );

    expect(res).toMatchObject({
      tenderedCents: 1400,
      appliedCents: 1200,
      changeDueCents: 200,
    });
    expect(h.ledger.recordPayments).toHaveBeenCalledTimes(1);
    const ledgerInput = h.ledger.recordPayments.mock.calls[0][0];
    expect(ledgerInput).toMatchObject({
      sessionId: SESSION,
      actorId: ACTOR,
      saleId: res.collectionId,
      changeDueCents: 200,
    });
    // card 300 → A, card 500 → B, card 100 + cash 300 → C (+200 change on it)
    expect(
      ledgerInput.payments.map((p: any) => [p.method, p.amountCents]),
    ).toEqual([
      ['card_debit', 300],
      ['card_debit', 500],
      ['card_debit', 100],
      ['cash', 500],
    ]);
    // the stored payment rows keep the APPLIED amount
    expect(h.persisted[2].payments.map((p) => p.amountCents)).toEqual([
      100, 300,
    ]);
    expect(h.inserted[0].changeDueCents).toBe(200);
  });

  it('when all the cash is change (non-cash covers the debt) writes no cash movement and no SALE_CHANGE; the change stays on the collection', async () => {
    const h = harness({
      sales: [row({ saleId: 'A', debtCents: 800, totalCents: 800 })],
    });
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body({
        payments: [
          { method: 'card_debit', amountCents: 800 },
          { method: 'cash', amountCents: 200 },
        ],
      }),
      'key-1',
    );
    expect(res.changeDueCents).toBe(200);
    const ledgerInput = h.ledger.recordPayments.mock.calls[0][0];
    expect(ledgerInput.changeDueCents).toBe(0);
    expect(ledgerInput.payments.map((p: any) => p.method)).toEqual([
      'card_debit',
    ]);
  });

  it('emits per-sale events tagged with the collection and one customer.collection.recorded', async () => {
    const h = harness();
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body(),
      'key-1',
    );
    const byType = (type: string) =>
      h.outbox.publish.mock.calls.filter((c) => c[4] === type);

    expect(byType('sale.payment.received')).toHaveLength(4);
    for (const call of byType('sale.payment.received')) {
      expect(call[5]).toMatchObject({
        collectionId: res.collectionId,
        actorId: ACTOR,
      });
    }
    expect(byType('sale.fully.paid').map((c) => c[3])).toEqual(['A', 'B']);
    const [recorded] = byType('customer.collection.recorded');
    expect(recorded.slice(1, 4)).toEqual([
      TENANT,
      'SaleCollection',
      res.collectionId,
    ]);
    expect(recorded[5]).toMatchObject({
      collectionId: res.collectionId,
      tenantId: TENANT,
      customerId: CUSTOMER,
      actorId: ACTOR,
      cashSessionId: SESSION,
      tenderedCents: 900,
      appliedCents: 900,
      changeDueCents: 0,
      remainingCustomerDebtCents: 300,
      sales: [
        {
          saleId: 'A',
          folio: 'V-A',
          appliedCents: 300,
          debtCents: 0,
          paymentStatus: 'PAID',
          paymentIds: ['pay-1'],
        },
        {
          saleId: 'B',
          folio: 'V-B',
          appliedCents: 500,
          debtCents: 0,
          paymentStatus: 'PAID',
          paymentIds: ['pay-2', 'pay-3'],
        },
        {
          saleId: 'C',
          folio: 'V-C',
          appliedCents: 100,
          debtCents: 300,
          paymentStatus: 'PARTIAL',
          paymentIds: ['pay-4'],
        },
      ],
    });
  });

  it('stamps payment events, cash movements and customer.collection.recorded with the SALES_CLOCK', async () => {
    const h = harness();
    await h.service.apply(CUSTOMER, ACTOR, body(), 'key-1');

    const payloads = (type: string) =>
      h.outbox.publish.mock.calls.filter((c) => c[4] === type).map((c) => c[5]);
    const iso = NOW.toISOString();
    expect(payloads('sale.payment.received').length).toBeGreaterThan(0);
    for (const payload of payloads('sale.payment.received')) {
      expect(payload.occurredAt).toBe(iso);
    }
    expect(payloads('sale.fully.paid').map((p) => p.paidAt)).toEqual([
      iso,
      iso,
    ]);
    expect(payloads('customer.collection.recorded')[0].occurredAt).toBe(iso);
    expect(h.ledger.recordPayments.mock.calls[0][0].occurredAt).toEqual(NOW);
  });

  it('replays a stored response without touching the fence, locks or money', async () => {
    const stored = { collectionId: 'col-0' };
    const h = harness({ acquire: { kind: 'replay', payload: stored } });
    const result = await h.service.apply(CUSTOMER, ACTOR, body(), 'key-1');
    expect(result).toEqual({ replayed: true, body: stored });
    expect(h.calls).toEqual(['tx', 'acquire']);
  });

  it.each([
    ['conflict', 'IDEMPOTENCY_KEY_CONFLICT'],
    ['in_flight', 'IDEMPOTENCY_KEY_IN_FLIGHT'],
  ])('maps an idempotency %s to %s', async (kind, code) => {
    const h = harness({ acquire: { kind } });
    const error = await ruleError(
      h.service.apply(CUSTOMER, ACTOR, body(), 'key-1'),
    );
    expect(error.code).toBe(code);
    expect(h.calls).toEqual(['tx', 'acquire']);
  });

  it('answers 409 COLLECTION_DEBT_CHANGED with the current preview when expectedDebtCents differs, before any write', async () => {
    const h = harness();
    const error = await ruleError(
      h.service.apply(
        CUSTOMER,
        ACTOR,
        body({ expectedDebtCents: 1100 }),
        'key-1',
      ),
    );
    expect(error.code).toBe('COLLECTION_DEBT_CHANGED');
    expect(error.details).toEqual({
      preview: expect.objectContaining({
        debtCents: 1200,
        appliedCents: 900,
        remainingCustomerDebtCents: 300,
        sales: expect.arrayContaining([
          expect.objectContaining({ saleId: 'C', appliedCents: 100 }),
        ]),
      }),
    });
    expect(h.inserted).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.ledger.recordPayments).not.toHaveBeenCalled();
  });

  it('proceeds when expectedDebtCents matches the debt under lock', async () => {
    const h = harness();
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body({ expectedDebtCents: 1200 }),
      'key-1',
    );
    expect(res.appliedCents).toBe(900);
  });

  it('locks the selected sales by id when saleIds is given', async () => {
    const h = harness();
    const { body: res } = await h.service.apply(
      CUSTOMER,
      ACTOR,
      body({
        saleIds: ['C', 'A'],
        payments: [{ method: 'cash', amountCents: 600 }],
      }),
      'key-1',
    );
    expect(h.calls).toContain('findSalesByIds:true');
    expect(h.persisted.map((p) => p.saleId)).toEqual(['A', 'C']);
    // the whole customer debt (also B) is read BEFORE any payment row
    expect(h.calls.indexOf('sumOpenDebt')).toBeGreaterThan(-1);
    expect(h.calls.indexOf('sumOpenDebt')).toBeLessThan(
      h.calls.indexOf('insertCollection'),
    );
    expect(res.remainingCustomerDebtCents).toBe(600);
  });

  describe('without saleIds: locks only the sales the tender reaches (R4)', () => {
    // Q1 order of the example: A 300 → B 500 → C 400 (debt 1200).
    const card = (amountCents: number) =>
      body({ payments: [{ method: 'card_debit', amountCents }] });

    it('reads the candidates unlocked, then locks only the reached prefix (ids ascending) after the customer', async () => {
      const h = harness();
      const { body: res } = await h.service.apply(
        CUSTOMER,
        ACTOR,
        card(400),
        'key-1',
      );

      expect(h.lockedIds).toEqual([['A', 'B']]);
      expect(h.calls.slice(3, 6)).toEqual([
        'findCustomer:true',
        'findOpenDebtSales:false',
        'findSalesByIds:true',
      ]);
      expect(h.persisted.map((p) => p.saleId)).toEqual(['A', 'B']);
      // the debt of the unlocked rest (C) still counts
      expect(res.remainingCustomerDebtCents).toBe(800);
    });

    it('locks every candidate when the tender covers the whole debt (the change needs them all)', async () => {
      const h = harness();
      const { body: res } = await h.service.apply(
        CUSTOMER,
        ACTOR,
        body({
          payments: [
            { method: 'card_debit', amountCents: 1200 },
            { method: 'cash', amountCents: 100 },
          ],
        }),
        'key-1',
      );
      expect(h.lockedIds).toEqual([['A', 'B', 'C']]);
      expect(res.changeDueCents).toBe(100);
    });

    it('answers COLLECTION_NO_OPEN_DEBT without locking any sale when nothing is owed', async () => {
      const h = harness({ sales: [] });
      const error = await ruleError(
        h.service.apply(CUSTOMER, ACTOR, card(100), 'key-1'),
      );
      expect(error.code).toBe('COLLECTION_NO_OPEN_DEBT');
      expect(h.lockedIds).toEqual([]);
    });

    it('answers 409 COLLECTION_DEBT_CHANGED (current preview, nothing written) when a reached sale is no longer eligible under the lock', async () => {
      const h = harness({
        lockedSales: exampleSales().map((s) =>
          s.saleId === 'A'
            ? { ...s, paidCents: 300, debtCents: 0, paymentStatus: 'PAID' }
            : s,
        ),
      });
      const error = await ruleError(
        h.service.apply(CUSTOMER, ACTOR, card(400), 'key-1'),
      );

      expect(error.code).toBe('COLLECTION_DEBT_CHANGED');
      expect(error.details).toEqual({
        preview: expect.objectContaining({
          debtCents: 900,
          appliedCents: 400,
          remainingCustomerDebtCents: 500,
          sales: [
            expect.objectContaining({ saleId: 'B', appliedCents: 400 }),
            expect.objectContaining({ saleId: 'C', appliedCents: 0 }),
          ],
        }),
      });
      expect(h.inserted).toEqual([]);
      expect(h.persisted).toEqual([]);
      expect(h.ledger.recordPayments).not.toHaveBeenCalled();
      expect(
        h.saleRepo.markCollectionIdempotencySucceeded,
      ).not.toHaveBeenCalled();
    });

    it('answers 409 COLLECTION_DEBT_CHANGED when a smaller debt under the lock would carry the tender into an unlocked sale', async () => {
      // tender 800 = A 300 + B 500 → prefix [A, B]; B was paid 100 meanwhile
      const h = harness({
        lockedSales: exampleSales().map((s) =>
          s.saleId === 'B' ? { ...s, paidCents: 300, debtCents: 400 } : s,
        ),
      });
      const error = await ruleError(
        h.service.apply(CUSTOMER, ACTOR, card(800), 'key-1'),
      );

      expect(error.code).toBe('COLLECTION_DEBT_CHANGED');
      expect(error.details).toEqual({
        preview: expect.objectContaining({
          debtCents: 1100,
          sales: [
            expect.objectContaining({ saleId: 'A', appliedCents: 300 }),
            expect.objectContaining({ saleId: 'B', appliedCents: 400 }),
            expect.objectContaining({ saleId: 'C', appliedCents: 100 }),
          ],
        }),
      });
      expect(h.lockedIds).toEqual([['A', 'B']]);
      expect(h.persisted).toEqual([]);
    });

    it('answers 409 COLLECTION_DEBT_CHANGED when a larger debt under the lock leaves a locked sale without money', async () => {
      // tender 400 → prefix [A, B]; A now owes 400 (absorbs the whole tender)
      const h = harness({
        lockedSales: exampleSales().map((s) =>
          s.saleId === 'A' ? { ...s, totalCents: 400, debtCents: 400 } : s,
        ),
      });
      const error = await ruleError(
        h.service.apply(CUSTOMER, ACTOR, card(400), 'key-1'),
      );
      expect(error.code).toBe('COLLECTION_DEBT_CHANGED');
      expect(h.persisted).toEqual([]);
    });

    it('compares expectedDebtCents with the debt read in this request (locked prefix + unlocked rest)', async () => {
      // B paid 50 meanwhile: the tender still reaches exactly [A, B]
      const lockedSales = exampleSales().map((s) =>
        s.saleId === 'B' ? { ...s, paidCents: 250, debtCents: 450 } : s,
      );
      const stale = harness({ lockedSales });
      const error = await ruleError(
        stale.service.apply(
          CUSTOMER,
          ACTOR,
          body({
            expectedDebtCents: 1200,
            payments: [{ method: 'card_debit', amountCents: 400 }],
          }),
          'key-1',
        ),
      );
      expect(error.code).toBe('COLLECTION_DEBT_CHANGED');
      expect(error.details).toEqual({
        preview: expect.objectContaining({ debtCents: 1150 }),
      });

      const fresh = harness({ lockedSales });
      const { body: res } = await fresh.service.apply(
        CUSTOMER,
        ACTOR,
        body({
          expectedDebtCents: 1150,
          payments: [{ method: 'card_debit', amountCents: 400 }],
        }),
        'key-1',
      );
      expect(res.sales.map((s) => [s.saleId, s.appliedCents])).toEqual([
        ['A', 300],
        ['B', 100],
      ]);
      expect(res.remainingCustomerDebtCents).toBe(750);
    });
  });

  it('fails closed (rolls back) when the writer disagrees with the locked debt', async () => {
    const h = harness();
    h.saleRepo.persistCollectedPayments.mockResolvedValueOnce({
      paymentIds: ['p'],
      paidCents: 999,
      debtCents: 0,
      paymentStatus: 'PAID',
      totalCents: 999,
    });
    await expect(
      h.service.apply(CUSTOMER, ACTOR, body(), 'key-1'),
    ).rejects.toThrow('COLLECTION_LEDGER_MISMATCH');
    expect(
      h.saleRepo.markCollectionIdempotencySucceeded,
    ).not.toHaveBeenCalled();
  });

  it('hashes the request independently of tender and saleIds order, but binds customer, actor, session and expected debt', async () => {
    const hashes: string[] = [];
    const run = async (
      customerId: string,
      actor: string,
      dto: CreateCustomerCollectionDto,
    ) => {
      const h = harness({ acquire: { kind: 'conflict' } });
      await ruleError(h.service.apply(customerId, actor, dto, 'key-1'));
      hashes.push(h.saleRepo.acquireCollectionIdempotency.mock.calls[0][1]);
      expect(h.saleRepo.acquireCollectionIdempotency.mock.calls[0][0]).toBe(
        'key-1',
      );
    };
    const tenders = body().payments;
    await run(CUSTOMER, ACTOR, body({ saleIds: ['A', 'B'] }));
    await run(
      CUSTOMER,
      ACTOR,
      body({ payments: [...tenders].reverse(), saleIds: ['B', 'A'] }),
    );
    await run('cust-2', ACTOR, body({ saleIds: ['A', 'B'] }));
    await run(CUSTOMER, 'user-2', body({ saleIds: ['A', 'B'] }));
    await run(
      CUSTOMER,
      ACTOR,
      body({ saleIds: ['A', 'B'], expectedDebtCents: 800 }),
    );
    await run(
      CUSTOMER,
      ACTOR,
      body({
        saleIds: ['A', 'B'],
        cashSessionId: '33333333-3333-4333-8333-333333333333',
      }),
    );

    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes.slice(1)).size).toBe(5);
  });
});
