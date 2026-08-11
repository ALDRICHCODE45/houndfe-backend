/**
 * CreateProductDto / UpdateProductDto — Validation tests for SERVICE support.
 *
 * Targets only the fields added/changed by the product-service-type feature:
 *   - `unit` accepts the 6 service units (HORA, SESION, DIA, CONSULTA,
 *     CURSO, PAQUETE) on top of the original 8 PRODUCT units.
 *   - `serviceDetail` (nested DTO) accepts capacity/notes with the right
 *     bounds; rejects capacity < 1 and notes > 500 chars.
 *   - `type` enum stays `PRODUCT | SERVICE`.
 *
 * `class-validator` strips unknown fields when `whitelist: true` (the
 * global pipe). SERVICE pre-validation (`sku`/`barcode`/`brandId`
 * rejected when `type=SERVICE`) lives in the service layer, not the DTO,
 * so we do NOT assert it here.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateProductDto, input, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors };
}

describe('CreateProductDto — SERVICE unit enum (R3)', () => {
  it.each(['HORA', 'SESION', 'DIA', 'CONSULTA', 'CURSO', 'PAQUETE'])(
    'accepts service unit "%s"',
    async (unit) => {
      const { dto, errors } = await validateDto({
        name: 'Paseo de perros',
        type: 'SERVICE',
        unit,
      });
      expect(errors).toHaveLength(0);
      expect(dto.unit).toBe(unit);
    },
  );

  it('still accepts original PRODUCT units (regression)', async () => {
    for (const unit of [
      'UNIDAD',
      'CAJA',
      'BOLSA',
      'METRO',
      'CENTIMETRO',
      'KILOGRAMO',
      'GRAMO',
      'LITRO',
    ]) {
      const { errors } = await validateDto({
        name: 'Croqueta premium',
        type: 'PRODUCT',
        unit,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown unit', async () => {
    const { errors } = await validateDto({
      name: 'X',
      unit: 'INVALID_UNIT',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('unit');
  });
});

describe('CreateProductDto — serviceDetail (R4)', () => {
  it('accepts a serviceDetail with capacity and notes', async () => {
    const { dto, errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
      serviceDetail: { capacity: 5, notes: 'Recoger en lobby a las 9:00' },
    });
    expect(errors).toHaveLength(0);
    expect(dto.serviceDetail?.capacity).toBe(5);
    expect(dto.serviceDetail?.notes).toBe('Recoger en lobby a las 9:00');
  });

  it('accepts an omitted serviceDetail (no field)', async () => {
    const { dto, errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
    });
    expect(errors).toHaveLength(0);
    expect(dto.serviceDetail).toBeUndefined();
  });

  it('accepts an empty serviceDetail object', async () => {
    const { dto, errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
      serviceDetail: {},
    });
    expect(errors).toHaveLength(0);
    expect(dto.serviceDetail).toBeDefined();
  });

  it('rejects capacity < 1', async () => {
    const { errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
      serviceDetail: { capacity: 0 },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('serviceDetail');
  });

  it('rejects capacity that is not an integer', async () => {
    const { errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
      serviceDetail: { capacity: 1.5 },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('serviceDetail');
  });

  it('rejects notes longer than 500 chars', async () => {
    const { errors } = await validateDto({
      name: 'Paseo de perros',
      type: 'SERVICE',
      serviceDetail: { notes: 'x'.repeat(501) },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('serviceDetail');
  });
});

describe('CreateProductDto — type enum (R1, R8)', () => {
  it('accepts type=SERVICE', async () => {
    const { dto, errors } = await validateDto({
      name: 'Paseo',
      type: 'SERVICE',
    });
    expect(errors).toHaveLength(0);
    expect(dto.type).toBe('SERVICE');
  });

  it('accepts type=PRODUCT', async () => {
    const { dto, errors } = await validateDto({
      name: 'Croqueta',
      type: 'PRODUCT',
    });
    expect(errors).toHaveLength(0);
    expect(dto.type).toBe('PRODUCT');
  });

  it('accepts an omitted type (defaults at service layer)', async () => {
    const { errors } = await validateDto({ name: 'X' });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown type', async () => {
    const { errors } = await validateDto({ name: 'X', type: 'BUNDLE' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('type');
  });
});
