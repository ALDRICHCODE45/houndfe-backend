/**
 * PromotionsController — unit tests.
 * Tests that controller delegates correctly to the service.
 */
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { PromotionQueryDto } from './dto/promotion-query.dto';
import {
  PromotionTypeEnum,
  CreatePromotionDto,
  PromotionMethodEnum,
} from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

type MockPromotionsService = {
  create: jest.MockedFunction<PromotionsService['create']>;
  findAll: jest.MockedFunction<PromotionsService['findAll']>;
  findOne: jest.MockedFunction<PromotionsService['findOne']>;
  update: jest.MockedFunction<PromotionsService['update']>;
  remove: jest.MockedFunction<PromotionsService['remove']>;
  endPromotion: jest.MockedFunction<PromotionsService['endPromotion']>;
};

function makeService(): MockPromotionsService {
  return {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    endPromotion: jest.fn(),
  };
}

describe('PromotionsController', () => {
  let controller: PromotionsController;
  let service: MockPromotionsService;

  beforeEach(() => {
    service = makeService();
    controller = new PromotionsController(
      service as unknown as PromotionsService,
    );
  });

  it('create() should call service.create with dto', async () => {
    const dto: CreatePromotionDto = {
      title: 'Test',
      type: PromotionTypeEnum.PRODUCT_DISCOUNT,
      method: PromotionMethodEnum.AUTOMATIC,
    };
    const expected = { id: 'promo-1', title: 'Test' };
    service.create.mockResolvedValue(
      expected as Awaited<ReturnType<PromotionsService['create']>>,
    );

    const result = await controller.create(dto);

    expect(service.create.mock.calls[0][0]).toEqual(dto);
    expect(result).toEqual(expected);
  });

  it('findAll() should call service.findAll with query', async () => {
    const query: PromotionQueryDto = { page: 1, limit: 10 };
    const expected = {
      data: [],
      meta: { page: 1, limit: 10, total: 0, totalPages: 0 },
    };
    service.findAll.mockResolvedValue(
      expected as Awaited<ReturnType<PromotionsService['findAll']>>,
    );

    const result = await controller.findAll(query);

    expect(service.findAll.mock.calls[0][0]).toEqual(query);
    expect(result).toEqual(expected);
  });

  it('findOne() should call service.findOne with id', async () => {
    const expected = { id: 'promo-1' };
    service.findOne.mockResolvedValue(
      expected as Awaited<ReturnType<PromotionsService['findOne']>>,
    );

    const result = await controller.findOne('promo-1');

    expect(service.findOne.mock.calls[0][0]).toBe('promo-1');
    expect(result).toEqual(expected);
  });

  it('update() should call service.update with id and dto', async () => {
    const dto: UpdatePromotionDto = { title: 'Updated' };
    const expected = { id: 'promo-1', title: 'Updated' };
    service.update.mockResolvedValue(
      expected as Awaited<ReturnType<PromotionsService['update']>>,
    );

    const result = await controller.update('promo-1', dto);

    expect(service.update.mock.calls[0]).toEqual(['promo-1', dto]);
    expect(result).toEqual(expected);
  });

  it('remove() should call service.remove with id', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('promo-1');

    expect(service.remove.mock.calls[0][0]).toBe('promo-1');
  });

  it('endPromotion() should call service.endPromotion with id', async () => {
    const expected = { id: 'promo-1', status: 'ENDED' };
    service.endPromotion.mockResolvedValue(
      expected as Awaited<ReturnType<PromotionsService['endPromotion']>>,
    );

    const result = await controller.endPromotion('promo-1');

    expect(service.endPromotion.mock.calls[0][0]).toBe('promo-1');
    expect(result).toEqual(expected);
  });
});
