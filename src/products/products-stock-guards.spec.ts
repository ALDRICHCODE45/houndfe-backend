/**
 * O1 / S2 + S8 HTTP-facing guards of the products module: the whitelist lets a
 * `quantity` key reach the service, the service rejects it before touching any
 * collaborator.
 */
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { InvalidArgumentError } from '../shared/domain/domain-error';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateLotDto } from './dto/lot.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateVariantDto } from './dto/variant.dto';
import { StockQuantityReadOnlyError } from './domain/product-stock.errors';
import { ProductsService } from './products.service';

const transform = (metatype: new () => object, value: unknown) =>
  createAppValidationPipe().transform(value, { type: 'body', metatype });

describe('quantity in PATCH bodies (whitelist)', () => {
  it.each([
    ['product', UpdateProductDto],
    ['variant', UpdateVariantDto],
    ['lot', UpdateLotDto],
  ] as const)(
    'lets quantity through on the %s PATCH DTO so the service can answer STOCK_QUANTITY_READ_ONLY',
    async (_name, dto) => {
      for (const quantity of [5, 0, null, 'abc']) {
        const body = (await transform(dto, { quantity })) as {
          quantity: unknown;
        };
        expect(body.quantity).toBe(quantity);
      }
    },
  );

  it('still rejects unknown keys and keeps validating quantity on create', async () => {
    await expect(transform(UpdateLotDto, { stock: 1 })).rejects.toBeDefined();
    await expect(
      transform(CreateProductDto, { name: 'P', quantity: -1 }),
    ).rejects.toBeDefined();
  });
});

describe('ProductsService rejects direct quantity edits before any collaborator', () => {
  const untouchable = () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error('collaborator must not be touched');
        },
      },
    );
  const service = new ProductsService(
    untouchable() as never,
    untouchable() as never,
    untouchable() as never,
    untouchable() as never,
    untouchable() as never,
    untouchable() as never,
  );

  it.each([
    ['product', () => service.update('p', { quantity: 1 } as never)],
    [
      'variant',
      () => service.updateVariant('p', 'v', { quantity: null } as never),
    ],
    ['lot', () => service.updateLot('p', 'l', { quantity: 0 } as never)],
  ])('%s PATCH carrying quantity', async (_name, call) => {
    const error: unknown = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockQuantityReadOnlyError);
    expect(error).toBeInstanceOf(InvalidArgumentError); // => 400 envelope
    expect(error).toMatchObject({ code: 'STOCK_QUANTITY_READ_ONLY' });
  });
});
