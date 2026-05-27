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
  findSubordinates(managerId: string): Promise<any[]>;
  findManagerIdOf(employeeId: string): Promise<string | null>;
}

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');
