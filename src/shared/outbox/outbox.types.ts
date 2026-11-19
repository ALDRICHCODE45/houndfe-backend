import type { OutboxEvent, Prisma } from '@prisma/client';

export type OutboxPayload = Prisma.InputJsonValue;

export type DispatchableOutboxEvent = Pick<
  OutboxEvent,
  | 'id'
  | 'tenantId'
  | 'aggregateType'
  | 'aggregateId'
  | 'eventType'
  | 'payload'
  | 'status'
  | 'retryCount'
  | 'nextAttemptAt'
  | 'lastError'
  | 'lockToken'
  | 'lockedUntil'
  | 'createdAt'
  | 'publishedAt'
>;

/**
 * R3: outbox event types under this prefix belong to a dedicated poller (the
 * chatbot request notices). The generic poller excludes the prefix by pattern
 * instead of a hand-kept list, so a new dedicated type cannot be forgotten.
 * Kept literal here (shared must not import a feature module).
 */
export const RESERVED_OUTBOX_PREFIX = 'chatbot_request.';
