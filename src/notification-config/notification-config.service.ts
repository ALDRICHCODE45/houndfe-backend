/**
 * APPLICATION SERVICE: NotificationConfigService.
 *
 * Wraps `INotificationConfigRepository` (Slice B). Owns TWO policy checks
 * that the port deliberately does NOT enforce (mirrors `SatCatalogService`'s
 * `assertExists` pattern):
 *
 *   1. **Action-key policy (defense in depth).** Re-validates `enabledActions`
 *      against the locked v1 set (`NOTIFICATION_ACTION_KEYS` = `LOW_STOCK`)
 *      and throws `BadRequestException({ error: 'UNKNOWN_ACTION_KEY' })`
 *      BEFORE delegating to `port.replace`. The adapter also rejects, but the
 *      service owns the policy: HTTP 400 mapping lives here, and the adapter
 *      can stay a pure persistence concern.
 *
 *   2. **Recipient tenant-membership (CRITICAL — carried from Slice B
 *      review-risk WARNING 1).** `User` is a GLOBAL identity model and the
 *      `NotificationRecipient.userId` FK only enforces global existence, so
 *      without this check a tenant admin could register another tenant's
 *      `userId` as a notification recipient — cross-tenant targeting once
 *      emails fire in a later slice. We query `tenant_memberships` for the
 *      CURRENT tenant (read from CLS via `TenantPrismaService.getTenantId()`)
 *      and diff against the input set; any missing id ⇒
 *      `BadRequestException({ error: 'INVALID_RECIPIENT', message })`.
 *
 *      `TenantMembership` is NOT in `TENANT_SCOPED_MODELS` (it is the
 *      join table itself — explicit `tenantId` predicate is required and
 *      matches the `admin-user.service.ts:73-75` idiom). One query, atomic:
 *      the intersection of "global user exists" AND "member of tenant X" is
 *      exactly the membership row.
 *
 * Empty recipient list short-circuits the membership query (no users ⇒ no
 * DB call — the master-OFF-with-no-recipients scenario in spec scenario
 * "Empty recipients, master ON, action ON → no send" still writes the
 * config correctly).
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import {
  NOTIFICATION_ACTION_KEYS,
  type NotificationActionKey,
  type NotificationConfigView,
} from './domain/notification-config';
import {
  INotificationConfigRepository,
  NOTIFICATION_CONFIG_REPOSITORY,
} from './domain/notification-config.repository';

export interface UpdateNotificationConfigInput {
  enabled: boolean;
  recipientUserIds: string[];
  enabledActions: NotificationActionKey[];
}

@Injectable()
export class NotificationConfigService {
  constructor(
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly repo: INotificationConfigRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  /**
   * Read the calling tenant's notification config. Returns the safe empty
   * defaults (`{ enabled: false, recipients: [], enabledActions: [] }`) when
   * the tenant has no `NotificationSettings` row.
   */
  read(): Promise<NotificationConfigView> {
    return this.repo.find();
  }

  /**
   * Overwrite the calling tenant's notification config. Validates action
   * keys and recipient tenant-membership BEFORE delegating to the port —
   * both gates throw `BadRequestException` and ensure no rows are written
   * (spec scenarios "Unknown action key rejected" / "Full overwrite succeeds").
   */
  async replace(
    input: UpdateNotificationConfigInput,
  ): Promise<NotificationConfigView> {
    // (1) Action-key policy (cheaper, fail-fast).
    for (const key of input.enabledActions) {
      if (!NOTIFICATION_ACTION_KEYS.includes(key)) {
        throw new BadRequestException({
          error: 'UNKNOWN_ACTION_KEY',
          message: `Unknown action key: "${key}". Recognized v1 keys: ${NOTIFICATION_ACTION_KEYS.join(', ')}.`,
        });
      }
    }

    // (2) Recipient tenant-membership (cross-tenant targeting defense).
    // Empty list short-circuits — nothing to validate.
    if (input.recipientUserIds.length > 0) {
      const tenantId = this.tenantPrisma.getTenantId();
      const prisma = this.tenantPrisma.getClient();
      const rows = await prisma.tenantMembership.findMany({
        where: {
          userId: { in: input.recipientUserIds },
          tenantId,
        },
        select: { userId: true },
      });

      const memberSet = new Set(rows.map((r) => r.userId));
      const foreign = input.recipientUserIds.filter(
        (id) => !memberSet.has(id),
      );

      if (foreign.length > 0) {
        throw new BadRequestException({
          error: 'INVALID_RECIPIENT',
          message: `Recipient(s) are not members of the current tenant: ${foreign.join(', ')}.`,
        });
      }
    }

    return this.repo.replace(input);
  }
}