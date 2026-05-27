import { EntityNotFoundError } from '../../../shared/domain/domain-error';

export class TimeOffNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('EmployeeTimeOff', id);
  }
}
