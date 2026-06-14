import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import type {
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { SalesService } from '../sales.service';
import { Sale } from '../domain/sale.entity';
import type { ISaleRepository } from '../domain/sale.repository';
import {
  ReceiptNotActionableError,
  SaleNotReviewableError,
} from './domain/receipt-review.errors';
import type {
  ReceiptReviewRecord,
  ReceiptReviewRepository,
} from './domain/receipt-review.repository';
import { ReceiptReviewService } from './receipt-review.service';
import { ReceiptReviewController } from './receipt-review.controller';

type PaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';

type MutableSaleState = {
  id: string;
  tenantId: string;
  userId: string;
  status: 'DRAFT' | 'CONFIRMED';
  channel: 'POS' | 'ONLINE';
  folio: string;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  paymentStatus: PaymentStatus;
};

type PersistedPayment = {
  id: string;
  saleId: string;
  userId: string | null;
  method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
  amountCents: number;
  reference: string | null;
  metadataJson?: unknown;
};

type PublishedEvent = {
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

type TestRequest = {
  headers: Record<string, string | undefined>;
  user?: AuthenticatedUser & { permissions: string[] };
};

type SupertestApp = Parameters<typeof request>[0];

class InMemorySaleRepository implements Pick<
  ISaleRepository,
  | 'findByIdForUpdate'
  | 'acquirePaymentIdempotency'
  | 'markPaymentIdempotencySucceeded'
  | 'persistCollectedPayments'
  | 'runInTransaction'
> {
  readonly payments: PersistedPayment[] = [];
  private readonly idempotency = new Map<
    string,
    { requestHash: string; token: string; payload?: unknown }
  >();

  constructor(private readonly sale: MutableSaleState) {}

  findByIdForUpdate(id: string): Promise<Sale | null> {
    if (id !== this.sale.id) return Promise.resolve(null);

    return Promise.resolve(
      Sale.fromPersistence({
        id: this.sale.id,
        userId: this.sale.userId,
        status: this.sale.status,
        channel: this.sale.channel,
        register: 'Principal',
        deliveryStatus: 'PENDING',
        customerId: null,
        shippingAddressId: null,
        sellerUserId: null,
        dueDate: null,
        items: [],
        confirmedAt: new Date('2026-06-13T09:00:00.000Z'),
        folio: this.sale.folio,
        createdAt: new Date('2026-06-13T08:00:00.000Z'),
        updatedAt: new Date('2026-06-13T09:00:00.000Z'),
      }),
    );
  }

  acquirePaymentIdempotency(
    saleId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'acquired'; token: string }
    | { kind: 'replay'; payload: unknown }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  > {
    const mapKey = `${saleId}:${key}`;
    const existing = this.idempotency.get(mapKey);

    if (!existing) {
      const token = `token-${this.idempotency.size + 1}`;
      this.idempotency.set(mapKey, { requestHash, token });
      return Promise.resolve({ kind: 'acquired', token });
    }

    if (existing.requestHash !== requestHash) {
      return Promise.resolve({ kind: 'conflict' });
    }
    if (existing.payload === undefined) {
      return Promise.resolve({ kind: 'in_flight' });
    }

    return Promise.resolve({ kind: 'replay', payload: existing.payload });
  }

  markPaymentIdempotencySucceeded(
    token: string,
    _saleId: string,
    payload: unknown,
  ): Promise<void> {
    for (const entry of this.idempotency.values()) {
      if (entry.token === token) entry.payload = payload;
    }

    return Promise.resolve();
  }

  persistCollectedPayments(input: {
    saleId: string;
    userId: string | null;
    payments: Array<{
      method: 'cash' | 'card_credit' | 'card_debit' | 'transfer';
      amountCents: number;
      reference?: string | null;
      metadataJson?: unknown;
    }>;
  }): Promise<{
    paymentIds: string[];
    paidCents: number;
    debtCents: number;
    paymentStatus: PaymentStatus;
    totalCents: number;
  }> {
    const paymentIds: string[] = [];

    for (const payment of input.payments) {
      const paymentId = `payment-${this.payments.length + 1}`;
      paymentIds.push(paymentId);
      this.payments.push({
        id: paymentId,
        saleId: input.saleId,
        userId: input.userId,
        method: payment.method,
        amountCents: payment.amountCents,
        reference: payment.reference ?? null,
        metadataJson: payment.metadataJson,
      });
      this.sale.paidCents += payment.amountCents;
    }

    this.sale.debtCents = Math.max(
      this.sale.totalCents - this.sale.paidCents,
      0,
    );
    this.sale.paymentStatus = this.sale.debtCents === 0 ? 'PAID' : 'PARTIAL';

    return Promise.resolve({
      paymentIds,
      paidCents: this.sale.paidCents,
      debtCents: this.sale.debtCents,
      paymentStatus: this.sale.paymentStatus,
      totalCents: this.sale.totalCents,
    });
  }

  runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

class InMemoryReceiptReviewRepository implements ReceiptReviewRepository {
  constructor(private readonly receipts: Map<string, ReceiptReviewRecord>) {}

  findPendingForSale(
    saleId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord[]> {
    return Promise.resolve(
      [...this.receipts.values()].filter(
        (receipt) =>
          receipt.saleId === saleId &&
          receipt.tenantId === tenantId &&
          receipt.status === 'PENDING',
      ),
    );
  }

  findById(
    receiptId: string,
    tenantId: string,
  ): Promise<ReceiptReviewRecord | null> {
    const receipt = this.receipts.get(receiptId);
    return Promise.resolve(receipt?.tenantId === tenantId ? receipt : null);
  }

  async markConfirmed(
    receiptId: string,
    tenantId: string,
    userId: string,
    timestamp: Date,
  ): Promise<void> {
    const receipt = await this.findById(receiptId, tenantId);
    if (!receipt) return;

    receipt.status = 'CONFIRMED';
    receipt.confirmedByUserId = userId;
    receipt.confirmedAt = timestamp;
  }

  async markRejected(
    receiptId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    const receipt = await this.findById(receiptId, tenantId);
    if (!receipt) return;

    receipt.status = 'REJECTED';
    receipt.rejectionReason = reason;
  }
}

class CapturingOutboxWriter implements Pick<OutboxWriterService, 'publish'> {
  readonly events: PublishedEvent[] = [];

  publish(
    _client: unknown,
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.events.push({
      tenantId,
      aggregateType,
      aggregateId,
      eventType,
      payload,
    });

    return Promise.resolve();
  }
}

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const auth = request.headers.authorization;
    if (!auth) throw new UnauthorizedException('Unauthorized');

    const token = auth.replace('Bearer ', '');
    const permissions =
      token === 'receipt-reviewer'
        ? ['read:ReceiptEvidence', 'update:ReceiptEvidence']
        : [];

    request.user = {
      userId: 'reviewer-user-id',
      email: 'reviewer@example.com',
      tenantId: 'tenant-id',
      tenantSlug: 'centro',
      isSuperAdmin: false,
      permissions,
    };

    return true;
  }
}

class TestTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    if (!request.user?.tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }

    return true;
  }
}

class TestPermissionsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const permissions = request.user?.permissions ?? [];
    const requiredPermissions = (Reflect.getMetadata(
      'required_permissions',
      context.getHandler(),
    ) ??
      Reflect.getMetadata('required_permissions', context.getClass()) ??
      []) as Array<[AppActions, AppSubjects]>;

    for (const [action, subject] of requiredPermissions) {
      if (!permissions.includes(`${action}:${subject}`)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    return true;
  }
}

function makeSale(overrides: Partial<MutableSaleState> = {}): MutableSaleState {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'tenant-id',
    userId: 'cashier-user-id',
    status: 'CONFIRMED',
    channel: 'ONLINE',
    folio: 'S-001',
    totalCents: 2000,
    paidCents: 500,
    debtCents: 1500,
    paymentStatus: 'PARTIAL',
    ...overrides,
  };
}

function makeReceipt(
  sale: MutableSaleState,
  overrides: Partial<ReceiptReviewRecord> = {},
): ReceiptReviewRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    saleId: sale.id,
    tenantId: sale.tenantId,
    mediaUrl: 'https://spaces.test/receipt.jpg',
    declaredAmountCents: 1500,
    declaredDate: new Date('2026-06-13T10:00:00.000Z'),
    declaredReference: 'TRX-1',
    status: 'PENDING',
    confirmedByUserId: null,
    confirmedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-06-13T10:01:00.000Z'),
    sale: {
      id: sale.id,
      status: sale.status,
      paymentStatus: sale.paymentStatus,
      paidCents: sale.paidCents,
      debtCents: sale.debtCents,
      totalCents: sale.totalCents,
      channel: sale.channel,
    },
    ...overrides,
  };
}

function makeHarness(saleOverrides: Partial<MutableSaleState> = {}) {
  const sale = makeSale(saleOverrides);
  const receipt = makeReceipt(sale);
  const receipts = new Map<string, ReceiptReviewRecord>([
    [receipt.id, receipt],
  ]);
  const saleRepository = new InMemorySaleRepository(sale);
  const receiptRepository = new InMemoryReceiptReviewRepository(receipts);
  const outboxWriter = new CapturingOutboxWriter();
  const tenantPrisma = {
    getTenantId: () => sale.tenantId,
    getClient: () => ({ outboxEvent: { create: jest.fn() } }),
  } as unknown as TenantPrismaService;
  const salesService = new SalesService(
    saleRepository as unknown as ISaleRepository,
    {} as never,
    new EventEmitter2(),
    outboxWriter as unknown as OutboxWriterService,
    tenantPrisma,
  );
  const receiptReviewService = new ReceiptReviewService(
    receiptRepository,
    salesService,
    saleRepository as unknown as ISaleRepository,
    tenantPrisma,
    outboxWriter as unknown as OutboxWriterService,
  );

  return {
    sale,
    receipt,
    receipts,
    saleRepository,
    receiptReviewService,
    outboxWriter,
  };
}

describe('Receipt review integration flow', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-13T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('confirms a pending receipt through the unified reviewer payment path and emits the audit event', async () => {
    const {
      receiptReviewService,
      sale,
      receipt,
      saleRepository,
      outboxWriter,
    } = makeHarness();

    const result = await receiptReviewService.confirm(
      sale.id,
      receipt.id,
      'reviewer-user-id',
      { amountCents: 1500 },
      'idem-confirm-full',
    );

    expect(result.paymentStatus).toBe('PAID');
    expect(sale.paymentStatus).toBe('PAID');
    expect(sale.paidCents).toBe(2000);
    expect(sale.debtCents).toBe(0);
    expect(receipt.status).toBe('CONFIRMED');
    expect(receipt.confirmedByUserId).toBe('reviewer-user-id');
    expect(receipt.confirmedAt).toEqual(new Date('2026-06-13T12:00:00.000Z'));
    expect(saleRepository.payments).toEqual([
      expect.objectContaining({
        userId: null,
        method: 'transfer',
        amountCents: 1500,
        reference: 'TRX-1',
        metadataJson: { origin: { kind: 'bot', channel: 'ONLINE' } },
      }),
    ]);
    expect(outboxWriter.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'sale.payment.received',
          payload: expect.objectContaining({ actorId: null }),
        }),
        expect.objectContaining({ eventType: 'sale.fully.paid' }),
        expect.objectContaining({
          eventType: 'receipt.confirmed',
          aggregateType: 'ReceiptEvidence',
          aggregateId: receipt.id,
          payload: {
            receiptId: receipt.id,
            saleId: sale.id,
            tenantId: sale.tenantId,
            amountCents: 1500,
            paymentMethod: 'TRANSFER',
            origin: { kind: 'bot', channel: 'ONLINE' },
            validatedByUserId: 'reviewer-user-id',
            validatedAt: '2026-06-13T12:00:00.000Z',
            resultingPaymentStatus: 'PAID',
            occurredAt: '2026-06-13T12:00:00.000Z',
          },
        }),
      ]),
    );
  });

  it('leaves the sale partial when the confirmed amount does not clear the balance', async () => {
    const { receiptReviewService, sale, receipt, outboxWriter } = makeHarness();

    const result = await receiptReviewService.confirm(
      sale.id,
      receipt.id,
      'reviewer-user-id',
      { amountCents: 700 },
      'idem-confirm-partial',
    );

    expect(result.paymentStatus).toBe('PARTIAL');
    expect(sale.paymentStatus).toBe('PARTIAL');
    expect(sale.paidCents).toBe(1200);
    expect(sale.debtCents).toBe(800);
    expect(receipt.status).toBe('CONFIRMED');
    const receiptConfirmedEvent = outboxWriter.events.find(
      (event) => event.eventType === 'receipt.confirmed',
    );
    expect(receiptConfirmedEvent?.payload.resultingPaymentStatus).toBe(
      'PARTIAL',
    );
    expect(
      outboxWriter.events.some(
        (event) => event.eventType === 'sale.fully.paid',
      ),
    ).toBe(false);
  });

  it('rejects a pending receipt with a reason while leaving the sale untouched', async () => {
    const {
      receiptReviewService,
      sale,
      receipt,
      saleRepository,
      outboxWriter,
    } = makeHarness();

    await receiptReviewService.reject(sale.id, receipt.id, 'reviewer-user-id', {
      reason: 'Unreadable receipt',
    });

    expect(receipt.status).toBe('REJECTED');
    expect(receipt.rejectionReason).toBe('Unreadable receipt');
    expect(sale.paymentStatus).toBe('PARTIAL');
    expect(sale.paidCents).toBe(500);
    expect(sale.debtCents).toBe(1500);
    expect(saleRepository.payments).toEqual([]);
    expect(outboxWriter.events).toEqual([
      expect.objectContaining({
        eventType: 'receipt.rejected',
        payload: {
          receiptId: receipt.id,
          saleId: sale.id,
          tenantId: sale.tenantId,
          validatedByUserId: 'reviewer-user-id',
          reason: 'Unreadable receipt',
          occurredAt: '2026-06-13T12:00:00.000Z',
        },
      }),
    ]);
  });

  it('blocks repeated review actions and does not create duplicate payments or events', async () => {
    const {
      receiptReviewService,
      sale,
      receipt,
      saleRepository,
      outboxWriter,
    } = makeHarness();

    await receiptReviewService.confirm(
      sale.id,
      receipt.id,
      'reviewer-user-id',
      { amountCents: 1500 },
      'idem-double-confirm',
    );

    await expect(
      receiptReviewService.confirm(
        sale.id,
        receipt.id,
        'reviewer-user-id',
        { amountCents: 1500 },
        'idem-double-confirm',
      ),
    ).rejects.toBeInstanceOf(ReceiptNotActionableError);
    await expect(
      receiptReviewService.reject(sale.id, receipt.id, 'reviewer-user-id', {
        reason: 'Duplicate action',
      }),
    ).rejects.toBeInstanceOf(ReceiptNotActionableError);

    expect(saleRepository.payments).toHaveLength(1);
    expect(
      outboxWriter.events.filter(
        (event) => event.eventType === 'receipt.confirmed',
      ),
    ).toHaveLength(1);
    expect(
      outboxWriter.events.filter(
        (event) => event.eventType === 'receipt.rejected',
      ),
    ).toHaveLength(0);
  });

  it('blocks confirmations for non-reviewable sales before payment or receipt mutation', async () => {
    const {
      receiptReviewService,
      sale,
      receipt,
      saleRepository,
      outboxWriter,
    } = makeHarness({ status: 'DRAFT' });

    await expect(
      receiptReviewService.confirm(
        sale.id,
        receipt.id,
        'reviewer-user-id',
        { amountCents: 1500 },
        'idem-draft-sale',
      ),
    ).rejects.toBeInstanceOf(SaleNotReviewableError);

    expect(receipt.status).toBe('PENDING');
    expect(saleRepository.payments).toEqual([]);
    expect(outboxWriter.events).toEqual([]);
  });

  it('accumulates payments across multiple receipt confirmations and enforces idempotency on re-confirm', async () => {
    const sale = makeSale({
      totalCents: 3000,
      paidCents: 0,
      debtCents: 3000,
      paymentStatus: 'PARTIAL',
    });
    const receiptA = makeReceipt(sale, {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      declaredAmountCents: 1000,
      declaredReference: 'TRX-A',
    });
    const receiptB = makeReceipt(sale, {
      id: 'bbbb2222-2222-4222-8222-222222222222',
      declaredAmountCents: 2000,
      declaredReference: 'TRX-B',
    });
    const receipts = new Map<string, ReceiptReviewRecord>([
      [receiptA.id, receiptA],
      [receiptB.id, receiptB],
    ]);
    const saleRepository = new InMemorySaleRepository(sale);
    const receiptRepository = new InMemoryReceiptReviewRepository(receipts);
    const outboxWriter = new CapturingOutboxWriter();
    const tenantPrisma = {
      getTenantId: () => sale.tenantId,
      getClient: () => ({ outboxEvent: { create: jest.fn() } }),
    } as unknown as TenantPrismaService;
    const salesService = new SalesService(
      saleRepository as unknown as ISaleRepository,
      {} as never,
      new EventEmitter2(),
      outboxWriter as unknown as OutboxWriterService,
      tenantPrisma,
    );
    const receiptReviewService = new ReceiptReviewService(
      receiptRepository,
      salesService,
      saleRepository as unknown as ISaleRepository,
      tenantPrisma,
      outboxWriter as unknown as OutboxWriterService,
    );

    // Confirm receipt A (partial: 1000 of 3000)
    const resultA = await receiptReviewService.confirm(
      sale.id,
      receiptA.id,
      'reviewer-user-id',
      { amountCents: 1000 },
      'idem-multi-a',
    );

    expect(resultA.paymentStatus).toBe('PARTIAL');
    expect(resultA.paidCents).toBe(1000);
    expect(resultA.debtCents).toBe(2000);
    expect(receiptA.status).toBe('CONFIRMED');
    expect(sale.paidCents).toBe(1000);
    expect(sale.debtCents).toBe(2000);

    // Confirm receipt B (settles remaining 2000 → PAID)
    const resultB = await receiptReviewService.confirm(
      sale.id,
      receiptB.id,
      'reviewer-user-id',
      { amountCents: 2000 },
      'idem-multi-b',
    );

    expect(resultB.paymentStatus).toBe('PAID');
    expect(resultB.paidCents).toBe(3000);
    expect(resultB.debtCents).toBe(0);
    expect(receiptB.status).toBe('CONFIRMED');
    expect(sale.paidCents).toBe(3000);
    expect(sale.debtCents).toBe(0);
    expect(sale.paymentStatus).toBe('PAID');

    // Verify two distinct payments were recorded
    expect(saleRepository.payments).toHaveLength(2);
    expect(saleRepository.payments[0]).toEqual(
      expect.objectContaining({
        userId: null,
        method: 'transfer',
        amountCents: 1000,
      }),
    );
    expect(saleRepository.payments[1]).toEqual(
      expect.objectContaining({
        userId: null,
        method: 'transfer',
        amountCents: 2000,
      }),
    );

    // Verify events: two sale.payment.received, one sale.fully.paid, two receipt.confirmed
    const paymentReceivedEvents = outboxWriter.events.filter(
      (e) => e.eventType === 'sale.payment.received',
    );
    const fullyPaidEvents = outboxWriter.events.filter(
      (e) => e.eventType === 'sale.fully.paid',
    );
    const receiptConfirmedEvents = outboxWriter.events.filter(
      (e) => e.eventType === 'receipt.confirmed',
    );

    expect(paymentReceivedEvents).toHaveLength(2);
    expect(fullyPaidEvents).toHaveLength(1);
    expect(receiptConfirmedEvents).toHaveLength(2);
    expect(
      (receiptConfirmedEvents[0].payload as Record<string, unknown>)
        .resultingPaymentStatus,
    ).toBe('PARTIAL');
    expect(
      (receiptConfirmedEvents[1].payload as Record<string, unknown>)
        .resultingPaymentStatus,
    ).toBe('PAID');

    // Idempotency: re-confirming an already-confirmed receipt is blocked
    await expect(
      receiptReviewService.confirm(
        sale.id,
        receiptA.id,
        'reviewer-user-id',
        { amountCents: 1000 },
        'idem-multi-a',
      ),
    ).rejects.toBeInstanceOf(ReceiptNotActionableError);

    // No extra payments or events created by the re-confirm attempt
    expect(saleRepository.payments).toHaveLength(2);
    expect(outboxWriter.events.filter((e) => e.eventType === 'receipt.confirmed')).toHaveLength(2);
  });
});

describe('Receipt review HTTP authorization integration', () => {
  let app: INestApplication;
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-13T12:00:00.000Z'));
    harness = makeHarness();

    const moduleRef = await Test.createTestingModule({
      controllers: [ReceiptReviewController],
      providers: [
        {
          provide: ReceiptReviewService,
          useValue: harness.receiptReviewService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard as Type<CanActivate>)
      .overrideGuard(TenantContextGuard)
      .useClass(TestTenantContextGuard as Type<CanActivate>)
      .overrideGuard(PermissionsGuard)
      .useClass(TestPermissionsGuard as Type<CanActivate>)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.useRealTimers();
  });

  it('allows a permitted reviewer to confirm a receipt through the HTTP boundary', async () => {
    await request(app.getHttpServer() as SupertestApp)
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/confirm',
      )
      .set('Authorization', 'Bearer receipt-reviewer')
      .set('Idempotency-Key', 'http-confirm')
      .send({ amountCents: 1500 })
      .expect(200)
      .expect((response) => {
        const body = response.body as Record<string, unknown>;
        expect(body).toEqual(
          expect.objectContaining({ paymentStatus: 'PAID', debtCents: 0 }),
        );
      });

    expect(harness.receipt.status).toBe('CONFIRMED');
    expect(harness.saleRepository.payments).toHaveLength(1);
  });

  it('blocks an unauthorized actor before the review service mutates state', async () => {
    await request(app.getHttpServer() as SupertestApp)
      .post(
        '/sales/22222222-2222-4222-8222-222222222222/receipts/11111111-1111-4111-8111-111111111111/confirm',
      )
      .set('Authorization', 'Bearer no-review-permissions')
      .set('Idempotency-Key', 'http-unauthorized')
      .send({ amountCents: 1500 })
      .expect(403);

    expect(harness.receipt.status).toBe('PENDING');
    expect(harness.saleRepository.payments).toEqual([]);
    expect(harness.outboxWriter.events).toEqual([]);
  });
});
