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

export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'TERMINATED';

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
  /**
   * Batch status flip — used by `EmployeesService.batchTerminate` /
   * `batchReactivate` (see `POST /admin/employees/batch-terminate` /
   * `batch-reactivate`).
   *
   * Updates every employee whose id is in `ids` in a single Prisma
   * `updateMany`. When `status === 'TERMINATED'` the implementation
   * stamps `terminationDate = new Date()` so the row is consistent
   * with a single-record `terminate()`. For any other status the
   * `terminationDate` is cleared.
   *
   * Implementation MUST use `tenantPrisma.getClient()` so the
   * batch-status service can honour the ambient CLS tx (one
   * missing row rolls back the entire batch — all-or-nothing).
   *
   * Returns the number of rows actually updated so the service can
   * echo `{ updated: N }` to the caller.
   */
  updateStatusMany(ids: string[], status: EmployeeStatus): Promise<number>;
  findSubordinates(managerId: string): Promise<any[]>;
  findManagerIdOf(employeeId: string): Promise<string | null>;
}

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');
