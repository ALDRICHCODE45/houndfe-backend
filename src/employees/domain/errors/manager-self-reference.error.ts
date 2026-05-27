import { DomainError } from '../../../shared/domain/domain-error';

export class ManagerSelfReferenceError extends DomainError {
  constructor(employeeId: string) {
    super(
      `Employee "${employeeId}" cannot be their own manager`,
      'MANAGER_SELF_REFERENCE',
    );
  }
}
