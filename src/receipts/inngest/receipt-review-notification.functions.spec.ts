import type { Inngest } from 'inngest';
import type { SendMailInput } from '../../notifications/email/mailer.port';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import { buildReceiptReviewNotificationFunctions } from './receipt-review-notification.functions';
import type { ReceiptReviewRequestedPayload } from '../domain/receipt-review-requested.event';

type Handler = (ctx: {
  event: { id: string; name: string; data: ReceiptReviewRequestedPayload };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

function payload(
  overrides: Partial<ReceiptReviewRequestedPayload> = {},
): ReceiptReviewRequestedPayload {
  return {
    tenantId: 'tenant-1',
    receiptId: 'receipt-1',
    saleId: 'sale-1',
    saleFolio: 'V-0042',
    declaredAmountCents: 4000,
    extractedAmountCents: 10000,
    debtCents: 10000,
    mismatchFlagged: true,
    mimeType: 'application/pdf',
    ...overrides,
  };
}

function setup(
  config = {
    enabled: true,
    recipients: ['u1', 'u2'],
    enabledActions: ['RECEIPT_REVIEW_REQUESTED'],
  },
) {
  const captured: Array<{
    options: Record<string, unknown>;
    handler: Handler;
  }> = [];
  const inngestClient = {
    createFunction: (options: Record<string, unknown>, handler: Handler) => {
      captured.push({ options, handler });
      return { options };
    },
  } as unknown as Inngest;
  const tenantRunner = {
    runWithTenant: jest.fn((_tenantId: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
  const notificationConfigRepository = {
    find: jest.fn().mockResolvedValue(config),
  };
  const reviewerLookup = {
    resolveReviewerEmails: jest
      .fn()
      .mockResolvedValue(['a@example.com', 'a@example.com', 'b@example.com']),
  };
  const send = jest
    .fn<Promise<void>, [SendMailInput]>()
    .mockResolvedValue(undefined);
  buildReceiptReviewNotificationFunctions({
    inngestClient,
    tenantRunner: tenantRunner as unknown as Pick<
      TenantRunnerService,
      'runWithTenant'
    >,
    notificationConfigRepository,
    reviewerLookup,
    mailer: { send },
    appBaseUrl: 'https://app.example.com',
  });
  const steps: string[] = [];
  const run = (data: ReceiptReviewRequestedPayload) =>
    captured[0].handler({
      event: { id: 'evt-1', name: 'receipts/review.requested', data },
      step: {
        run: (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    });
  return { captured, run, send, reviewerLookup, tenantRunner, steps };
}

describe('receipt-review-requested-email Inngest function', () => {
  it('registers on receipts/review.requested with event-id idempotency', () => {
    const { captured } = setup();

    expect(captured[0].options).toMatchObject({
      id: 'receipt-review-requested-email',
      triggers: [{ event: 'receipts/review.requested' }],
      idempotency: 'event.id',
    });
  });

  it('emails the configured recipients who can review receipts, inside the tenant', async () => {
    const { run, send, reviewerLookup, tenantRunner, steps } = setup();

    await expect(run(payload())).resolves.toEqual({ sent: true });

    expect(steps).toEqual(['load-config', 'resolve-recipients', 'send-email']);
    expect(reviewerLookup.resolveReviewerEmails).toHaveBeenCalledWith([
      'u1',
      'u2',
    ]);
    expect(
      tenantRunner.runWithTenant.mock.calls.every(
        ([tenantId]) => tenantId === 'tenant-1',
      ),
    ).toBe(true);
    const mail = send.mock.calls[0][0] as SendMailInput & {
      attachments?: unknown;
    };
    expect(mail.to).toEqual(['a@example.com', 'b@example.com']);
    expect(mail.subject).toBe('Comprobante por revisar · pedido V-0042');
    expect(mail.attachments).toBeUndefined();
    expect(mail.html).toContain('V-0042');
    // R10 / §6.3: the email never shows who the customer is.
    expect(mail.html).not.toContain('Ana López');
    expect(mail.html).not.toContain('Cliente');
    expect(mail.html).toContain('$40.00');
    expect(mail.html).toContain('$100.00');
    expect(mail.html).toContain('No coincide con el saldo');
    expect(mail.html).toContain('https://app.example.com');
    expect(mail.html).not.toContain('receipts/');
  });

  it('never renders a customer name, even from a stale outbox row that still carries one (R10)', async () => {
    const { run, send } = setup();

    // Rows queued before this change have `customerName` in their payload.
    await run({
      ...payload(),
      customerName: 'Ana López',
      customerPhone: '5512345678',
    } as ReceiptReviewRequestedPayload);

    const mail = send.mock.calls[0][0];
    expect(mail.html).not.toContain('Ana López');
    expect(mail.html).not.toContain('5512345678');
    expect(mail.subject).not.toContain('Ana');
    // The rest of the email is unchanged: folio, amounts and the warning.
    expect(mail.html).toContain('V-0042');
    expect(mail.html).toContain('$100.00');
    expect(mail.html).toContain('No coincide con el saldo');
  });

  it('renders not-declared amounts and a matching receipt', async () => {
    const { run, send } = setup();

    await run(
      payload({
        saleFolio: null,
        declaredAmountCents: null,
        extractedAmountCents: null,
        mismatchFlagged: false,
      }),
    );

    const mail = send.mock.calls[0][0];
    expect(mail.subject).toBe('Comprobante de transferencia por revisar');
    expect(mail.html).toContain('No declarado');
    expect(mail.html).not.toContain('No coincide con el saldo');
  });

  it.each([
    [
      'master-disabled',
      {
        enabled: false,
        recipients: ['u1'],
        enabledActions: ['RECEIPT_REVIEW_REQUESTED'],
      },
    ],
    [
      'action-disabled',
      { enabled: true, recipients: ['u1'], enabledActions: ['LOW_STOCK'] },
    ],
    [
      'no-recipients',
      {
        enabled: true,
        recipients: [],
        enabledActions: ['RECEIPT_REVIEW_REQUESTED'],
      },
    ],
  ])('skips with %s (config drift re-gate)', async (reason, config) => {
    const { run, send } = setup(config);

    await expect(run(payload())).resolves.toEqual({ skipped: reason });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when no recipient can review receipts', async () => {
    const { run, send, reviewerLookup } = setup();
    reviewerLookup.resolveReviewerEmails.mockResolvedValue([]);

    await expect(run(payload())).resolves.toEqual({
      skipped: 'no-reviewer-recipients',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a payload without tenant', async () => {
    const { run } = setup();

    await expect(run(payload({ tenantId: '' }))).resolves.toEqual({
      skipped: 'missing-tenant',
    });
  });
});
