/**
 * shipping-zones / T1 (S3) — `delivery-zone-validation-email` Inngest fn.
 * Same three-step topology as the time-off email: re-gate config, resolve the
 * configured recipients that can validate zones, render + send.
 */
import type { Inngest } from 'inngest';
import type { DeliveryZoneValidationRequestedPayload } from '../domain/delivery-zone-bot.repository';
import {
  buildDeliveryZoneValidationFunctions,
  DELIVERY_ZONE_VALIDATION_EMAIL_FUNCTION_ID,
  DELIVERY_ZONE_VALIDATION_INNGEST_EVENT,
} from './delivery-zone-validation.functions';

const PAYLOAD: DeliveryZoneValidationRequestedPayload = {
  tenantId: 'tenant-1',
  validationId: 'validation-1',
  branchName: 'Sucursal Centro',
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
  lastCustomerMessageAt: '2026-11-05T16:00:00.000Z',
  deadlineAt: '2026-11-06T16:00:00.000Z',
};

type Handler = (ctx: {
  event: { id: string; name: string; data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

function build(config: {
  enabled: boolean;
  recipients: string[];
  enabledActions: string[];
}) {
  let options: Record<string, unknown> = {};
  let handler: Handler = () => Promise.resolve(undefined);
  const inngestClient = {
    createFunction: (opts: Record<string, unknown>, fn: Handler) => {
      options = opts;
      handler = fn;
      return { id: opts.id };
    },
  } as unknown as Inngest;
  const deps = {
    tenantRunner: {
      runWithTenant: jest.fn((_tenantId: string, fn: () => unknown) => fn()),
    },
    notificationConfigRepository: { find: jest.fn().mockResolvedValue(config) },
    validatorLookup: {
      filterValidators: jest.fn((ids: string[]) =>
        Promise.resolve(ids.filter((id) => id !== 'no-permission')),
      ),
    },
    userEmailLookup: {
      resolveEmailsByUserIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map((id) => `${id}@houndfe.test`)),
      ),
    },
    mailer: { send: jest.fn().mockResolvedValue(undefined) },
  };
  const [fn] = buildDeliveryZoneValidationFunctions({
    inngestClient,
    appBaseUrl: 'https://app.houndfe.test',
    ...deps,
  } as never);
  const run = (data: unknown = PAYLOAD) =>
    handler({
      event: {
        id: 'evt-1',
        name: DELIVERY_ZONE_VALIDATION_INNGEST_EVENT,
        data,
      },
      step: { run: (_name, work) => work() },
    });
  return { fn, options: () => options, run, ...deps };
}

const ENABLED = {
  enabled: true,
  recipients: ['manager-1', 'no-permission'],
  enabledActions: ['DELIVERY_ZONE_VALIDATION_REQUESTED'],
};

describe('buildDeliveryZoneValidationFunctions', () => {
  it('registers one idempotent function on the validation event', () => {
    const world = build(ENABLED);
    expect(world.fn).toEqual({
      id: DELIVERY_ZONE_VALIDATION_EMAIL_FUNCTION_ID,
    });
    expect(world.options()).toMatchObject({
      id: 'delivery-zone-validation-email',
      triggers: [{ event: 'delivery-zones/validation.requested' }],
      idempotency: 'event.id',
    });
  });

  it('emails only configured recipients that can validate zones, with the 24 h deadline', async () => {
    const world = build(ENABLED);
    await expect(world.run()).resolves.toEqual({ sent: true });
    expect(world.tenantRunner.runWithTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.any(Function),
    );
    expect(world.validatorLookup.filterValidators).toHaveBeenCalledWith([
      'manager-1',
      'no-permission',
    ]);
    expect(world.userEmailLookup.resolveEmailsByUserIds).toHaveBeenCalledWith([
      'manager-1',
    ]);
    const [message] = world.mailer.send.mock.calls[0] as [
      { to: string[]; subject: string; html: string },
    ];
    expect(message.to).toEqual(['manager-1@houndfe.test']);
    expect(message.subject).toBe('Validar zona de entrega: CP 06700');
    expect(message.html).toContain('24 horas');
    expect(message.html).toContain('Roma Norte');
  });

  it.each([
    ['master-disabled', { ...ENABLED, enabled: false }],
    ['action-disabled', { ...ENABLED, enabledActions: ['LOW_STOCK'] }],
    ['no-recipients', { ...ENABLED, recipients: [] }],
    ['no-validators', { ...ENABLED, recipients: ['no-permission'] }],
  ])('skips without sending when %s', async (reason, config) => {
    const world = build(config);
    await expect(world.run()).resolves.toEqual({ skipped: reason });
    expect(world.mailer.send).not.toHaveBeenCalled();
  });

  it('skips a payload without tenant', async () => {
    const world = build(ENABLED);
    await expect(world.run({})).resolves.toEqual({ skipped: 'missing-tenant' });
  });
});
