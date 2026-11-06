/**
 * zone-validation-lookup / T1 (S2) — `DeliveryZoneHttpFilter` envelope: the
 * PENDING 409 carries the open validation's id; every other code keeps the
 * fixed `{statusCode, code, message}` body.
 */
import type { ArgumentsHost } from '@nestjs/common';
import { DeliveryZoneError } from '../domain/delivery-zone.repository';
import { DeliveryZoneHttpFilter } from './delivery-zone-http.filter';

function capture(exception: DeliveryZoneError) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new DeliveryZoneHttpFilter().catch(exception, host);
  const [[status]] = response.status.mock.calls as [[number]];
  const [[body]] = response.json.mock.calls as [[Record<string, unknown>]];
  return { status, body };
}

describe('DeliveryZoneHttpFilter', () => {
  it('adds validationId to the DELIVERY_ZONE_VALIDATION_PENDING 409', () => {
    const validationId = '8a2f1c3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    const { status, body } = capture(
      new DeliveryZoneError(
        'DELIVERY_ZONE_VALIDATION_PENDING',
        'internal message',
        { validationId },
      ),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      code: 'DELIVERY_ZONE_VALIDATION_PENDING',
      message:
        'A validation is pending for this postal code; resolve it instead',
      validationId,
    });
  });

  it('keeps the fixed envelope for codes without a validationId', () => {
    const { status, body } = capture(
      new DeliveryZoneError('DELIVERY_ZONE_NOT_FOUND', 'internal message'),
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      code: 'DELIVERY_ZONE_NOT_FOUND',
      message: 'Delivery zone not found',
    });
  });
});
