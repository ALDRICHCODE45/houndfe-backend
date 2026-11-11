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
  'tenantMembership' | 'notificationPreference'
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

/** Distinct user ids to notify, excluding the actor of the event. */
export async function resolveRecipientIds(
  tx: RecipientClient,
  tenantId: string,
  notice: ChatbotRequestNotice,
): Promise<string[]> {
  const audience = audienceOf(notice.type);
  const memberships = await tx.tenantMembership.findMany({
    where: {
      tenantId,
      user: { isActive: true },
      ...(audience === 'USER'
        ? { userId: notice.recipientUserId ?? '' }
        : {
            // A user may hold several memberships; each grant may come from
            // any of them.
            AND: AUDIENCE_GRANTS[audience].map(([action, subject]) =>
              roleGrants(action, subject),
            ),
          }),
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return memberships
    .map((membership) => membership.userId)
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
