import { Inject, Injectable } from '@nestjs/common';
import type { IEmployeeRepository } from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  CreateEmergencyContactDto,
  UpdateEmergencyContactDto,
} from '../dto/emergency-contact.dto';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmergencyContactNotFoundError } from '../domain/errors/emergency-contact-not-found.error';

@Injectable()
export class EmployeeEmergencyContactsService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async create(employeeId: string, dto: CreateEmergencyContactDto) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    return prisma.employeeEmergencyContact.create({
      data: {
        employeeId,
        name: dto.name.trim(),
        relationship: dto.relationship.trim(),
        phone: dto.phone.trim(),
        email: dto.email?.trim().toLowerCase() ?? null,
        tenantId,
      },
    });
  }

  async listForEmployee(employeeId: string) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    return prisma.employeeEmergencyContact.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(
    employeeId: string,
    contactId: string,
    dto: UpdateEmergencyContactDto,
  ) {
    const prisma = this.tenantPrisma.getClient();
    const existing = await prisma.employeeEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.employeeId !== employeeId) {
      throw new EmergencyContactNotFoundError(contactId);
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.relationship !== undefined)
      data.relationship = dto.relationship.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.email !== undefined)
      data.email = dto.email?.trim().toLowerCase() ?? null;

    return prisma.employeeEmergencyContact.update({
      where: { id: contactId },
      data,
    });
  }

  async delete(employeeId: string, contactId: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const existing = await prisma.employeeEmergencyContact.findUnique({
      where: { id: contactId },
    });
    if (!existing || existing.employeeId !== employeeId) {
      throw new EmergencyContactNotFoundError(contactId);
    }

    await prisma.employeeEmergencyContact.delete({
      where: { id: contactId },
    });
  }
}
