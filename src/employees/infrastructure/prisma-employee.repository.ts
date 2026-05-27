import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  IEmployeeRepository,
  EmployeeListOptions,
  EmployeeListResult,
} from '../domain/employee.repository';

@Injectable()
export class PrismaEmployeeRepository implements IEmployeeRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async create(data: any): Promise<any> {
    throw new Error('Not implemented');
  }

  async findById(id: string): Promise<any | null> {
    throw new Error('Not implemented');
  }

  async findAll(options: EmployeeListOptions): Promise<EmployeeListResult> {
    throw new Error('Not implemented');
  }

  async update(id: string, data: any): Promise<any> {
    throw new Error('Not implemented');
  }
}
