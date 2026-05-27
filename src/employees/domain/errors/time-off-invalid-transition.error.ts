import { DomainError } from '../../../shared/domain/domain-error';

export class TimeOffInvalidTransitionError extends DomainError {
  constructor(currentStatus: string, attemptedAction: string) {
    super(
      `Cannot ${attemptedAction} time-off request with status "${currentStatus}"`,
      'TIME_OFF_INVALID_TRANSITION',
    );
  }
}
