import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type {
  IEmployeeRepository,
  EmployeeListOptions,
} from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { CaslAbilityFactory } from '../../auth/authorization/casl-ability.factory';
import { CreateEmployeeDto } from '../dto/create-employee.dto';
import { UpdateEmployeeDto } from '../dto/update-employee.dto';
import { TerminateEmployeeDto } from '../dto/terminate-employee.dto';
import { ListEmployeesQueryDto } from '../dto/list-employees.query.dto';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { ManagerSelfReferenceError } from '../domain/errors/manager-self-reference.error';
import { ManagerCycleError } from '../domain/errors/manager-cycle.error';
import {
  BatchDeleteValidationError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  BatchDeletableService,
  ValidationResult,
} from '../../shared/batch-delete/batch-delete.types';

@Injectable()
export class EmployeesService extends BatchDeletableService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
    @Optional() private readonly cls?: ClsService<TenantClsStore>,
    @Optional() private readonly caslAbilityFactory?: CaslAbilityFactory,
  ) {
    super();
  }

  /**
   * Build the CASL ability for the current request, using CLS context.
   * Returns undefined if dependencies are not wired (e.g. in unit tests with
   * direct service instantiation), allowing callers to pass an explicit
   * ability via the override parameter.
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

  async create(dto: CreateEmployeeDto) {
    const tenantId = this.tenantPrisma.getTenantId();

    // Validate that proposed manager exists in same tenant
    if (dto.managerId) {
      const managerExists = await this.employeeRepo.findById(dto.managerId);
      if (!managerExists) {
        throw new EmployeeNotFoundError(dto.managerId);
      }
    }

    const data = {
      employeeNumber: dto.employeeNumber.trim(),
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      email: dto.email?.trim().toLowerCase() || null,
      phone: dto.phone?.trim() || null,
      dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
      nationalId: dto.nationalId?.trim() || null,
      nationalIdType: dto.nationalIdType || null,
      photoFileId: dto.photoFileId || null,
      cvFileId: dto.cvFileId || null,
      street: dto.street?.trim() || null,
      exteriorNumber: dto.exteriorNumber?.trim() || null,
      interiorNumber: dto.interiorNumber?.trim() || null,
      zipCode: dto.zipCode?.trim() || null,
      neighborhood: dto.neighborhood?.trim() || null,
      municipality: dto.municipality?.trim() || null,
      city: dto.city?.trim() || null,
      state: dto.state?.trim() || null,
      hireDate: new Date(dto.hireDate),
      contractType: dto.contractType || 'PERMANENT',
      workModality: dto.workModality || 'ONSITE',
      currentPosition: dto.currentPosition?.trim() || null,
      currentDepartment: dto.currentDepartment?.trim() || null,
      currentSchedule: dto.currentSchedule?.trim() || null,
      currentResponsibilities: dto.currentResponsibilities?.trim() || null,
      annualVacationDays: dto.annualVacationDays ?? 0,
      managerId: dto.managerId || null,
      tenantId,
    };

    const employee = await this.employeeRepo.create(data);
    return this.toResponse(employee);
  }

  async findAll(query: ListEmployeesQueryDto, ability?: AppAbility) {
    const options: EmployeeListOptions = {
      status: query.status || 'active',
      managerId: query.managerId,
      search: query.search,
      page: query.page || 1,
      limit: query.pageSize || 20,
    };

    const result = await this.employeeRepo.findAll(options);
    const effectiveAbility = ability ?? (await this.getCurrentAbility());

    return {
      data: result.data.map((emp) =>
        this.stripSensitiveFields(this.toResponse(emp), effectiveAbility),
      ),
      total: result.total,
      page: result.page,
      limit: result.limit,
      pageSize: result.limit,
    };
  }

  async findOne(id: string, ability?: AppAbility) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);
    const effectiveAbility = ability ?? (await this.getCurrentAbility());
    return this.stripSensitiveFields(
      this.toResponse(employee),
      effectiveAbility,
    );
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);

    // Full ancestry cycle prevention (covers self-reference + indirect cycles)
    if (dto.managerId !== undefined && dto.managerId !== null) {
      await this.assertNoManagerCycle(id, dto.managerId);
    }

    const data: any = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim();
    if (dto.email !== undefined)
      data.email = dto.email?.trim().toLowerCase() || null;
    if (dto.phone !== undefined) data.phone = dto.phone?.trim() || null;
    if (dto.dateOfBirth !== undefined)
      data.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
    if (dto.nationalId !== undefined)
      data.nationalId = dto.nationalId?.trim() || null;
    if (dto.nationalIdType !== undefined)
      data.nationalIdType = dto.nationalIdType || null;
    if (dto.photoFileId !== undefined)
      data.photoFileId = dto.photoFileId || null;
    if (dto.cvFileId !== undefined) data.cvFileId = dto.cvFileId || null;
    if (dto.street !== undefined) data.street = dto.street?.trim() || null;
    if (dto.exteriorNumber !== undefined)
      data.exteriorNumber = dto.exteriorNumber?.trim() || null;
    if (dto.interiorNumber !== undefined)
      data.interiorNumber = dto.interiorNumber?.trim() || null;
    if (dto.zipCode !== undefined) data.zipCode = dto.zipCode?.trim() || null;
    if (dto.neighborhood !== undefined)
      data.neighborhood = dto.neighborhood?.trim() || null;
    if (dto.municipality !== undefined)
      data.municipality = dto.municipality?.trim() || null;
    if (dto.city !== undefined) data.city = dto.city?.trim() || null;
    if (dto.state !== undefined) data.state = dto.state?.trim() || null;
    if (dto.contractType !== undefined) data.contractType = dto.contractType;
    if (dto.workModality !== undefined) data.workModality = dto.workModality;
    if (dto.currentPosition !== undefined)
      data.currentPosition = dto.currentPosition?.trim() || null;
    if (dto.currentDepartment !== undefined)
      data.currentDepartment = dto.currentDepartment?.trim() || null;
    if (dto.currentSchedule !== undefined)
      data.currentSchedule = dto.currentSchedule?.trim() || null;
    if (dto.currentResponsibilities !== undefined)
      data.currentResponsibilities =
        dto.currentResponsibilities?.trim() || null;
    if (dto.annualVacationDays !== undefined)
      data.annualVacationDays = dto.annualVacationDays;
    if (dto.managerId !== undefined) data.managerId = dto.managerId || null;
    if (dto.employeeNumber !== undefined)
      data.employeeNumber = dto.employeeNumber.trim();

    const updated = await this.employeeRepo.update(id, data);
    return this.toResponse(updated);
  }

  async terminate(id: string, dto: TerminateEmployeeDto) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);

    if (employee.status === 'TERMINATED') {
      throw new BusinessRuleViolationError(
        'Employee is already terminated',
        'EMPLOYEE_ALREADY_TERMINATED',
      );
    }

    const updated = await this.employeeRepo.update(id, {
      status: 'TERMINATED',
      terminationDate: new Date(dto.terminationDate),
      terminationReason: dto.terminationReason?.trim() || null,
    });

    return this.toResponse(updated);
  }

  async reactivate(id: string) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);

    if (employee.status !== 'TERMINATED') {
      throw new BusinessRuleViolationError(
        'Employee is not terminated',
        'EMPLOYEE_NOT_TERMINATED',
      );
    }

    const updated = await this.employeeRepo.update(id, {
      status: 'ACTIVE',
      terminationDate: null,
      terminationReason: null,
    });

    return this.toResponse(updated);
  }

  // ============================================================
  // batchTerminate — inline batch-status endpoint. Mirrors the
  // single-record `terminate()` pre-flight (`EmployeeNotFoundError
  // → 404`) but applies the validation across the whole id list
  // and delegates the actual flip to `repo.updateStatusMany`.
  //
  // Tenant ownership is verified by `tenantPrisma.getClient()` —
  // cross-tenant ids surface as missing rows because the tenant
  // middleware filters by `tenantId` automatically. Any missing id
  // throws `BatchDeleteValidationError` with
  // `code = 'BATCH_DELETE_NOT_FOUND'` so the
  // `DomainExceptionFilter` translates it to a 404 with
  // `offendingIds` + `reason` in the response body (matches the
  // `batch-delete` response contract).
  //
  // Empty-array short-circuit: returns `{ updated: 0 }` without
  // any DB roundtrip. Upstream `BatchDeleteDto` enforces
  // `@ArrayMinSize(1)` so this branch is defensive only.
  // ============================================================
  async batchTerminate(ids: string[]): Promise<{ updated: number }> {
    if (ids.length === 0) {
      return { updated: 0 };
    }
    await this.assertAllIdsExist(ids);
    const updated = await this.employeeRepo.updateStatusMany(
      ids,
      'TERMINATED',
    );
    return { updated };
  }

  // ============================================================
  // batchReactivate — inline batch-status endpoint. Mirrors the
  // single-record `reactivate()` pre-flight but applies the
  // validation across the whole id list. Note we intentionally
  // do NOT enforce "only reactivate TERMINATED ones" in the
  // service layer — flipping an ACTIVE row back to ACTIVE is a
  // harmless no-op and `updateStatusMany` reports whatever
  // Prisma actually changed, so the caller always sees the
  // observable truth. Same 404 contract as `batchTerminate` for
  // cross-tenant / missing ids.
  // ============================================================
  async batchReactivate(ids: string[]): Promise<{ updated: number }> {
    if (ids.length === 0) {
      return { updated: 0 };
    }
    await this.assertAllIdsExist(ids);
    const updated = await this.employeeRepo.updateStatusMany(
      ids,
      'ACTIVE',
    );
    return { updated };
  }

  /**
   * Confirm every supplied id resolves to an Employee row that lives
   * in the current tenant. Throws `BatchDeleteValidationError`
   * (→ 404 via `DomainExceptionFilter`) with the SAME
   * `BATCH_DELETE_NOT_FOUND` code as `batch-delete` so callers do
   * not have to branch on the endpoint they hit.
   *
   * Shared between `batchTerminate` and `batchReactivate` — both
   * endpoints make the same "all ids live in this tenant" promise.
   */
  private async assertAllIdsExist(ids: string[]): Promise<void> {
    const tenantClient = this.tenantPrisma.getClient();
    const existing = await tenantClient.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(
      existing.map((row: { id: string }) => row.id),
    );
    const missingIds = ids.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      throw new BatchDeleteValidationError(
        missingIds,
        `Employee(s) not found in this tenant: ${missingIds.join(', ')}`,
        'BATCH_DELETE_NOT_FOUND',
      );
    }
  }

  async findSubordinates(id: string, ability?: AppAbility) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);
    const subs = await this.employeeRepo.findSubordinates(id);
    const effectiveAbility = ability ?? (await this.getCurrentAbility());
    return subs.map((s) =>
      this.stripSensitiveFields(this.toResponse(s), effectiveAbility),
    );
  }

  async remove(id: string): Promise<void> {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);
    await this.employeeRepo.delete(id);
  }

  async findManagerChain(id: string, ability?: AppAbility) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);
    const effectiveAbility = ability ?? (await this.getCurrentAbility());
    const chain: any[] = [];
    let currentManagerId: string | null = employee.managerId;
    const visited = new Set<string>();
    for (let i = 0; i < 50; i++) {
      if (currentManagerId === null) break;
      if (visited.has(currentManagerId)) break;
      visited.add(currentManagerId);
      const manager = await this.employeeRepo.findById(currentManagerId);
      if (!manager) break;
      chain.push(
        this.stripSensitiveFields(this.toResponse(manager), effectiveAbility),
      );
      currentManagerId = manager.managerId;
    }
    return chain;
  }

  // ==================== Helpers ====================

  private async assertNoManagerCycle(
    employeeId: string,
    proposedManagerId: string,
  ): Promise<void> {
    // Step 1: direct self-reference
    if (proposedManagerId === employeeId) {
      throw new ManagerSelfReferenceError(employeeId);
    }
    // Step 2: walk ancestry from proposedManagerId upward
    let currentId: string | null = proposedManagerId;
    const visited = new Set<string>();
    for (let i = 0; i < 50; i++) {
      if (currentId === null) return;
      if (visited.has(currentId)) return;
      visited.add(currentId);
      if (currentId === employeeId) {
        throw new ManagerCycleError(employeeId, proposedManagerId);
      }
      currentId = await this.employeeRepo.findManagerIdOf(currentId);
    }
    // Defensive cap reached — log warning but allow write
    this.logger.warn(
      `Manager chain depth exceeded 50 for employee ${employeeId} -> proposed manager ${proposedManagerId}. Possible data corruption.`,
    );
  }

  private toResponse(employee: any) {
    return {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email: employee.email,
      phone: employee.phone,
      dateOfBirth: employee.dateOfBirth
        ? new Date(employee.dateOfBirth).toISOString().split('T')[0]
        : null,
      nationalId: employee.nationalId,
      nationalIdType: employee.nationalIdType,
      photoFileId: employee.photoFileId,
      cvFileId: employee.cvFileId,
      street: employee.street,
      exteriorNumber: employee.exteriorNumber,
      interiorNumber: employee.interiorNumber,
      zipCode: employee.zipCode,
      neighborhood: employee.neighborhood,
      municipality: employee.municipality,
      city: employee.city,
      state: employee.state,
      hireDate: employee.hireDate
        ? new Date(employee.hireDate).toISOString().split('T')[0]
        : null,
      terminationDate: employee.terminationDate
        ? new Date(employee.terminationDate).toISOString().split('T')[0]
        : null,
      terminationReason: employee.terminationReason,
      status: employee.status,
      currentPosition: employee.currentPosition,
      currentDepartment: employee.currentDepartment,
      currentSalaryCents: employee.currentSalaryCents,
      currentSalaryCurrency: employee.currentSalaryCurrency,
      currentResponsibilities: employee.currentResponsibilities,
      currentSchedule: employee.currentSchedule,
      contractType: employee.contractType,
      workModality: employee.workModality,
      annualVacationDays: employee.annualVacationDays,
      managerId: employee.managerId,
      createdAt: employee.createdAt
        ? new Date(employee.createdAt).toISOString()
        : null,
      updatedAt: employee.updatedAt
        ? new Date(employee.updatedAt).toISOString()
        : null,
    };
  }

  stripSensitiveFields(response: any, ability?: AppAbility) {
    const result = { ...response };
    if (!ability || !ability.can('read', 'EmployeeSalary')) {
      delete result.currentSalaryCents;
      delete result.currentSalaryCurrency;
    }
    return result;
  }

  // ==================== BatchDeletableService ====================

  /**
   * Pre-flight validation for batch deletion.
   *
   * Spec: `employee-batch-delete/spec.md` R3 (validation rules).
   *
   * Single check — every supplied id must resolve to an Employee row
   * that lives in the current tenant (tenant-scoped Prisma client via
   * `tenantPrisma.getClient()`). Cross-tenant IDs surface as missing
   * rows because the tenant middleware filters by `tenantId`
   * automatically.
   *
   * The 5 child tables (`EmployeeSalaryHistory`,
   * `EmployeePositionHistory`, `EmployeeDocument`, `EmployeeTimeOff`,
   * `EmployeeEmergencyContact`) cascade via the Prisma schema, so no
   * FK-guard is needed at this layer. The self-relation on
   * `managerId` is `SetNull`, so deleting a manager does not orphan
   * their subordinates.
   *
   * Returns `{ valid: false, offendingIds, code, reason }` on any
   * failure. The orchestrator maps that into a
   * `BatchDeleteValidationError` → 404 with offendingIds + reason
   * serialized into the response body.
   */
  async validateForBatchDeletion(ids: string[]): Promise<ValidationResult> {
    if (ids.length === 0) {
      return { valid: true };
    }
    const tenantClient = this.tenantPrisma.getClient();

    const existing = await tenantClient.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((row: { id: string }) => row.id));
    const missingIds = ids.filter((id) => !existingIds.has(id));

    if (missingIds.length === 0) {
      return { valid: true };
    }

    return {
      valid: false,
      offendingIds: missingIds,
      code: 'BATCH_DELETE_NOT_FOUND',
      reason: `Employee(s) not found in this tenant: ${missingIds.join(', ')}`,
    };
  }

  /**
   * Hard-delete the supplied employee ids inside the current ambient
   * CLS transaction. Caller MUST have already passed
   * `validateForBatchDeletion` — this method does no validation of
   * its own (it just runs `repo.deleteMany` and returns the Prisma
   * row count).
   */
  async executeInTransaction(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.employeeRepo.deleteMany(ids);
  }
}
