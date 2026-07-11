import { EmployeePositionService } from './employee-position.service';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const positionHistoryCreate = jest.fn();
  const positionHistoryFindMany = jest.fn();
  const employeeUpdate = jest.fn();
  const $transaction = jest.fn();

  const prismaClient = {
    employeePositionHistory: {
      create: positionHistoryCreate,
      findMany: positionHistoryFindMany,
    },
    employee: {
      update: employeeUpdate,
    },
    $transaction,
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(prismaClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const service = new EmployeePositionService(employeeRepo, tenantPrisma);

  return {
    service,
    employeeRepo,
    tenantPrisma,
    prismaClient,
    positionHistoryCreate,
    positionHistoryFindMany,
    employeeUpdate,
    $transaction,
  };
}

describe('EmployeePositionService', () => {
  describe('addPositionChange()', () => {
    it('should throw EmployeeNotFoundError when employee not found', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(
        service.addPositionChange(
          'missing',
          {
            position: 'Senior Dev',
            effectiveFrom: '2026-06-01',
            reason: 'Promotion',
          },
          'user-1',
        ),
      ).rejects.toThrow(EmployeeNotFoundError);
    });

    it('should persist history + update Employee.currentPosition AND currentDepartment in single transaction', async () => {
      const { service, employeeRepo, $transaction } = makeService();
      employeeRepo.findById.mockResolvedValue({
        id: 'emp-1',
        tenantId: 'tenant-1',
      });

      const historyRow = {
        id: 'hist-1',
        position: 'Senior Dev',
        department: 'Engineering',
      };
      $transaction.mockResolvedValue([historyRow, {}]);

      const result = await service.addPositionChange(
        'emp-1',
        {
          position: 'Senior Dev',
          department: 'Engineering',
          effectiveFrom: '2026-06-01',
          reason: 'Promotion',
        },
        'user-1',
      );

      expect($transaction).toHaveBeenCalledTimes(1);
      const txArgs = $transaction.mock.calls[0][0];
      expect(txArgs).toHaveLength(2); // history create + employee update
      expect(result).toEqual(historyRow);
    });

    it('should handle null department correctly', async () => {
      const { service, employeeRepo, $transaction, prismaClient } =
        makeService();
      employeeRepo.findById.mockResolvedValue({
        id: 'emp-1',
        tenantId: 'tenant-1',
      });

      const historyRow = {
        id: 'hist-2',
        position: 'Manager',
        department: null,
      };
      $transaction.mockResolvedValue([historyRow, {}]);

      await service.addPositionChange(
        'emp-1',
        {
          position: 'Manager',
          effectiveFrom: '2026-06-01',
          reason: 'Restructure',
        },
        'user-1',
      );

      expect(prismaClient.employee.update).toHaveBeenCalledWith({
        where: { id: 'emp-1' },
        data: expect.objectContaining({
          currentPosition: 'Manager',
          currentDepartment: null,
        }),
      });
    });
  });

  describe('listPositionHistory()', () => {
    it('should return rows ordered by effectiveFrom desc', async () => {
      const { service, employeeRepo, positionHistoryFindMany } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });

      const rows = [
        {
          id: 'h2',
          effectiveFrom: new Date('2026-06-01'),
          position: 'Senior Dev',
        },
        {
          id: 'h1',
          effectiveFrom: new Date('2026-01-01'),
          position: 'Junior Dev',
        },
      ];
      positionHistoryFindMany.mockResolvedValue(rows);

      const result = await service.listPositionHistory('emp-1');

      expect(positionHistoryFindMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
        orderBy: { effectiveFrom: 'desc' },
      });
      expect(result).toEqual(rows);
    });

    it('should throw EmployeeNotFoundError when employee does not exist', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.listPositionHistory('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });
  });
});
