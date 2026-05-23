import { ListingErrorCode } from '../listing.exceptions';

export const LISTING_VALIDATION_CONTEXT = {
  invertedRange: {
    code: ListingErrorCode.LISTING_INVERTED_RANGE,
  },
  invalidNumber: {
    code: ListingErrorCode.LISTING_INVALID_NUMBER,
  },
  invalidDate: {
    code: ListingErrorCode.LISTING_INVALID_DATE,
  },
} as const;
