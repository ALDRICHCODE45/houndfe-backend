/**
 * Who receives a notice (contract §5.1): derived from permissions, never from
 * `NotificationSettings` (R8). Only ACTIVE users with a membership in the
 * notice's tenant qualify, so an inactive user and a person of another tenant
 * are never notified. As in `CaslAbilityFactory`, a `manage` action and the
 * `all` subject count as grants.
 */
import type { Prisma } from '@prisma/client';
import {
  AUDIENCE_GRANTS,
  audienceOf,
  type ChatbotRequestNotice,
} from '../domain/chatbot-request-notice';

type RecipientClient = Pick<
  Prisma.TransactionClient,
  'tenantMembership' | 'notificationPreference' | 'user'
>;

const roleGrants = (action: string, subject: string) => ({
  role: {
    permissions: {
      some: {
        permission: {
          action: { in: [action, 'manage'] },
          subject: { in: [subject, 'all'] },
        },
      },
    },
  },
});

/**
 * Distinct user ids to notify, excluding the actor of the event.
 *
 * Grants are merged across ALL of a person's memberships in the tenant, as
 * `CaslAbilityFactory` does (it flattens every membership's role): someone
 * with `read` from one role and `update` from another qualifies. So each
 * grant is its own condition over the user's memberships, not one condition
 * that a single role must satisfy.
 */
export async function resolveRecipientIds(
  tx: RecipientClient,
  tenantId: string,
  notice: ChatbotRequestNotice,
): Promise<string[]> {
  const audience = audienceOf(notice.type);
  if (audience === 'USER') {
    const membership = await tx.tenantMembership.findFirst({
      where: {
        tenantId,
        userId: notice.recipientUserId ?? '',
        user: { isActive: true },
      },
      select: { userId: true },
    });
    return membership && membership.userId !== notice.actorUserId
      ? [membership.userId]
      : [];
  }
  const users = await tx.user.findMany({
    where: {
      isActive: true,
      AND: AUDIENCE_GRANTS[audience].map(([action, subject]) => ({
        tenantMemberships: {
          some: { tenantId, ...roleGrants(action, subject) },
        },
      })),
    },
    select: { id: true },
  });
  return users
    .map((user) => user.id)
    .filter((userId) => userId !== notice.actorUserId);
}

/** Users that turned email off. No row means the default: email on. */
export async function emailDisabledAmong(
  tx: RecipientClient,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx.notificationPreference.findMany({
    where: { userId: { in: userIds }, emailEnabled: false },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}
