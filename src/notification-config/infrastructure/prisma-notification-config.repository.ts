/**
 * ADAPTER: PrismaNotificationConfigRepository.
 *
 * Concrete implementation of `INotificationConfigRepository` over the
 * tenant-scoped Prisma client (`TenantPrismaService.getClient()`). All
 * four notification/stock-alert models are registered in
 * `TENANT_SCOPED_MODELS` (A.1) so the client extension auto-injects
 * `tenantId` — this adapter MUST NOT pass `where.tenantId` manually.
 *
 * Writes are atomic via `prisma.$transaction`. Unknown action keys are
 * rejected with `BadRequestException({ error: 'UNKNOWN_ACTION_KEY' })`
 * BEFORE the tx starts (spec: "no rows are written").
 *
 * Mirrors `src/products/infrastructure/prisma-product.repository.ts`.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  NOTIFICATION_ACTION_KEYS,
  type NotificationActionKey,
  type NotificationConfigView,
} from '../domain/notification-config';
import type { INotificationConfigRepository } from '../domain/notification-config.repository';

const EMPTY_VIEW: NotificationConfigView = Object.freeze({
  enabled: false,
  recipients: [],
  enabledActions: [],
}) as NotificationConfigView;

@Injectable()
export class PrismaNotificationConfigRepository implements INotificationConfigRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async find(): Promise<NotificationConfigView> {
    const prisma = this.tenantPrisma.getClient();

    const settings = await prisma.notificationSettings.findFirst({
      select: { enabled: true },
    });

    if (!settings) {
      // Spec "Unconfigured tenant returns safe defaults" — no row ⇒ empty view.
      return { ...EMPTY_VIEW };
    }

    const [recipients, actions] = await Promise.all([
      prisma.notificationRecipient.findMany({
        select: { userId: true },
        orderBy: { userId: 'asc' },
      }),
      prisma.notificationAction.findMany({
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
    ]);

    return {
      enabled: settings.enabled,
      recipients: recipients.map((r) => r.userId),
      enabledActions: actions.map((a) => a.action),
    };
  }

  async replace(input: {
    enabled: boolean;
    recipientUserIds: string[];
    enabledActions: NotificationActionKey[];
  }): Promise<NotificationConfigView> {
    // Validation MUST run before the transaction — spec: "no rows are
    // written" when the action key set is invalid.
    for (const key of input.enabledActions) {
      if (!NOTIFICATION_ACTION_KEYS.includes(key)) {
        throw new BadRequestException({
          error: 'UNKNOWN_ACTION_KEY',
          message: `Unknown action key: "${key}". Recognized v1 keys: ${NOTIFICATION_ACTION_KEYS.join(', ')}.`,
        });
      }
    }

    const prisma = this.tenantPrisma.getClient();

    // The client extension merges `tenantId` from CLS into every
    // operation below — we type `create` payloads as the Unchecked
    // variant (no manual `tenantId`) and let the extension inject.
    await prisma.$transaction(async (tx) => {
      await tx.notificationSettings.upsert({
        // `tenantId` is the unique key — placeholder is overridden by
        // the extension with the real CLS tenantId.
        where: { tenantId: '__CLS_RESOLVES__' },
        create: {
          enabled: input.enabled,
        } as Prisma.NotificationSettingsUncheckedCreateInput,
        update: { enabled: input.enabled },
      });

      await tx.notificationRecipient.deleteMany({});
      await tx.notificationRecipient.createMany({
        data: input.recipientUserIds.map((userId) => ({
          userId,
        })) as Prisma.NotificationRecipientCreateManyInput[],
        skipDuplicates: true,
      });

      await tx.notificationAction.deleteMany({});
      await tx.notificationAction.createMany({
        data: input.enabledActions.map((action) => ({
          action,
        })) as Prisma.NotificationActionCreateManyInput[],
        skipDuplicates: true,
      });
    });

    return this.find();
  }
}
