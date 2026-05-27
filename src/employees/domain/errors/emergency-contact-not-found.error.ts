import { EntityNotFoundError } from '../../../shared/domain/domain-error';

export class EmergencyContactNotFoundError extends EntityNotFoundError {
  constructor(id: string) {
    super('EmergencyContact', id);
  }
}
