import {
  ListingErrorCode,
  ListingHttpException,
  buildListingErrorBody,
} from './listing.exceptions';

describe('ListingHttpException', () => {
  it('returns expected error envelope body', () => {
    const body = buildListingErrorBody({
      code: ListingErrorCode.LISTING_INVALID_ENUM_VALUE,
      message: 'Invalid value',
      field: 'paymentStatus',
      details: { allowed: ['PAID', 'PARTIAL'] },
    });

    expect(body).toEqual({
      statusCode: 400,
      code: ListingErrorCode.LISTING_INVALID_ENUM_VALUE,
      message: 'Invalid value',
      field: 'paymentStatus',
      details: { allowed: ['PAID', 'PARTIAL'] },
    });
  });

  it('wraps body in BadRequestException response', () => {
    const exception = new ListingHttpException({
      code: ListingErrorCode.LISTING_TOO_MANY_VALUES,
      message: 'Too many values',
      field: 'folio',
      details: { cap: 200 },
    });

    expect(exception.getStatus()).toBe(400);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: ListingErrorCode.LISTING_TOO_MANY_VALUES,
      message: 'Too many values',
      field: 'folio',
      details: { cap: 200 },
    });
  });
});
