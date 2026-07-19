import { Inject, Injectable, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { IEmployeeRepository } from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { CreateTimeOffDto } from '../dto/create-time-off.dto';
import { ReviewTimeOffDto } from '../dto/review-time-off.dto';
import { ListTimeOffQueryDto } from '../dto/list-time-off.query.dto';
import { buildDisplayName } from './employee-display-name';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { TimeOffNotFoundError } from '../domain/errors/time-off-not-found.error';
import { TimeOffInvalidTransitionError } from '../domain/errors/time-off-invalid-transition.error';
import { TimeOffInvalidDateRangeError } from '../domain/errors/time-off-invalid-date-range.error';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  NOTIFICATION_CONFIG_REPOSITORY,
  type INotificationConfigRepository,
} from '../../notification-config/domain/notification-config.repository';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import type { OutboxPayload } from '../../shared/outbox/outbox.types';

interface TimeOffRequestedPayload {
  tenantId: string;
  timeOffId: string;
  employeeId: string;
  type: string;
  startDate: string;
  endDate: string;
  employeeName: string;
  requestedByUserId: string | null;
}

@Injectable()
export class EmployeeTimeOffService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
    @Optional() private readonly cls?: ClsService<TenantClsStore>,
    @Optional() private readonly caslAbilityFactory?: CaslAbilityFactory,
    @Optional()
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo?: INotificationConfigRepository,
    @Optional() private readonly outboxWriter?: OutboxWriterService,
  ) {}

  /**
   * Build the CASL ability for the current request from CLS context.
   * Returns undefined if dependencies are not wired (e.g. unit tests with
   * direct instantiation).
   */
  private async getCurrentAbility(): Promise<AppAbility | undefined> {
    if (!this.cls || !this.caslAbilityFactory) return undefined;
    const store = this.cls.get();
    if (!store?.userId) return undefined;
    return this.caslAbilityFactory.createForUser(store.userId, {
      tenantId: store.tenantId ?? null,
      isSuperAdmin: store.isSuperAdmin ?? false,
    });
  }

  async request(
    employeeId: string,
    dto: CreateTimeOffDto,
    requestedByUserId?: string,
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (endDate < startDate) {
      throw new TimeOffInvalidDateRangeError(dto.startDate, dto.endDate);
    }

    // Slice 4 — Atomic write-time gate (Design D1).
    //
    // The request row is ALWAYS persisted. The outbox row is published
    // ONLY when the master toggle is ON AND TIME_OFF_REQUESTED is in
    // `enabledActions`. Both writes commit or roll back together so
    // we never leave an orphan outbox row (gate-closed ⇒ row persists,
    // no outbox; gate-open ⇒ both persist or both roll back).
    //
    // The self-contained payload (Design D3) carries the fields the
    // HR dispatcher + Inngest fn need — no re-reads required. The
    // idempotency seed `${tenantId}:${timeOffId}` is encoded via
    // `aggregateId = timeOffId` and re-asserted by the dispatcher at
    // send time (Slice 5).
    return this.tenantPrisma.runInTransaction(async () => {
      const prisma = this.tenantPrisma.getClient();
      const tenantId = this.tenantPrisma.getTenantId();

      const created = await prisma.employeeTimeOff.create({
        data: {
          employeeId,
          type: dto.type,
          startDate,
          endDate,
          reason: dto.reason ?? null,
          status: 'PENDING',
          requestedByUserId: requestedByUserId ?? null,
          tenantId,
        },
      });

      // Outbox gate — read tenant-scoped config inside the same tx so
      // the read sees the same snapshot the row write did. Tests stub
      // `notificationConfigRepo.find`; production injects the
      // `PrismaNotificationConfigRepository` (registered by
      // NotificationConfigModule at :44).
      if (this.notificationConfigRepo && this.outboxWriter) {
        const config = await this.notificationConfigRepo.find();
        const gatesOpen =
          config.enabled &&
          config.enabledActions.includes('TIME_OFF_REQUESTED');

        if (gatesOpen) {
          const employeeName = buildDisplayName(
            employee.firstName,
            employee.lastName,
          );

          const payload: TimeOffRequestedPayload = {
            tenantId,
            timeOffId: created.id,
            employeeId: created.employeeId,
            type: created.type,
            startDate: new Date(created.startDate).toISOString(),
            endDate: new Date(created.endDate).toISOString(),
            employeeName,
            requestedByUserId: created.requestedByUserId ?? null,
          };

          // OutboxWriterService.publish expects a Prisma tx client or
          // a stand-in with the same shape. The tenant-scoped client
          // returned by `tenantPrisma.getClient()` IS that client when
          // we're inside `runInTransaction` (it forwards to the
          // ambient tx). Cast through `unknown` matches the
          // established low-stock pattern at
          // `prisma-product.repository.ts:394`.
          await this.outboxWriter.publish(
            prisma as unknown as Parameters<OutboxWriterService['publish']>[0],
            tenantId,
            'EmployeeTimeOff',
            created.id,
            'hr.timeoff.requested',
            payload as unknown as OutboxPayload,
          );
        }
      }

      return created;
    });
  }

  async review(
    employeeId: string,
    timeOffId: string,
    dto: ReviewTimeOffDto,
    reviewerUserId: string,
  ) {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.employeeTimeOff.findFirst({
      where: { id: timeOffId, employeeId },
    });

    if (!row) throw new TimeOffNotFoundError(timeOffId);

    if (row.status !== 'PENDING') {
      throw new TimeOffInvalidTransitionError(row.status, dto.decision);
    }

    return prisma.employeeTimeOff.update({
      where: { id: timeOffId },
      data: {
        status: dto.decision,
        reviewerUserId,
        reviewedAt: new Date(),
        reviewerNotes: dto.reviewerNotes ?? null,
      },
    });
  }

  async cancel(employeeId: string, timeOffId: string) {
    const prisma = this.tenantPrisma.getClient();
    const row = await prisma.employeeTimeOff.findFirst({
      where: { id: timeOffId, employeeId },
    });

    if (!row) throw new TimeOffNotFoundError(timeOffId);

    const now = new Date();
    const startDateNorm = new Date(row.startDate);

    if (row.status === 'PENDING') {
      // Always allowed
    } else if (row.status === 'APPROVED' && startDateNorm > now) {
      // Allowed — future approved
    } else {
      throw new TimeOffInvalidTransitionError(row.status, 'cancel');
    }

    return prisma.employeeTimeOff.update({
      where: { id: timeOffId },
      data: { status: 'CANCELLED' },
    });
  }

  async listForEmployee(
    employeeId: string,
    query: ListTimeOffQueryDto,
    ability?: AppAbility,
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    const page = query.page ?? 1;
    const limit = query.pageSize ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { employeeId };
    if (query.status) where.status = query.status;
    if (query.year) {
      where.startDate = {
        gte: new Date(Date.UTC(query.year, 0, 1)),
        lt: new Date(Date.UTC(query.year + 1, 0, 1)),
      };
    }

    const [data, total] = await Promise.all([
      prisma.employeeTimeOff.findMany({
        where,
        orderBy: { startDate: 'desc' },
        skip,
        take: limit,
      }),
      prisma.employeeTimeOff.count({ where }),
    ]);

    const effectiveAbility = ability ?? (await this.getCurrentAbility());

    return {
      data: data.map((row: any) =>
        this.stripMedicalReason(row, effectiveAbility),
      ),
      total,
      page,
      limit,
    };
  }

  async getVacationBalance(employeeId: string, year?: number) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const targetYear = year ?? new Date().getUTCFullYear();
    const entitlement = employee.annualVacationDays ?? 0;

    const prisma = this.tenantPrisma.getClient();
    const yearStart = new Date(Date.UTC(targetYear, 0, 1));
    const yearEnd = new Date(Date.UTC(targetYear + 1, 0, 1));

    const approvedRows = await prisma.employeeTimeOff.findMany({
      where: {
        employeeId,
        type: 'VACATION',
        status: 'APPROVED',
        startDate: { gte: yearStart, lt: yearEnd },
      },
    });

    const pendingRows = await prisma.employeeTimeOff.findMany({
      where: {
        employeeId,
        type: 'VACATION',
        status: 'PENDING',
        startDate: { gte: yearStart, lt: yearEnd },
      },
    });

    const used = approvedRows.reduce(
      (sum: number, r: any) => sum + this.daysInclusive(r.startDate, r.endDate),
      0,
    );
    const pending = pendingRows.reduce(
      (sum: number, r: any) => sum + this.daysInclusive(r.startDate, r.endDate),
      0,
    );

    return {
      year: targetYear,
      entitlement,
      used,
      pending,
      remaining: entitlement - used,
    };
  }

  async listPendingApprovals(ability?: AppAbility) {
    const prisma = this.tenantPrisma.getClient();

    const rows = await prisma.employeeTimeOff.findMany({
      where: { status: 'PENDING' },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });

    const effectiveAbility = ability ?? (await this.getCurrentAbility());

    // Denormalize requester identity inline so the frontend needs no
    // capped second lookup. ONE batch read on the Employee model, which
    // is auto tenant-scoped by the tenant Prisma client — do NOT hand-add
    // tenantId here (cross-tenant ids are silently filtered out already).
    const employeeIds = [...new Set(rows.map((row: any) => row.employeeId))];
    const employees =
      employeeIds.length > 0
        ? await prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
            },
          })
        : [];
    const employeeById = new Map<string, any>(
      (employees ?? []).map((employee: any) => [employee.id, employee]),
    );

    return rows.map((row: any) => {
      const employee = employeeById.get(row.employeeId);
      return {
        ...this.stripMedicalReason(row, effectiveAbility),
        fullName: buildDisplayName(employee?.firstName, employee?.lastName),
        employeeNumber: employee?.employeeNumber ?? null,
      };
    });
  }

  // ==================== Helpers ====================

  private stripMedicalReason(row: any, ability?: AppAbility): any {
    const copy = { ...row };
    if (
      copy.type === 'SICK' &&
      (!ability || !ability.can('read', 'EmployeeTimeOffMedical'))
    ) {
      copy.reason = null;
    }
    return copy;
  }

  private daysInclusive(
    startDate: Date | string,
    endDate: Date | string,
  ): number {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    return Math.round((end - start) / 86400000) + 1;
  }
}
