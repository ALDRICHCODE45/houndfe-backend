import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreatePromotionDto,
  DiscountTypeEnum,
  PromotionMethodEnum,
  PromotionTypeEnum,
} from './create-promotion.dto';
import { MAX_PRODUCT_UNITS } from '../domain/promotion.entity';

function makeDto(
  type: PromotionTypeEnum,
  getDiscountPercent: number,
): CreatePromotionDto {
  const dto = new CreatePromotionDto();
  dto.title = 'Percent boundary';
  dto.type = type;
  dto.method = PromotionMethodEnum.AUTOMATIC;
  dto.buyQuantity = 2;
  dto.getQuantity = 1;
  dto.getDiscountPercent = getDiscountPercent;
  return dto;
}

describe('CreatePromotionDto BUY_X_GET_Y getDiscountPercent', () => {
  it('accepts BUY_X_GET_Y at 100 percent', async () => {
    const errors = await validate(makeDto(PromotionTypeEnum.BUY_X_GET_Y, 100));

    expect(errors).toHaveLength(0);
  });

  it('rejects BUY_X_GET_Y above 100 percent', async () => {
    const errors = await validate(makeDto(PromotionTypeEnum.BUY_X_GET_Y, 101));

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'getDiscountPercent' }),
      ]),
    );
  });
});

// ============================================================
// maxProductUnits — optional/nullable capacity request field.
// Options mirror the global ValidationPipe in `src/main.ts`:
// `whitelist: true`, `forbidNonWhitelisted: true`.
// ============================================================
describe('CreatePromotionDto maxProductUnits', () => {
  function basePayload(): Record<string, unknown> {
    return {
      title: 'Capacity',
      type: PromotionTypeEnum.ORDER_DISCOUNT,
      method: PromotionMethodEnum.AUTOMATIC,
      discountType: DiscountTypeEnum.PERCENTAGE,
      discountValue: 10,
    };
  }

  function validatePayload(
    payload: Record<string, unknown>,
  ): ReturnType<typeof validate> {
    const dto = plainToInstance(CreatePromotionDto, payload);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('accepts the shared capacity maximum', async () => {
    const errors = await validatePayload({
      ...basePayload(),
      maxProductUnits: MAX_PRODUCT_UNITS,
    });

    expect(errors).toHaveLength(0);
  });

  it('accepts null to mean unlimited', async () => {
    const errors = await validatePayload({
      ...basePayload(),
      maxProductUnits: null,
    });

    expect(errors).toHaveLength(0);
  });

  it.each([0, -1, 1.5, MAX_PRODUCT_UNITS + 1])(
    'rejects maxProductUnits=%p',
    async (value) => {
      const errors = await validatePayload({
        ...basePayload(),
        maxProductUnits: value,
      });

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'maxProductUnits' }),
        ]),
      );
    },
  );

  it('rejects consumedProductUnits as a non-whitelisted request field', async () => {
    const errors = await validatePayload({
      ...basePayload(),
      maxProductUnits: 10,
      consumedProductUnits: 5,
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'consumedProductUnits' }),
      ]),
    );
  });
});
