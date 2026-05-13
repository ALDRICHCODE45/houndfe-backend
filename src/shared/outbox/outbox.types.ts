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
