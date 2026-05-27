import { Inject, Injectable } from '@nestjs/common';
import type { IEmployeeRepository } from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { AddSalaryChangeDto } from '../dto/add-salary-change.dto';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';

@Injectable()
export class EmployeeSalaryService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async addSalaryChange(
    employeeId: string,
    dto: AddSalaryChangeDto,
    recordedByUserId?: string,
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const currency = dto.currency ?? 'MXN';

    const [historyRow] = await prisma.$transaction([
      prisma.employeeSalaryHistory.create({
        data: {
          employeeId,
          amountCents: dto.amountCents,
          currency,
          effectiveFrom: new Date(dto.effectiveFrom),
          reason: dto.reason,
          recordedByUserId: recordedByUserId ?? null,
          tenantId,
        },
      }),
      prisma.employee.update({
        where: { id: employeeId },
        data: {
          currentSalaryCents: dto.amountCents,
          currentSalaryCurrency: currency,
        },
      }),
    ]);

    return historyRow;
  }

  async listSalaryHistory(employeeId: string) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    return prisma.employeeSalaryHistory.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
    });
  }
}
