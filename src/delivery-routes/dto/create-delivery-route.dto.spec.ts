/**
 * CreateDeliveryRouteDto — `saleIds` validation regression tests.
 *
 * WU2 `POST /delivery-routes` spec: `saleIds` MUST be ≥ 1, every id a UUID
 * v4.
 *
 * Regression: `@MinLength(1)` was applied to `saleIds`. `minLength` is
 * string-only (`typeof value === 'string'`, see
 * `class-validator/cjs/decorator/string/MinLength.js`), so ANY array —
 * including a valid one — failed the DTO. Fixed by swapping to
 * `@ArrayMinSize(1)` while keeping the exact message.
 *
 * Mirrors the established `src/sat-catalog/dto/search-sat-key.dto.spec.ts`
 * pattern: `plainToInstance` + `validate`.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateDeliveryRouteDto } from './create-delivery-route.dto';

const SALE_ID = '9f0f4b0a-6b1e-4f5d-9c8a-2d4e6f8a1b3c';
const DRIVER_USER_ID = '3c1e5f7a-9b2d-4e6f-8a1c-5d7b9f0a2e4d';

function makeDto(saleIds: unknown, driverUserId: unknown = DRIVER_USER_ID) {
  return plainToInstance(CreateDeliveryRouteDto, {
    saleIds,
    driverUserId,
  });
}

describe('CreateDeliveryRouteDto — saleIds', () => {
  it('accepts an array with ≥1 valid UUID v4', async () => {
    const dto = makeDto([SALE_ID]);

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty array (≥1 sale id required)', async () => {
    const dto = makeDto([]);

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('saleIds');
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      'saleIds must contain at least one sale id',
    );
  });

  it('rejects an array containing an invalid UUID element', async () => {
    const dto = makeDto([SALE_ID, 'not-a-uuid']);

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('saleIds');
  });

  it('rejects a non-array value', async () => {
    const dto = makeDto('not-an-array');

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('saleIds');
  });
});
