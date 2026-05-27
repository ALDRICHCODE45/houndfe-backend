import { Inject, Injectable } from '@nestjs/common';
import type { IEmployeeRepository } from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { AddPositionChangeDto } from '../dto/add-position-change.dto';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';

@Injectable()
export class EmployeePositionService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async addPositionChange(
    employeeId: string,
    dto: AddPositionChangeDto,
    recordedByUserId?: string,
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const [historyRow] = await prisma.$transaction([
      prisma.employeePositionHistory.create({
        data: {
          employeeId,
          position: dto.position,
          department: dto.department ?? null,
          effectiveFrom: new Date(dto.effectiveFrom),
          reason: dto.reason,
          recordedByUserId: recordedByUserId ?? null,
          tenantId,
        },
      }),
      prisma.employee.update({
        where: { id: employeeId },
        data: {
          currentPosition: dto.position,
          currentDepartment: dto.department ?? null,
        },
      }),
    ]);

    return historyRow;
  }

  async listPositionHistory(employeeId: string) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    return prisma.employeePositionHistory.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}
