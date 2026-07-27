export interface EmployeeListOptions {
  status?: 'active' | 'terminated' | 'all';
  managerId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface EmployeeListResult {
  data: any[];
  total: number;
  page: number;
  limit: number;
}

export interface IEmployeeRepository {
  create(data: any): Promise<any>;
  findById(id: string): Promise<any | null>;
  findAll(options: EmployeeListOptions): Promise<EmployeeListResult>;
  update(id: string, data: any): Promise<any>;
  delete(id: string): Promise<void>;
  /**
   * Batch hard delete — used by the shared `BatchDeleteOrchestrator`
   * for `POST /admin/employees/batch-delete`.
   *
   * The Prisma client is obtained from `TenantPrismaService.getClient()`,
   * so the ambient CLS transaction wraps the entire delete. Joins to
   * the 5 child tables (`salaryHistory`, `positionHistory`, `documents`,
   * `timeOff`, `emergencyContacts`) cascade via the schema. The
   * self-relation on `managerId` is `SetNull`, so deleting a manager
   * never orphans their subordinates.
   *
   * Returns the number of rows actually removed so the orchestrator
   * can echo `{ deleted: N }` to the caller.
   */
  deleteMany(ids: string[]): Promise<number>;
  findSubordinates(managerId: string): Promise<any[]>;
  findManagerIdOf(employeeId: string): Promise<string | null>;
}

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');
