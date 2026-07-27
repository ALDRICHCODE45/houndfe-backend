import { EmployeesController } from './employees.controller';
import { EmployeesService } from './application/employees.service';
import { RequestMethod } from '@nestjs/common';
import type { BatchDeleteOrchestrator } from '../shared/batch-delete';
import { BatchDeleteDto } from '../shared/batch-delete';
import 'reflect-metadata';

function buildController() {
  const employeesService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    terminate: jest.fn(),
    reactivate: jest.fn(),
    findSubordinates: jest.fn(),
    findManagerChain: jest.fn(),
  } as unknown as jest.Mocked<EmployeesService>;

  const batchDeleteOrchestrator = {
    execute: jest.fn().mockResolvedValue({ deleted: 4 }),
  } as unknown as jest.Mocked<BatchDeleteOrchestrator>;

  const controller = new EmployeesController(
    employeesService,
    batchDeleteOrchestrator,
  );
  return { controller, employeesService, batchDeleteOrchestrator };
}

describe('EmployeesController', () => {
  describe('DELETE /admin/employees/:id', () => {
    it('should be decorated with @Delete(":id")', () => {
      const removeHandler = EmployeesController.prototype.remove;
      const path = Reflect.getMetadata('path', removeHandler);
      const method = Reflect.getMetadata('method', removeHandler);
      expect(method).toBe(RequestMethod.DELETE);
      expect(path).toBe(':id');
    });

    it('should be decorated with @HttpCode(204)', () => {
      const removeHandler = EmployeesController.prototype.remove;
      const statusCode = Reflect.getMetadata(
        '__httpCode__',
        removeHandler,
      );
      expect(statusCode).toBe(204);
    });

    it('should call service.remove with the parsed UUID id', async () => {
      const { controller, employeesService } = buildController();
      employeesService.remove.mockResolvedValue(undefined);

      await controller.remove('emp-uuid-1');

      expect(employeesService.remove).toHaveBeenCalledWith('emp-uuid-1');
      expect(employeesService.remove).toHaveBeenCalledTimes(1);
    });

    it('should declare a single string parameter for the id', () => {
      const removeHandler = EmployeesController.prototype.remove;
      // Function arity check: remove(id: string) — exactly one parameter.
      expect(removeHandler.length).toBe(1);
    });

    it('should propagate service.remove errors (e.g. EmployeeNotFoundError → 404 via exception filter)', async () => {
      const { controller, employeesService } = buildController();
      employeesService.remove.mockRejectedValue(new Error('not found'));

      await expect(controller.remove('emp-1')).rejects.toThrow('not found');
    });
  });

  describe('POST /admin/employees/batch-delete', () => {
    it('should be decorated with @Post("batch-delete")', () => {
      const batchDeleteHandler = EmployeesController.prototype.batchDelete;
      const path = Reflect.getMetadata('path', batchDeleteHandler);
      const method = Reflect.getMetadata('method', batchDeleteHandler);
      expect(method).toBe(RequestMethod.POST);
      expect(path).toBe('batch-delete');
    });

    it('should be decorated with @HttpCode(200)', () => {
      const batchDeleteHandler = EmployeesController.prototype.batchDelete;
      const statusCode = Reflect.getMetadata(
        '__httpCode__',
        batchDeleteHandler,
      );
      expect(statusCode).toBe(200);
    });

    it('should declare a single dto parameter (body)', () => {
      const batchDeleteHandler = EmployeesController.prototype.batchDelete;
      // batchDelete(dto: BatchDeleteDto) — exactly one parameter.
      expect(batchDeleteHandler.length).toBe(1);
    });

    it('should delegate to BatchDeleteOrchestrator.execute with dto.ids', async () => {
      const { controller, batchDeleteOrchestrator } = buildController();
      const dto: BatchDeleteDto = {
        ids: [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
        ],
      };

      const result = await controller.batchDelete(dto);

      expect(result).toEqual({ deleted: 4 });
      expect(batchDeleteOrchestrator.execute).toHaveBeenCalledWith(dto.ids);
      expect(batchDeleteOrchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it('should propagate orchestrator errors (e.g. BatchDeleteValidationError)', async () => {
      const { controller, batchDeleteOrchestrator } = buildController();
      const boom = new Error('orchestrator boom');
      (batchDeleteOrchestrator.execute as jest.Mock).mockRejectedValueOnce(boom);

      await expect(
        controller.batchDelete({
          ids: ['00000000-0000-4000-8000-000000000001'],
        }),
      ).rejects.toBe(boom);
    });
  });
});