/**
 * Unit 14: the bot reschedule receipt is a receipt of its own kind
 * (`RESCHEDULE`, keyed by the raw `X-Idempotency-Key`), not a prefixed key of
 * kind `CREATE` (S20 10; the database CHECK of migration 20261114000000).
 */
import { randomUUID } from 'node:crypto';
import {
  SchedulingService,
  type RescheduleResult,
  type SchedulingStore,
} from './scheduling.service';
import type { BotIntakeStore } from './bot-request-intake.service';
import type { ChatbotRequestCommandStore } from './chatbot-request-commands.service';

const NOW = Date.now();
const FROM = new Date(NOW + 2 * 3_600_000);
const TO = new Date(NOW + 3 * 3_600_000);

function build() {
  const receipts = new Map<
    string,
    { commandHash: string; snapshot: unknown }
  >();
  const calls: Array<[string, string, string]> = [];
  const intake = {
    transaction: <T>(work: () => Promise<T>) => work(),
    lockKey: jest.fn((kind: string, key: string) => {
      calls.push(['lock', kind, key]);
      return Promise.resolve();
    }),
    findReceipt: jest.fn((kind: string, key: string) => {
      calls.push(['find', kind, key]);
      const found = receipts.get(`${kind}:${key}`);
      return Promise.resolve(
        found
          ? { commandHash: found.commandHash, responseSnapshot: found.snapshot }
          : null,
      );
    }),
    saveReceipt: jest.fn(
      (
        kind: string,
        key: string,
        commandHash: string,
        _requestId: string | null,
        snapshot: unknown,
      ) => {
        calls.push(['save', kind, key]);
        receipts.set(`${kind}:${key}`, { commandHash, snapshot });
        return Promise.resolve();
      },
    ),
  };
  const result = {
    outcome: 'RESCHEDULED',
    request: { id: randomUUID(), status: 'NEW' },
    scheduledFor: TO,
    previousScheduledFor: FROM,
    scheduleVersion: 2,
    requiresTemplateAtStart: false,
    windowClosesAt: new Date(NOW + 20 * 3_600_000),
    customerNoticeExpected: true,
  } as unknown as RescheduleResult;
  const store = { reschedule: jest.fn().mockResolvedValue(result) };
  const service = new SchedulingService(
    store as unknown as SchedulingStore,
    intake as unknown as BotIntakeStore,
    {} as ChatbotRequestCommandStore,
  );
  return { service, store, calls };
}

describe('SchedulingService.botReschedule receipts', () => {
  it('stores and looks the receipt up as kind RESCHEDULE under the raw idempotency key', async () => {
    const { service, calls } = build();
    const key = randomUUID();
    await service.botReschedule({
      credentialId: 'cred',
      idempotencyKey: key,
      requestId: randomUUID(),
      body: { scheduledFor: TO.toISOString() },
    });
    expect(calls).toEqual([
      ['lock', 'RESCHEDULE', key],
      ['find', 'RESCHEDULE', key],
      ['save', 'RESCHEDULE', key],
    ]);
  });

  it('replays the first answer for the same key and body, without touching the store again', async () => {
    const { service, store } = build();
    const input = {
      credentialId: 'cred',
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      body: { scheduledFor: TO.toISOString() },
    };
    const first = await service.botReschedule(input);
    const second = await service.botReschedule(input);
    expect(second).toEqual(first);
    expect(store.reschedule).toHaveBeenCalledTimes(1);
  });

  it('answers IDEMPOTENCY_CONFLICT for the same key with another body', async () => {
    const { service } = build();
    const base = {
      credentialId: 'cred',
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    };
    await service.botReschedule({
      ...base,
      body: { scheduledFor: TO.toISOString() },
    });
    await expect(
      service.botReschedule({
        ...base,
        body: { scheduledFor: FROM.toISOString() },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
