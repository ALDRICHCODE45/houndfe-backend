import { BadRequestException } from '@nestjs/common';

export enum ListingErrorCode {
  LISTING_INVERTED_RANGE = 'LISTING_INVERTED_RANGE',
  LISTING_INVALID_ENUM_VALUE = 'LISTING_INVALID_ENUM_VALUE',
  LISTING_TOO_MANY_VALUES = 'LISTING_TOO_MANY_VALUES',
  LISTING_INVALID_DATE = 'LISTING_INVALID_DATE',
  LISTING_INVALID_UUID = 'LISTING_INVALID_UUID',
  LISTING_INVALID_NUMBER = 'LISTING_INVALID_NUMBER',
}

export type ListingErrorBody = {
  statusCode: 400;
  code: ListingErrorCode;
  message: string;
  field: string;
  details?: {
    allowed?: string[];
    cap?: number;
    min?: unknown;
    max?: unknown;
    received?: unknown;
  };
};

export type ListingErrorInput = Omit<ListingErrorBody, 'statusCode'>;

export const buildListingErrorBody = (
  input: ListingErrorInput,
): ListingErrorBody => ({
  statusCode: 400,
  code: input.code,
  message: input.message,
  field: input.field,
  details: input.details,
});

export class ListingHttpException extends BadRequestException {
  constructor(input: ListingErrorInput) {
    super(buildListingErrorBody(input));
  }
}
