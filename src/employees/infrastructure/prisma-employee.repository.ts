import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  IEmployeeRepository,
  EmployeeListOptions,
  EmployeeListResult,
  EmployeeStatus,
} from '../domain/employee.repository';
import { EmployeeNumberConflictError } from '../domain/errors/employee-number-conflict.error';

@Injectable()
export class PrismaEmployeeRepository implements IEmployeeRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async create(data: any): Promise<any> {
    const prisma = this.tenantPrisma.getClient();
    try {
      return await prisma.employee.create({ data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new EmployeeNumberConflictError(data.employeeNumber);
      }
      throw err;
    }
  }

  async findById(id: string): Promise<any | null> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.employee.findUnique({ where: { id } });
  }

  async findAll(options: EmployeeListOptions): Promise<EmployeeListResult> {
    const prisma = this.tenantPrisma.getClient();
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.EmployeeWhereInput = {};

    if (options.status === 'active') {
      where.terminationDate = null;
    } else if (options.status === 'terminated') {
      where.terminationDate = { not: null };
    }

    if (options.managerId) {
      where.managerId = options.managerId;
    }

    if (options.search?.trim()) {
      const s = options.search.trim();
      where.OR = [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { employeeNumber: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.employee.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async update(id: string, data: any): Promise<any> {
    const prisma = this.tenantPrisma.getClient();
    try {
      return await prisma.employee.update({ where: { id }, data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new EmployeeNumberConflictError(data.employeeNumber ?? '');
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.employee.delete({ where: { id } });
  }

  // ============================================================
  // deleteMany — batch hard delete (cascade handles 5 child tables)
  //
  // Returns the count of actually-deleted rows so the orchestrator
  // can echo `{ deleted: N }` to the caller. Joins to
  // `EmployeeSalaryHistory`, `EmployeePositionHistory`,
  // `EmployeeDocument`, `EmployeeTimeOff`, and
  // `EmployeeEmergencyContact` cascade via Prisma schema. The
  // self-relation on `managerId` is `SetNull` so deleting a manager
  // never orphans their subordinates. `tenantPrisma.getClient()`
  // honours the ambient CLS tx so the entire batch is atomic — a
  // single FK violation rolls back every row.
  // ============================================================
  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const prisma = this.tenantPrisma.getClient();
    const result = await prisma.employee.deleteMany({
      where: { id: { in: ids } },
    });
    return result.count;
  }

  // ============================================================
  // updateStatusMany — batch status flip (terminate / reactivate)
  //
  // Updates every employee whose id is in `ids` in a single Prisma
  // `updateMany`. When the target status is `TERMINATED` we stamp
  // `terminationDate = new Date()` so the column stays consistent
  // with the single-record `terminate()` path (see EmployeesService.
  // terminate). For any other status (currently just `ACTIVE` via
  // reactivation) we clear `terminationDate` to NULL — matching the
  // single-record `reactivate()` shape.
  //
  // Returns the count of actually-updated rows so the service can
  // echo `{ updated: N }` to the caller. `tenantPrisma.getClient()`
  // honours the ambient CLS tx so the entire batch is atomic.
  // ============================================================
  async updateStatusMany(
    ids: string[],
    status: EmployeeStatus,
    terminationReason?: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const prisma = this.tenantPrisma.getClient();
    const data: Record<string, unknown> = {
      status,
      terminationDate:
        status === 'TERMINATED' ? new Date() : null,
    };
    if (terminationReason !== undefined) {
      data.terminationReason = terminationReason;
    }
    const result = await prisma.employee.updateMany({
      where: { id: { in: ids } },
      data,
    });
    return result.count;
  }

  async findSubordinates(managerId: string): Promise<any[]> {
    const prisma = this.tenantPrisma.getClient();
    return prisma.employee.findMany({
      where: { managerId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  async findManagerIdOf(employeeId: string): Promise<string | null> {
    const prisma = this.tenantPrisma.getClient();
    const result = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { managerId: true },
    });
    return result?.managerId ?? null;
  }
}
