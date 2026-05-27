import { EntityNotFoundError } from '../../../shared/domain/domain-error';

export class EmployeeDocumentNotFoundError extends EntityNotFoundError {
  constructor(docId: string) {
    super('EmployeeDocument', docId);
  }
}
