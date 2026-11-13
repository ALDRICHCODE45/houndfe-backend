/**
 * Chatbot attention settings (human-intervention unit 7a; contract §5.5, §12.9,
 * S7). One row per tenant; no row means the defaults at version 0.
 *
 * Every statement carries an explicit `tenantId` and runs on the root
 * `PrismaService`: apply-to-all must write other tenants, which the
 * tenant-scoped client would refuse, and the same rule keeps the single-tenant
 * paths obviously scoped.
 *
 *   get            settings + read-only `branchOpeningHours` (§12.9) +
 *                  `updatedBy`/`updatedAt` from the settings audit (S11).
 *   put            CAS on `version` (`expectedVersion`): exactly one of several
 *                  concurrent writers wins, the rest get 409 VERSION_CONFLICT
 *                  with the current settings. Identical content is a no-op (no
 *                  version bump, no recompute). The winner then recomputes the
 *                  OPEN requests of the tenant in bounded batches (§5.4). The
 *                  recompute runs after the commit and can never undo or hide
 *                  it: if it fails the write still answers 200 with
 *                  `recompute: 'FAILED'` (and an error log), never 500.
 *                  The same pass flags open scheduled requests whose time is
 *                  no longer open (`needsReschedule`, unit 14, S19 Q6).
 *   applyToAll     S7: copies hours, closed dates, SLA times (and the receipt
 *                  margin, window warning) and scheduling settings to every
 *                  tenant where the caller holds
 *                  `update:ChatbotSettingsAllBranches` through a membership,
 *                  decided by the CASL ability of the caller in that tenant
 *                  (the factory `PermissionsGuard` uses). A stale
 *                  `expectedVersion` is 409 and carries `current` only if
 *                  the caller also has `read:ChatbotSettings` there.
 *                  Other tenants are never touched, listed or counted.
 *                  Each tenant has its own transaction and audit event and
 *                  appears in exactly ONE result list: `tenantsFailed` only
 *                  when its settings write failed; a write that committed
 *                  but whose recompute failed is in `tenantsApplied` with
 *                  `recompute: 'FAILED'`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { actorDisplayName } from '../../chatbot-requests/domain/actor-display-name';
import {
  readSettingsRow,
  rowToSettings,
} from '../../chatbot-requests/infrastructure/chatbot-sla-policy';
import { recomputeOpenRequests } from '../../chatbot-requests/infrastructure/chatbot-sla-recompute';
import { flagUnbookableSchedules } from '../../chatbot-requests/infrastructure/scheduled-reschedule-flag';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { OpeningDay } from '../../shipping/pickup/domain/opening-hours';
import {
  defaultSettings,
  normalizeSettingsInput,
  settingsEqual,
  type AttentionSettings,
  type AttentionSettingsInput,
} from '../domain/chatbot-attention-settings';

export const SETTINGS_CLOCK = Symbol('CHATBOT_SETTINGS_CLOCK');

/**
 * Who saved the settings and when (S11). `null` both while the tenant is on
 * the defaults (no row). The name is the copy stored in the audit event, so it
 * survives the deletion of the user, like every other audit name.
 */
export interface SettingsAuthor {
  updatedBy: { id: string; displayName: string } | null;
  /** ISO instant of the last committed write. */
  updatedAt: string | null;
}

export interface SettingsView extends AttentionSettings, SettingsAuthor {
  version: number;
}

/** What `GET` returns (§5.5, §12.9). */
export interface SettingsResponse extends SettingsView {
  branchOpeningHours: { timeZone: string; days: OpeningDay[] } | null;
}

/**
 * What happened to the open requests after a committed write.
 *   DONE        every open request is on the new version.
 *   PARTIAL     some rows are still on an older version (a command held them,
 *               or they were created concurrently); they are stamped by the
 *               next command that touches them.
 *   FAILED      the recompute threw; the settings ARE saved, open requests
 *               keep their old deadlines.
 *   NOT_NEEDED  nothing was written (identical content).
 */
export type RecomputeStatus = 'DONE' | 'PARTIAL' | 'FAILED' | 'NOT_NEEDED';

/** What `PUT` returns: the saved settings plus the recompute outcome. */
export interface PutResponse extends SettingsResponse {
  recompute: RecomputeStatus;
}

/**
 * `current` is absent when the caller may not read the settings of the tenant
 * (apply-to-all needs only `update:ChatbotSettingsAllBranches`; a GET needs
 * `read:ChatbotSettings`, so the 409 must not be a way around it).
 */
export class SettingsVersionConflictError extends Error {
  constructor(readonly current?: SettingsResponse) {
    super('chatbot settings version conflict');
    this.name = 'SettingsVersionConflictError';
  }
}

export interface ApplyToAllResult {
  dryRun: boolean;
  source: { tenantId: string; version: number };
  /** `recompute` is absent on a dry run (nothing was written). */
  tenantsApplied: Array<
    TenantRef & { recompute?: Exclude<RecomputeStatus, 'NOT_NEEDED'> }
  >;
  tenantsUnchanged: TenantRef[];
  tenantsSkipped: Array<
    TenantRef & { reason: 'NO_PERMISSION' | 'TENANT_INACTIVE' }
  >;
  tenantsFailed: TenantRef[];
}

export interface TenantRef {
  tenantId: string;
  name: string;
}

/** Fields copied by apply-to-all (§5.5: hours, closed dates, times, scheduling). */
const COPIED = [
  'openingHours',
  'closedDates',
  'closedDateReasons',
  'slas',
  'windowWarningMinutes',
  'receiptCloseMarginMinutes',
  'scheduling',
] as const satisfies ReadonlyArray<keyof AttentionSettings>;

const KEYS = Object.keys(defaultSettings()) as Array<keyof AttentionSettings>;

const sameField = (
  a: AttentionSettings,
  b: AttentionSettings,
  key: keyof AttentionSettings,
): boolean =>
  JSON.stringify(key === 'enabledSubtypes' ? [...a[key]].sort() : a[key]) ===
  JSON.stringify(key === 'enabledSubtypes' ? [...b[key]].sort() : b[key]);

const changedFields = (
  before: AttentionSettings,
  after: AttentionSettings,
): string[] => KEYS.filter((key) => !sameField(before, after, key));

const toColumns = (s: AttentionSettings) => ({
  timeZone: s.openingHours.timeZone,
  // SAFETY: the normalized week and SLA table are plain JSON values.
  days: s.openingHours.days as unknown as Prisma.InputJsonValue,
  closedDates: s.closedDates,
  // SAFETY: a plain object of strings.
  closedDateReasons: s.closedDateReasons as Prisma.InputJsonObject,
  // SAFETY: the SLA table is an array of plain objects (strings, numbers, null).
  slas: s.slas as unknown as Prisma.InputJsonValue,
  windowWarningMinutes: s.windowWarningMinutes,
  templateName: s.templateName,
  templateCostText: s.templateCostText,
  enabledSubtypes: s.enabledSubtypes,
  receiptCloseMarginMinutes: s.receiptCloseMarginMinutes,
  startTimeoutSeconds: s.startTimeoutSeconds,
  templateLanguageCode: s.templateLanguageCode,
  schedulingEnabled: s.scheduling.enabled,
  slotMinutes: s.scheduling.slotMinutes,
  slotsOffered: s.scheduling.slotsOffered,
  maxScheduledPerSlot: s.scheduling.maxScheduledPerSlot,
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

@Injectable()
export class ChatbotSettingsService {
  private readonly logger = new Logger(ChatbotSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly abilities: CaslAbilityFactory,
    @Inject(SETTINGS_CLOCK) private readonly clock: () => Date,
  ) {}

  async get(tenantId: string): Promise<SettingsResponse> {
    const [row, branch] = await Promise.all([
      readSettingsRow(this.prisma, tenantId),
      this.prisma.tenantOpeningHours.findFirst({ where: { tenantId } }),
    ]);
    return this.toResponse(
      row,
      branch,
      await this.authorOf(this.prisma, tenantId, row),
    );
  }

  /** Same as `get`, on the connection of a transaction that is already open. */
  private async getIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<SettingsResponse> {
    const row = await readSettingsRow(tx, tenantId);
    const branch = await tx.tenantOpeningHours.findFirst({
      where: { tenantId },
    });
    return this.toResponse(row, branch, await this.authorOf(tx, tenantId, row));
  }

  /**
   * The audit event of exactly the version in the row: every committed write
   * creates one in the same transaction (a no-op write creates none and does
   * not move the version), so it is the last writer and the commit instant,
   * never a mismatch under a concurrent write. One lookup inside the tenant's
   * index `(tenantId, createdAt DESC)`; no row (defaults) is `null`/`null`.
   */
  private async authorOf(
    db: Pick<Prisma.TransactionClient, 'chatbotAttentionSettingsEvent'>,
    tenantId: string,
    row: { version: number } | null,
  ): Promise<SettingsAuthor> {
    if (!row) return { updatedBy: null, updatedAt: null };
    const event = await db.chatbotAttentionSettingsEvent.findFirst({
      where: { tenantId, toVersion: row.version },
      orderBy: { createdAt: 'desc' },
      select: { actorUserId: true, actorDisplayName: true, createdAt: true },
    });
    if (!event) return { updatedBy: null, updatedAt: null };
    return {
      updatedBy: event.actorUserId
        ? {
            id: event.actorUserId,
            displayName:
              event.actorDisplayName ??
              actorDisplayName({ name: '', email: '' }),
          }
        : null,
      updatedAt: event.createdAt.toISOString(),
    };
  }

  private toResponse(
    row: Awaited<ReturnType<typeof readSettingsRow>>,
    branch: { timeZone: string; days: Prisma.JsonValue } | null,
    author: SettingsAuthor,
  ): SettingsResponse {
    const view: SettingsView = row
      ? { ...rowToSettings(row), version: row.version, ...author }
      : { ...defaultSettings(), version: 0, ...author };
    return {
      ...view,
      branchOpeningHours: branch
        ? {
            timeZone: branch.timeZone,
            // SAFETY: rows are only written by the pickup service, normalized.
            days: branch.days as unknown as OpeningDay[],
          }
        : null,
    };
  }

  async put(
    tenantId: string,
    actorUserId: string,
    expectedVersion: number,
    input: AttentionSettingsInput,
  ): Promise<PutResponse> {
    // Validates the whole body once, outside the transaction (an additive
    // field that is absent counts as its default only for this check).
    const validated = normalizeSettingsInput(input);
    const actor = await this.actorName(actorUserId);
    let changed: boolean;
    try {
      changed = await this.prisma.$transaction(async (tx) => {
        const row = await readSettingsRow(tx, tenantId, 'UPDATE');
        const current = row?.version ?? 0;
        if (current !== expectedVersion) {
          throw new SettingsVersionConflictError(
            await this.getIn(tx, tenantId),
          );
        }
        const before = row ? rowToSettings(row) : defaultSettings();
        // S16: a client that does not know the additive fields must not reset
        // them; absent (or null) keeps what is stored.
        const next =
          input.startTimeoutSeconds == null ||
          input.templateLanguageCode == null
            ? normalizeSettingsInput({
                ...input,
                startTimeoutSeconds:
                  input.startTimeoutSeconds ?? before.startTimeoutSeconds,
                templateLanguageCode:
                  input.templateLanguageCode ?? before.templateLanguageCode,
              })
            : validated;
        if (row && settingsEqual(before, next)) return false;
        if (row) {
          await tx.chatbotAttentionSettings.update({
            where: { tenantId },
            data: {
              ...toColumns(next),
              version: current + 1,
              updatedById: actorUserId,
            },
          });
        } else {
          await tx.chatbotAttentionSettings.create({
            data: {
              ...toColumns(next),
              tenantId,
              version: 1,
              updatedById: actorUserId,
            },
          });
        }
        await tx.chatbotAttentionSettingsEvent.create({
          data: {
            tenantId,
            type: 'UPDATED',
            actorUserId,
            actorDisplayName: actor,
            fromVersion: current,
            toVersion: current + 1,
            data: { changed: changedFields(before, next) },
          },
        });
        return true;
      });
    } catch (error) {
      // Two first writers raced on the missing row: the loser lost the CAS.
      if (isUniqueViolation(error)) {
        throw new SettingsVersionConflictError(await this.get(tenantId));
      }
      throw error;
    }
    // The write is committed: whatever the recompute does, the client gets
    // the saved settings (never a 500 for a write that is already durable).
    const recompute = changed
      ? await this.recomputeAfterCommit(tenantId)
      : 'NOT_NEEDED';
    return { ...(await this.get(tenantId)), recompute };
  }

  async applyToAll(
    tenantId: string,
    actorUserId: string,
    options: { dryRun: boolean; expectedVersion?: number },
  ): Promise<ApplyToAllResult> {
    const sourceRow = await readSettingsRow(this.prisma, tenantId);
    const source = sourceRow ? rowToSettings(sourceRow) : defaultSettings();
    const sourceVersion = sourceRow?.version ?? 0;
    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== sourceVersion
    ) {
      // `current` is what GET returns: only for a caller who may GET it.
      const mayRead = (await this.abilityIn(actorUserId, tenantId)).can(
        'read',
        'ChatbotSettings',
      );
      throw new SettingsVersionConflictError(
        mayRead ? await this.get(tenantId) : undefined,
      );
    }

    const result: ApplyToAllResult = {
      dryRun: options.dryRun,
      source: { tenantId, version: sourceVersion },
      tenantsApplied: [],
      tenantsUnchanged: [],
      tenantsSkipped: [],
      tenantsFailed: [],
    };
    const actor = await this.actorName(actorUserId);
    for (const target of await this.memberTenants(actorUserId)) {
      const ref = { tenantId: target.id, name: target.name };
      if (!target.isActive) {
        result.tenantsSkipped.push({ ...ref, reason: 'TENANT_INACTIVE' });
        continue;
      }
      // The ability PermissionsGuard builds for the caller in that tenant.
      const ability = await this.abilityIn(actorUserId, target.id);
      if (!ability.can('update', 'ChatbotSettingsAllBranches')) {
        result.tenantsSkipped.push({ ...ref, reason: 'NO_PERMISSION' });
        continue;
      }
      if (target.id === tenantId) {
        result.tenantsUnchanged.push(ref);
        continue;
      }
      try {
        const outcome = options.dryRun
          ? await this.wouldChange(target.id, source)
          : await this.applyTo(target.id, source, tenantId, actorUserId, actor);
        if (!outcome) {
          result.tenantsUnchanged.push(ref);
        } else if (options.dryRun) {
          result.tenantsApplied.push(ref);
        } else {
          // The settings are committed: this tenant is `applied` whatever
          // the recompute does, and is never also `failed`.
          result.tenantsApplied.push({
            ...ref,
            recompute: await this.recomputeAfterCommit(target.id),
          });
        }
      } catch (error) {
        this.logger.error(
          `[apply-to-all] tenant ${target.id} failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
        result.tenantsFailed.push(ref);
      }
    }
    return result;
  }

  /**
   * Tenants where the caller has a membership (one entry per tenant even with
   * several memberships), sorted by id. The write authority in each is decided
   * by `abilityIn`, never here.
   */
  private async memberTenants(userId: string) {
    const memberships = await this.prisma.tenantMembership.findMany({
      where: { userId },
      distinct: ['tenantId'],
      select: {
        tenant: { select: { id: true, name: true, isActive: true } },
      },
    });
    return memberships
      .map((m) => m.tenant)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The CASL ability of the caller inside one tenant, from the same factory
   * and context `PermissionsGuard` uses (grants merge across the caller's
   * memberships there). One query per call; apply-to-all calls it once per
   * ACTIVE tenant the caller is a member of, so it is bounded by memberships.
   */
  private abilityIn(userId: string, tenantId: string) {
    return this.abilities.createForUser(userId, {
      tenantId,
      isSuperAdmin: false,
    });
  }

  /** The target after a copy; the fields that are not copied stay as they are. */
  private merged(
    current: AttentionSettings,
    source: AttentionSettings,
  ): AttentionSettings {
    const next = { ...current } as Record<string, unknown>;
    for (const key of COPIED) next[key] = structuredClone(source[key]);
    // SAFETY: `next` is a copy of `current` with only COPIED keys replaced by
    // the same-typed values of `source`.
    return next as unknown as AttentionSettings;
  }

  private async wouldChange(
    targetId: string,
    source: AttentionSettings,
  ): Promise<boolean> {
    const row = await readSettingsRow(this.prisma, targetId);
    const current = row ? rowToSettings(row) : defaultSettings();
    return !row || !settingsEqual(current, this.merged(current, source));
  }

  /** `true` when the target changed. One retry if a first writer raced us. */
  private async applyTo(
    targetId: string,
    source: AttentionSettings,
    sourceTenantId: string,
    actorUserId: string,
    actor: string,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const row = await readSettingsRow(tx, targetId, 'UPDATE');
          const before = row ? rowToSettings(row) : defaultSettings();
          const next = this.merged(before, source);
          if (row && settingsEqual(before, next)) return false;
          const from = row?.version ?? 0;
          const data = {
            ...toColumns(next),
            version: from + 1,
            updatedById: actorUserId,
          };
          if (row) {
            await tx.chatbotAttentionSettings.update({
              where: { tenantId: targetId },
              data,
            });
          } else {
            await tx.chatbotAttentionSettings.create({
              data: { ...data, tenantId: targetId },
            });
          }
          await tx.chatbotAttentionSettingsEvent.create({
            data: {
              tenantId: targetId,
              type: 'APPLIED_TO_ALL',
              actorUserId,
              actorDisplayName: actor,
              fromVersion: from,
              toVersion: from + 1,
              data: {
                sourceTenantId,
                changed: changedFields(before, next),
              },
            },
          });
          return true;
        });
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  /** Never throws: the caller has already committed the settings. */
  private async recomputeAfterCommit(
    tenantId: string,
  ): Promise<Exclude<RecomputeStatus, 'NOT_NEEDED'>> {
    // Unit 14 (S19 Q6): open scheduled requests whose time is no longer open
    // get `needsReschedule`. Its own try: a failure never hides the recompute
    // and never fails the write; the schedule sweep flags the row anyway when
    // its reminder falls due.
    try {
      await flagUnbookableSchedules(this.prisma, tenantId, {
        now: this.clock,
      });
    } catch (error) {
      this.logger.error(
        `[settings] tenant ${tenantId}: settings saved but flagging scheduled requests failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    try {
      const { stale } = await recomputeOpenRequests(this.prisma, tenantId, {
        now: this.clock,
      });
      return stale > 0 ? 'PARTIAL' : 'DONE';
    } catch (error) {
      this.logger.error(
        `[settings] tenant ${tenantId}: settings saved but the recompute of open requests failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return 'FAILED';
    }
  }

  private async actorName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return user
      ? actorDisplayName(user)
      : actorDisplayName({ name: '', email: '' });
  }
}
