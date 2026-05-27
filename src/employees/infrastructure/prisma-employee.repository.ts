import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  IEmployeeRepository,
  EmployeeListOptions,
  EmployeeListResult,
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
