/**
 * Who can be assigned a chatbot request (§3.8, §3.10): an ACTIVE user with a
 * membership in the tenant whose roles grant `read` AND `update` on
 * `ChatbotRequest`. As in `CaslAbilityFactory` (and the notification
 * recipients), `manage` and subject `all` count, and grants merge across ALL
 * of a person's memberships in the tenant: `read` from one role and `update`
 * from another qualifies. Each grant is therefore its own condition over the
 * user's memberships, never one condition a single role must satisfy.
 *
 * One definition for `reassign`'s `USER_NOT_ASSIGNABLE` check and for
 * `GET /chatbot-requests/assignable-users`, so the picker can never offer a
 * person the command would refuse.
 */
import type { Prisma } from '@prisma/client';

const grants = (tenantId: string, action: string) => ({
  tenantMemberships: {
    some: {
      tenantId,
      role: {
        permissions: {
          some: {
            permission: {
              action: { in: [action, 'manage'] },
              subject: { in: ['ChatbotRequest', 'all'] },
            },
          },
        },
      },
    },
  },
});

export function assignableUserWhere(
  tenantId: string,
  userId?: string,
): Prisma.UserWhereInput {
  return {
    ...(userId ? { id: userId } : {}),
    isActive: true,
    AND: [grants(tenantId, 'read'), grants(tenantId, 'update')],
  };
}
