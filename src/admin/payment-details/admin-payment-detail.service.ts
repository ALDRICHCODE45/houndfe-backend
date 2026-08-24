/**
 * AdminPaymentDetailService — Q1 / WU1.
 *
 * Use-case orchestrator for the `PaymentDetail` admin CRUD. Tenant-scoped
 * via `ClsService<TenantClsStore>` so every read/write resolves to the
 * caller's tenant context (mirrors `AdminRoleService`). Cross-tenant access
 * surfaces as `EntityNotFoundError` → 404 (NEVER 403 — no presence leak).
 *
 * DELETE is logical (`entity.deactivate()` sets `isActive=false`); there is
 * NO hard delete endpoint (D2).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PaymentDetail } from './domain/payment-detail.entity';
import {
  PAYMENT_DETAIL_REPOSITORY,
  type IPaymentDetailRepository,
} from './domain/payment-detail.repository';
import type { PaymentDetailResponseDto } from './dto/payment-detail-response.dto';
import type { CreatePaymentDetailDto } from './dto/create-payment-detail.dto';
import type { UpdatePaymentDetailDto } from './dto/update-payment-detail.dto';

@Injectable()
export class AdminPaymentDetailService {
  constructor(
    @Inject(PAYMENT_DETAIL_REPOSITORY)
    private readonly repo: IPaymentDetailRepository,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async findAll(): Promise<PaymentDetailResponseDto[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.repo.findAll(tenantId);
    return rows.map((r) => r.toResponse());
  }

  async findOne(id: string): Promise<PaymentDetailResponseDto> {
    const tenantId = this.requireTenantId();
    const row = await this.repo.findById(id, tenantId);
    if (!row) {
      // Cross-tenant reads surface as 404 (no presence leak).
      throw new EntityNotFoundError('PaymentDetail', id);
    }
    return row.toResponse();
  }

  async create(dto: CreatePaymentDetailDto): Promise<PaymentDetailResponseDto> {
    const tenantId = this.requireTenantId();
    const entity = PaymentDetail.create({
      id: randomUUID(),
      tenantId,
      bankName: dto.bankName,
      beneficiary: dto.beneficiary,
      clabe: dto.clabe,
      accountNumber: dto.accountNumber,
    });
    const saved = await this.repo.create(entity);
    return saved.toResponse();
  }

  async update(
    id: string,
    dto: UpdatePaymentDetailDto,
  ): Promise<PaymentDetailResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.repo.findById(id, tenantId);
    if (!existing) {
      throw new EntityNotFoundError('PaymentDetail', id);
    }
    existing.update({
      bankName: dto.bankName,
      beneficiary: dto.beneficiary,
      clabe: dto.clabe,
      accountNumber: dto.accountNumber,
    });
    const saved = await this.repo.update(existing);
    return saved.toResponse();
  }

  /**
   * Logical delete (D2): flips `isActive=false` and returns 204. The
   * controller's `@HttpCode(HttpStatus.NO_CONTENT)` ensures no body leaks.
   */
  async delete(id: string): Promise<void> {
    const tenantId = this.requireTenantId();
    const existing = await this.repo.findById(id, tenantId);
    if (!existing) {
      throw new EntityNotFoundError('PaymentDetail', id);
    }
    existing.deactivate();
    await this.repo.update(existing);
  }

  private requireTenantId(): string {
    const { tenantId, isSuperAdmin } = this.cls.get();
    // Super-admin without a tenant context can list across tenants but the
    // service is still tenant-scoped (no global branch). Cross-tenant writes
    // happen via the explicit tenant assignment at creation time only.
    if (!tenantId && !isSuperAdmin) {
      throw new InvalidArgumentError(
        'Tenant context required',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    if (!tenantId) {
      throw new InvalidArgumentError(
        'PaymentDetail admin operations require an explicit tenant',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }
}
