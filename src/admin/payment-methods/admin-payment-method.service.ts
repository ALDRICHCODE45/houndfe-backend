/**
 * AdminPaymentMethodService — custom-payment-methods / WU1.
 *
 * Use-case orchestrator for the `PaymentMethod` admin CRUD. Tenant-scoped
 * via `ClsService<TenantClsStore>` so every read/write resolves to the
 * caller's tenant context (mirrors `AdminPaymentDetailService`).
 * Cross-tenant access surfaces as `EntityNotFoundError` → 404 (NEVER 403 —
 * no presence leak).
 *
 * DELETE is logical (`entity.deactivate()` sets `isActive=false`); there
 * is NO hard delete endpoint (D2). PATCH `{ isActive: true }` re-activates
 * a deactivated row in place.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PaymentMethod } from './domain/payment-method.entity';
import {
  PAYMENT_METHOD_REPOSITORY,
  type IPaymentMethodRepository,
} from './domain/payment-method.repository';
import type { PaymentMethodResponseDto } from './dto/payment-method-response.dto';
import type { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import type { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';

@Injectable()
export class AdminPaymentMethodService {
  constructor(
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly repo: IPaymentMethodRepository,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async findAll(): Promise<PaymentMethodResponseDto[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.repo.findAll(tenantId);
    return rows.map((r) => r.toResponse());
  }

  async findOne(id: string): Promise<PaymentMethodResponseDto> {
    const tenantId = this.requireTenantId();
    const row = await this.repo.findById(id, tenantId);
    if (!row) {
      // Cross-tenant reads surface as 404 (no presence leak).
      throw new EntityNotFoundError('PaymentMethod', id);
    }
    return row.toResponse();
  }

  async create(
    dto: CreatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const tenantId = this.requireTenantId();
    const entity = PaymentMethod.create({
      id: randomUUID(),
      tenantId,
      name: dto.name,
      category: dto.category,
      subtitle: dto.subtitle ?? null,
    });
    const saved = await this.repo.create(entity);
    return saved.toResponse();
  }

  async update(
    id: string,
    dto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethodResponseDto> {
    const tenantId = this.requireTenantId();
    const existing = await this.repo.findById(id, tenantId);
    if (!existing) {
      throw new EntityNotFoundError('PaymentMethod', id);
    }
    existing.update({
      name: dto.name,
      category: dto.category,
      subtitle: dto.subtitle === undefined ? undefined : (dto.subtitle ?? null),
      isActive: dto.isActive,
    });
    const saved = await this.repo.update(existing);
    return saved.toResponse();
  }

  /**
   * Logical delete (D2): flips `isActive=false` and returns 204. The
   * controller's `@HttpCode(HttpStatus.NO_CONTENT)` ensures no body
   * leaks. Reactivation is via PATCH `{ isActive: true }` (the `update`
   * endpoint above) — we deliberately do NOT expose a separate
   * `restore` endpoint because the spec reactivation scenario is the
   * same shape as a generic partial update.
   */
  async delete(id: string): Promise<void> {
    const tenantId = this.requireTenantId();
    const existing = await this.repo.findById(id, tenantId);
    if (!existing) {
      throw new EntityNotFoundError('PaymentMethod', id);
    }
    existing.deactivate();
    await this.repo.update(existing);
  }

  private requireTenantId(): string {
    const { tenantId, isSuperAdmin } = this.cls.get();
    // Super-admin without a tenant context can list across tenants but
    // the service is still tenant-scoped (no global branch). Cross-tenant
    // writes happen via the explicit tenant assignment at creation time
    // only. The same guard as AdminPaymentDetailService.
    if (!tenantId && !isSuperAdmin) {
      throw new InvalidArgumentError(
        'Tenant context required',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    if (!tenantId) {
      throw new InvalidArgumentError(
        'PaymentMethod admin operations require an explicit tenant',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }
}