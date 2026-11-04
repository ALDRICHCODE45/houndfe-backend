import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { assertNoDirectQuantityEdit } from './domain/product-stock.errors';
import { UpdateLotDto } from './dto/lot.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateVariantDto } from './dto/variant.dto';

/**
 * O1/S2 regression: the guard must see the DTO instance the global
 * ValidationPipe produces, where an optional class field may exist as an own
 * `undefined` property even when the JSON body has no `quantity` key.
 */
describe('direct quantity edits through the app ValidationPipe', () => {
  const pipe = createAppValidationPipe();
  const cases = [
    ['product', UpdateProductDto, { minQuantity: 5 }],
    ['variant', UpdateVariantDto, { minQuantity: 2 }],
    ['lot', UpdateLotDto, { expirationDate: '2027-06-30' }],
  ] as const;

  async function transform(metatype: unknown, body: object): Promise<object> {
    return (await pipe.transform(body, {
      type: 'body',
      metatype: metatype as never,
    })) as object;
  }

  it.each(cases)(
    'accepts a %s PATCH body without a quantity key',
    async (resource, metatype, body) => {
      const dto = await transform(metatype, body);
      expect(() => assertNoDirectQuantityEdit(dto, resource)).not.toThrow();
    },
  );

  it.each(cases)(
    'rejects a %s PATCH body carrying quantity, even null or 0',
    async (resource, metatype, body) => {
      for (const quantity of [null, 0, 7]) {
        const dto = await transform(metatype, { ...body, quantity });
        let thrown: unknown;
        try {
          assertNoDirectQuantityEdit(dto, resource);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'STOCK_QUANTITY_READ_ONLY' });
      }
    },
  );
});
