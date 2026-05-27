import { DomainError } from '../../../shared/domain/domain-error';

export class ManagerCycleError extends DomainError {
  constructor(employeeId: string, proposedManagerId: string) {
    super(
      `Cannot set manager: assigning manager ${proposedManagerId} to employee ${employeeId} would create a cycle in the org chart`,
      'MANAGER_CYCLE',
    );
  }
}
