import { Inject, Injectable } from '@nestjs/common';
import type {
  IEmployeeRepository,
  EmployeeListOptions,
} from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { CreateEmployeeDto } from '../dto/create-employee.dto';
import { UpdateEmployeeDto } from '../dto/update-employee.dto';
import { TerminateEmployeeDto } from '../dto/terminate-employee.dto';
import { ListEmployeesQueryDto } from '../dto/list-employees.query.dto';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { ManagerSelfReferenceError } from '../domain/errors/manager-self-reference.error';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type { AppAbility } from '../../auth/authorization/domain/permission';

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async create(dto: CreateEmployeeDto) {
    const tenantId = this.tenantPrisma.getTenantId();

    // Note: managerId self-reference is impossible on create (employee has no id yet).
    // Full cycle prevention against existing manager chains is handled in Slice 3.

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

    return {
      data: result.data.map((emp) =>
        this.stripSensitiveFields(this.toResponse(emp), ability),
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
    return this.stripSensitiveFields(this.toResponse(employee), ability);
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    const employee = await this.employeeRepo.findById(id);
    if (!employee) throw new EmployeeNotFoundError(id);

    // Self-reference check for managerId
    if (dto.managerId !== undefined && dto.managerId === id) {
      throw new ManagerSelfReferenceError(id);
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

  // ==================== Helpers ====================

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
}
