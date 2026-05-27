import { DomainError } from '../../../shared/domain/domain-error';

export class TimeOffInvalidDateRangeError extends DomainError {
  constructor(startDate: string, endDate: string) {
    super(
      `Invalid date range: endDate (${endDate}) is before startDate (${startDate})`,
      'TIME_OFF_INVALID_DATE_RANGE',
    );
  }
}
