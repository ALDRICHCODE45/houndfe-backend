/**
 * Staff (POS) backorder use cases (contract v1 §9.1-§9.3): list with filters,
 * sort and per-status counts, detail, and cancel. The branch always comes from
 * the token (CLS, set by `TenantContextGuard`); nothing about the tenant is read
 * from the request.
 *
 * Cancel mirrors the customer cancel of the bot (`BackordersBotService.cancel`)
 * with three differences: the actor is the verified staff user, the `version`
 * the POS saw must still be current (`VERSION_CONFLICT`), and the bot is told
 * (`backorder.cancelled_by_staff`) in the same transaction.
 *
 * LOCK ORDER (L7): stock (`lockStock` of the product) → the backorder row → the
 * feed's advisory lock LAST (inside `enqueueBackorderCancelledByStaff`). The
 * allocator, the sweep, the bot checkout and the customer cancel take the same
 * order, so a staff cancel racing any of them waits instead of deadlocking.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BackorderError } from '../domain/backorder-error';
import { isRetryableTransactionError } from './backorder-retryable-error';
import {
  toStatusCounts,
  type BackorderStatusCounts,
  type StaffBackorderListFilter,
  type StaffCancelRequest,
} from '../domain/backorder-staff-query';
import { decideCancel } from '../domain/backorder-status';
import { enqueueBackorderCancelledByStaff } from '../infrastructure/backorder-feed-writes';
import { readWaitingPositions } from '../infrastructure/backorder-queue-positions';
import {
  staffListOrderBy,
  staffListWhere,
} from '../infrastructure/backorder-staff-list.query';
import {
  toBackorderStaff,
  type BackorderStaff,
} from '../presentation/dto/backorder-staff.response';
import {
  BACKORDER_RESERVATION_RELEASER,
  type BackorderReservationReleaser,
} from './ports/backorder-reservation-releaser.port';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

const STAFF_INCLUDE = {
  product: { select: { name: true } },
  variant: { select: { name: true } },
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneCountryCode: true,
      phone: true,
    },
  },
  tenant: { select: { name: true } },
  cancelledBy: { select: { id: true, name: true } },
  sale: { select: { status: true } },
} satisfies Prisma.BackorderInclude;

/** Shown in the stock journal when the acting user row cannot be read. */
const UNKNOWN_USER_NAME = 'Usuario';

export interface StaffBackorderPage {
  items: BackorderStaff[];
  page: number;
  limit: number;
  total: number;
  /** Per status, honouring every filter except `status`. */
  counts: BackorderStatusCounts;
}

@Injectable()
export class BackordersStaffService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly journal: StockJournalWriter,
    @Inject(BACKORDER_RESERVATION_RELEASER)
    private readonly releaser: BackorderReservationReleaser,
  ) {}

  async list(filter: StaffBackorderListFilter): Promise<StaffBackorderPage> {
    const tenantId = this.tenantPrisma.getTenantId();
    const tx = this.tenantPrisma.getClient();
    const pageWhere = staffListWhere(tenantId, filter, { withStatus: true });
    const countsWhere = staffListWhere(tenantId, filter, { withStatus: false });
    const [total, rows, groups] = await Promise.all([
      tx.backorder.count({ where: pageWhere }),
      tx.backorder.findMany({
        where: pageWhere,
        include: STAFF_INCLUDE,
        orderBy: staffListOrderBy(filter),
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
      tx.backorder.groupBy({
        by: ['status'],
        where: countsWhere,
        _count: { _all: true },
      }),
    ]);
    return {
      items: await this.project(tx, tenantId, rows),
      page: filter.page,
      limit: filter.limit,
      total,
      counts: toStatusCounts(
        groups.map((group) => ({
          status: group.status,
          count: group._count._all,
        })),
      ),
    };
  }

  async findById(id: string): Promise<BackorderStaff> {
    return this.readOne(this.tenantPrisma.getClient(), id);
  }

  /**
   * Staff cancel of a WAITING or RESERVED backorder. The status is checked
   * before the version: a backorder that is already terminal answers
   * `BACKORDER_NOT_CANCELLABLE {status}` whatever the version, so a POS showing
   * a stale row learns WHY it cannot cancel; `VERSION_CONFLICT` is for a
   * still-active backorder that changed meanwhile.
   */
  async cancel(
    id: string,
    request: StaffCancelRequest,
    actorUserId: string,
  ): Promise<BackorderStaff> {
    const tenantId = this.tenantPrisma.getTenantId();
    try {
      return await this.tenantPrisma.runInTransaction(async () => {
        const tx = this.tenantPrisma.getClient();
        // Stock BEFORE the backorder row (see the header). The status and the
        // version are re-read under the row lock below.
        const probe = await tx.backorder.findFirst({
          where: { id, tenantId },
          select: { productId: true, status: true },
        });
        if (!probe) throw new BackorderError('BACKORDER_NOT_FOUND');
        if (probe.status === 'WAITING' || probe.status === 'RESERVED') {
          await this.journal.lockStock([probe.productId]);
        }
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM backorders WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`,
        );
        if (locked.length === 0) {
          throw new BackorderError('BACKORDER_NOT_FOUND');
        }
        const row = await tx.backorder.findFirst({
          where: { id, tenantId },
          select: {
            id: true,
            status: true,
            version: true,
            productId: true,
            variantId: true,
            quantity: true,
          },
        });
        if (!row) throw new BackorderError('BACKORDER_NOT_FOUND');
        const decision = decideCancel(row.status);
        if (!decision.allowed) {
          throw new BackorderError('BACKORDER_NOT_CANCELLABLE', {
            status: decision.status,
          });
        }
        if (row.version !== request.version) {
          throw new BackorderError('VERSION_CONFLICT', {
            currentVersion: row.version,
          });
        }
        if (decision.releasesReservation) {
          const actor = await tx.user.findUnique({
            where: { id: actorUserId },
            select: { name: true },
          });
          // BACKORDER_RELEASE, and the next WAITING backorder is served with
          // the released units in this same transaction.
          await this.releaser.releaseReservation({
            tenantId,
            backorderId: row.id,
            productId: row.productId,
            variantId: row.variantId,
            quantity: row.quantity,
            actor: {
              id: actorUserId,
              displayName: actor?.name ?? UNKNOWN_USER_NAME,
            },
          });
        }
        await tx.backorder.update({
          where: { id: row.id, tenantId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledByKind: 'STAFF',
            cancelledByUserId: actorUserId,
            cancelReason: request.reason,
            version: { increment: 1 },
          },
        });
        // Reads the committed row (version already bumped: the exactly-once key).
        await enqueueBackorderCancelledByStaff(tx, tenantId, row.id);
        return this.readOne(tx, row.id);
      });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        throw new BackorderError('BACKORDER_RETRY_REQUIRED');
      }
      throw error;
    }
  }

  private async readOne(tx: TenantClient, id: string): Promise<BackorderStaff> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await tx.backorder.findFirst({
      where: { id, tenantId },
      include: STAFF_INCLUDE,
    });
    if (!row) throw new BackorderError('BACKORDER_NOT_FOUND');
    const [item] = await this.project(tx, tenantId, [row]);
    return item;
  }

  /** Rows → `BackorderStaff`: queue positions and images in one query each. */
  private async project(
    tx: TenantClient,
    tenantId: string,
    rows: Array<Prisma.BackorderGetPayload<{ include: typeof STAFF_INCLUDE }>>,
  ): Promise<BackorderStaff[]> {
    if (rows.length === 0) return [];
    const [positions, images] = await Promise.all([
      readWaitingPositions(tx, tenantId, rows),
      this.images(tx, tenantId, rows),
    ]);
    const now = new Date();
    return rows.map((row) =>
      toBackorderStaff(row, {
        queuePosition: positions.get(row.id) ?? null,
        productImageUrl: images(row),
        now,
      }),
    );
  }

  /**
   * The image of a backorder: the variant's own, else the product's main one
   * (same preference as the sale line image).
   */
  private async images(
    tx: TenantClient,
    tenantId: string,
    rows: ReadonlyArray<{ productId: string; variantId: string | null }>,
  ): Promise<
    (row: { productId: string; variantId: string | null }) => string | null
  > {
    const found = await tx.productImage.findMany({
      where: {
        tenantId,
        productId: { in: [...new Set(rows.map((row) => row.productId))] },
      },
      orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { productId: true, variantId: true, url: true },
    });
    return (row) =>
      (row.variantId
        ? found.find(
            (image) =>
              image.productId === row.productId &&
              image.variantId === row.variantId,
          )
        : undefined
      )?.url ??
      found.find(
        (image) =>
          image.productId === row.productId && image.variantId === null,
      )?.url ??
      null;
  }
}
