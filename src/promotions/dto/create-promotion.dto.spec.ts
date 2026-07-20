import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  CreatePromotionDto,
  PromotionMethodEnum,
  PromotionTypeEnum,
} from './create-promotion.dto';

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
