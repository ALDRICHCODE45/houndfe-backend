import { DomainError } from '../../../shared/domain/domain-error';

export class EmployeeNumberConflictError extends DomainError {
  constructor(employeeNumber: string) {
    super(
      `Employee number "${employeeNumber}" already exists in this tenant`,
      'DUPLICATE_EMPLOYEE_NUMBER',
    );
  }
}
