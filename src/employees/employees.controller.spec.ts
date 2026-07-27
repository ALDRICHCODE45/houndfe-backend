import { EmployeesController } from './employees.controller';
import { EmployeesService } from './application/employees.service';
import { RequestMethod } from '@nestjs/common';
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

  const controller = new EmployeesController(employeesService);
  return { controller, employeesService };
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
});