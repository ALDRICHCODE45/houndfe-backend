import { EntityNotFoundError } from '../../../shared/domain/domain-error';

export class EmployeeNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('Employee', id);
  }
}
