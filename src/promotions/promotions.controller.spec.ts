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
import type { BatchDeleteOrchestrator } from '../shared/batch-delete';
import { BatchDeleteDto } from '../shared/batch-delete';

type MockPromotionsService = {
  create: jest.MockedFunction<PromotionsService['create']>;
  findAll: jest.MockedFunction<PromotionsService['findAll']>;
  findOne: jest.MockedFunction<PromotionsService['findOne']>;
  update: jest.MockedFunction<PromotionsService['update']>;
  remove: jest.MockedFunction<PromotionsService['remove']>;
  endPromotion: jest.MockedFunction<PromotionsService['endPromotion']>;
  batchEnd: jest.MockedFunction<PromotionsService['batchEnd']>;
  batchActivate: jest.MockedFunction<PromotionsService['batchActivate']>;
};

function makeService(): MockPromotionsService {
  return {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    endPromotion: jest.fn(),
    batchEnd: jest.fn(),
    batchActivate: jest.fn(),
  };
}

function makeOrchestrator(): jest.Mocked<
  Pick<BatchDeleteOrchestrator, 'execute'>
> {
  return {
    execute: jest.fn().mockResolvedValue({ deleted: 7 }),
  };
}

describe('PromotionsController', () => {
  let controller: PromotionsController;
  let service: MockPromotionsService;
  let orchestrator: jest.Mocked<Pick<BatchDeleteOrchestrator, 'execute'>>;

  beforeEach(() => {
    service = makeService();
    orchestrator = makeOrchestrator();
    controller = new PromotionsController(
      service as unknown as PromotionsService,
      orchestrator as unknown as BatchDeleteOrchestrator,
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

  it('batchDelete() delegates to BatchDeleteOrchestrator.execute with dto.ids', async () => {
    const dto: BatchDeleteDto = {
      ids: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    };

    const result = await controller.batchDelete(dto);

    expect(result).toEqual({ deleted: 7 });
    expect(orchestrator.execute).toHaveBeenCalledWith(dto.ids);
  });

  it('batchDelete() propagates errors from the orchestrator', async () => {
    const boom = new Error('orchestrator boom');
    orchestrator.execute.mockRejectedValueOnce(boom);

    await expect(
      controller.batchDelete({ ids: ['00000000-0000-4000-8000-000000000001'] }),
    ).rejects.toBe(boom);
  });

  // ==================== batchActivate ====================

  it('batchActivate() delegates to service.batchActivate with dto.ids', async () => {
    const dto: BatchDeleteDto = {
      ids: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    };
    service.batchActivate.mockResolvedValue({ activated: 2 });

    const result = await controller.batchActivate(dto);

    expect(result).toEqual({ activated: 2 });
    expect(service.batchActivate).toHaveBeenCalledWith(dto.ids);
    expect(service.batchActivate).toHaveBeenCalledTimes(1);
  });

  // ==================== batchEnd ====================

  it('batchEnd() delegates to service.batchEnd with dto.ids', async () => {
    const dto: BatchDeleteDto = {
      ids: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    };
    service.batchEnd.mockResolvedValue({ ended: 2 });

    const result = await controller.batchEnd(dto);

    expect(result).toEqual({ ended: 2 });
    expect(service.batchEnd).toHaveBeenCalledWith(dto.ids);
    expect(service.batchEnd).toHaveBeenCalledTimes(1);
  });

  it('batchEnd() propagates service errors', async () => {
    const boom = new Error('service boom');
    service.batchEnd.mockRejectedValueOnce(boom);

    await expect(
      controller.batchEnd({ ids: ['00000000-0000-4000-8000-000000000001'] }),
    ).rejects.toBe(boom);
  });
});
