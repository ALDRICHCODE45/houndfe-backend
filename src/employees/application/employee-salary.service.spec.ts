import { EmployeeSalaryService } from './employee-salary.service';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const salaryHistoryCreate = jest.fn();
  const salaryHistoryFindMany = jest.fn();
  const employeeUpdate = jest.fn();
  const $transaction = jest.fn();

  const prismaClient = {
    employeeSalaryHistory: {
      create: salaryHistoryCreate,
      findMany: salaryHistoryFindMany,
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

  const service = new EmployeeSalaryService(employeeRepo, tenantPrisma);

  return {
    service,
    employeeRepo,
    tenantPrisma,
    prismaClient,
    salaryHistoryCreate,
    salaryHistoryFindMany,
    employeeUpdate,
    $transaction,
  };
}

describe('EmployeeSalaryService', () => {
  describe('addSalaryChange()', () => {
    it('should throw EmployeeNotFoundError when employee not found', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(
        service.addSalaryChange('missing', {
          amountCents: 60000,
          effectiveFrom: '2026-06-01',
          reason: 'Annual raise',
        }, 'user-1'),
      ).rejects.toThrow(EmployeeNotFoundError);
    });

    it('should persist history row AND update Employee.currentSalaryCents in single transaction', async () => {
      const { service, employeeRepo, $transaction } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1', tenantId: 'tenant-1' });

      const historyRow = { id: 'hist-1', amountCents: 60000, currency: 'MXN' };
      $transaction.mockResolvedValue([historyRow, {}]);

      const result = await service.addSalaryChange('emp-1', {
        amountCents: 60000,
        effectiveFrom: '2026-06-01',
        reason: 'Annual raise',
      }, 'user-1');

      expect($transaction).toHaveBeenCalledTimes(1);
      const txArgs = $transaction.mock.calls[0][0];
      expect(txArgs).toHaveLength(2); // history create + employee update
      expect(result).toEqual(historyRow);
    });

    it('should default currency to MXN when not provided', async () => {
      const { service, employeeRepo, $transaction, prismaClient } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1', tenantId: 'tenant-1' });

      const historyRow = { id: 'hist-1', amountCents: 50000, currency: 'MXN' };
      $transaction.mockResolvedValue([historyRow, {}]);

      await service.addSalaryChange('emp-1', {
        amountCents: 50000,
        effectiveFrom: '2026-06-01',
        reason: 'New hire',
      }, 'user-1');

      // Verify the create call uses MXN
      expect(prismaClient.employeeSalaryHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ currency: 'MXN' }),
      });
    });
  });

  describe('listSalaryHistory()', () => {
    it('should return rows ordered by effectiveFrom desc', async () => {
      const { service, employeeRepo, salaryHistoryFindMany } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });

      const rows = [
        { id: 'h2', effectiveFrom: new Date('2026-06-01'), amountCents: 60000 },
        { id: 'h1', effectiveFrom: new Date('2026-01-01'), amountCents: 50000 },
      ];
      salaryHistoryFindMany.mockResolvedValue(rows);

      const result = await service.listSalaryHistory('emp-1');

      expect(salaryHistoryFindMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
        orderBy: { effectiveFrom: 'desc' },
      });
      expect(result).toEqual(rows);
    });

    it('should throw EmployeeNotFoundError when employee does not exist', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.listSalaryHistory('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });
  });
});
