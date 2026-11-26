/**
 * customers-listing T4 (S3, contract §6.1, §11) — `isTrusted` on
 * `PATCH /customers/:id`: only a JSON boolean, absent = unchanged, and only
 * on the update DTO (`POST /customers` keeps creating with the default).
 * Runs the production pipe so the 400 body is the standard per-field one.
 */
import type { Type } from '@nestjs/common';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { CreateCustomerDto } from './create-customer.dto';
import { UpdateCustomerDto } from './update-customer.dto';

const pipe = createAppValidationPipe();
const validateBody = (value: unknown, metatype: Type<unknown>) =>
  pipe.transform(value, { type: 'body', metatype });

describe('UpdateCustomerDto isTrusted (customers-listing T4)', () => {
  it.each([true, false])('accepts the JSON boolean %s', async (isTrusted) => {
    await expect(
      validateBody({ isTrusted }, UpdateCustomerDto),
    ).resolves.toEqual({ isTrusted });
  });

  it('absent → valid and left undefined (unchanged)', async () => {
    const dto = (await validateBody(
      { firstName: 'Ana' },
      UpdateCustomerDto,
    )) as UpdateCustomerDto;
    expect(dto).toEqual({ firstName: 'Ana' });
    expect(dto.isTrusted).toBeUndefined();
  });

  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['null', null],
    ['an object', {}],
  ])('rejects %s with the per-field 400 body', async (_label, isTrusted) => {
    await expect(
      validateBody({ isTrusted }, UpdateCustomerDto),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        statusCode: 400,
        message: [
          {
            property: 'isTrusted',
            constraints: {
              isBoolean: 'isTrusted must be a boolean value',
            },
          },
        ],
      },
    });
  });

  it('POST /customers does not accept isTrusted (unknown property → 400)', async () => {
    await expect(
      validateBody({ firstName: 'Ana', isTrusted: true }, CreateCustomerDto),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('regression: the other PATCH fields validate as before', async () => {
    await expect(
      validateBody(
        { firstName: 'Ana', fiscalRegime: '612', comments: 'nota' },
        UpdateCustomerDto,
      ),
    ).resolves.toEqual({
      firstName: 'Ana',
      fiscalRegime: '612',
      comments: 'nota',
    });
    await expect(
      validateBody({ fiscalRegime: '999' }, UpdateCustomerDto),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validateBody({ addresses: [] }, UpdateCustomerDto),
    ).rejects.toMatchObject({ status: 400 });
  });
});
