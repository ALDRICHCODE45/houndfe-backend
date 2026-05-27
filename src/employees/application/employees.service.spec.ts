import { EmployeesService } from './employees.service';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmployeeNumberConflictError } from '../domain/errors/employee-number-conflict.error';
import { ManagerSelfReferenceError } from '../domain/errors/manager-self-reference.error';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue({}),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const service = new EmployeesService(employeeRepo, tenantPrisma);

  return { service, employeeRepo, tenantPrisma };
}

const now = new Date('2026-01-15T00:00:00Z');

function makeEmployeeRecord(overrides: Partial<any> = {}) {
  return {
    id: 'emp-1',
    employeeNumber: 'EMP-001',
    firstName: 'Ana',
    lastName: 'Garcia',
    email: null,
    phone: null,
    dateOfBirth: null,
    nationalId: null,
    nationalIdType: null,
    photoFileId: null,
    cvFileId: null,
    street: null,
    exteriorNumber: null,
    interiorNumber: null,
    zipCode: null,
    neighborhood: null,
    municipality: null,
    city: null,
    state: null,
    hireDate: now,
    terminationDate: null,
    terminationReason: null,
    status: 'ACTIVE',
    currentPosition: null,
    currentDepartment: null,
    currentSalaryCents: null,
    currentSalaryCurrency: 'MXN',
    currentResponsibilities: null,
    currentSchedule: null,
    contractType: 'PERMANENT',
    workModality: 'ONSITE',
    annualVacationDays: 0,
    managerId: null,
    tenantId: 'tenant-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('EmployeesService', () => {
  describe('create()', () => {
    it('should create an employee with status ACTIVE and return response', async () => {
      const { service, employeeRepo, tenantPrisma } = makeService();
      const created = makeEmployeeRecord();
      employeeRepo.create.mockResolvedValue(created);

      const result = await service.create({
        employeeNumber: 'EMP-001',
        firstName: 'Ana',
        lastName: 'Garcia',
        hireDate: '2026-01-15',
      });

      expect(result.employeeNumber).toBe('EMP-001');
      expect(result.firstName).toBe('Ana');
      expect(result.lastName).toBe('Garcia');
      expect(result.status).toBe('ACTIVE');
      expect(employeeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeNumber: 'EMP-001',
          firstName: 'Ana',
          lastName: 'Garcia',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should throw EmployeeNumberConflictError on duplicate within tenant', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.create.mockRejectedValue(
        new EmployeeNumberConflictError('EMP-001'),
      );

      await expect(
        service.create({
          employeeNumber: 'EMP-001',
          firstName: 'Carlos',
          lastName: 'Lopez',
          hireDate: '2026-01-15',
        }),
      ).rejects.toThrow(EmployeeNumberConflictError);
    });
  });

  describe('findOne()', () => {
    it('should return employee when found and strip salary by default', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ currentSalaryCents: 5000000 }),
      );

      const result = await service.findOne('emp-1');

      expect(result.id).toBe('emp-1');
      expect(result.currentSalaryCents).toBeUndefined();
      expect(result.currentSalaryCurrency).toBeUndefined();
    });

    it('should throw EmployeeNotFoundError when not found', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });

    it('should keep salary fields when ability allows read:EmployeeSalary', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({
          currentSalaryCents: 5000000,
          currentSalaryCurrency: 'MXN',
        }),
      );
      const ability = { can: jest.fn().mockReturnValue(true) } as any;

      const result = await service.findOne('emp-1', ability);

      expect(result.currentSalaryCents).toBe(5000000);
      expect(result.currentSalaryCurrency).toBe('MXN');
      expect(ability.can).toHaveBeenCalledWith('read', 'EmployeeSalary');
    });
  });

  describe('update()', () => {
    it('should reject when managerId equals the employee id (self-reference)', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord());

      await expect(
        service.update('emp-1', { managerId: 'emp-1' }),
      ).rejects.toThrow(ManagerSelfReferenceError);
      expect(employeeRepo.update).not.toHaveBeenCalled();
    });

    it('should patch only provided fields', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord());
      employeeRepo.update.mockResolvedValue(
        makeEmployeeRecord({ firstName: 'Ana Maria' }),
      );

      const result = await service.update('emp-1', { firstName: 'Ana Maria' });

      expect(employeeRepo.update).toHaveBeenCalledWith(
        'emp-1',
        expect.objectContaining({ firstName: 'Ana Maria' }),
      );
      expect(result.firstName).toBe('Ana Maria');
    });

    it('should throw EmployeeNotFoundError when target does not exist', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(
        service.update('missing', { firstName: 'X' }),
      ).rejects.toThrow(EmployeeNotFoundError);
    });
  });

  describe('terminate()', () => {
    it('should set status TERMINATED with date and reason', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord());
      employeeRepo.update.mockResolvedValue(
        makeEmployeeRecord({
          status: 'TERMINATED',
          terminationDate: new Date('2026-06-30'),
          terminationReason: 'Resignation',
        }),
      );

      const result = await service.terminate('emp-1', {
        terminationDate: '2026-06-30',
        terminationReason: 'Resignation',
      });

      expect(employeeRepo.update).toHaveBeenCalledWith(
        'emp-1',
        expect.objectContaining({
          status: 'TERMINATED',
          terminationReason: 'Resignation',
        }),
      );
      expect(result.status).toBe('TERMINATED');
    });

    it('should reject when already terminated', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ status: 'TERMINATED' }),
      );

      await expect(
        service.terminate('emp-1', {
          terminationDate: '2026-06-30',
          terminationReason: 'X',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });
  });

  describe('reactivate()', () => {
    it('should clear terminationDate and set status ACTIVE', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({
          status: 'TERMINATED',
          terminationDate: new Date('2026-06-30'),
          terminationReason: 'Resignation',
        }),
      );
      employeeRepo.update.mockResolvedValue(makeEmployeeRecord());

      const result = await service.reactivate('emp-1');

      expect(employeeRepo.update).toHaveBeenCalledWith('emp-1', {
        status: 'ACTIVE',
        terminationDate: null,
        terminationReason: null,
      });
      expect(result.status).toBe('ACTIVE');
    });

    it('should reject when employee is not terminated', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord());

      await expect(service.reactivate('emp-1')).rejects.toThrow(
        BusinessRuleViolationError,
      );
    });
  });

  describe('findAll()', () => {
    it('should default to active status and apply pagination defaults', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findAll.mockResolvedValue({
        data: [makeEmployeeRecord()],
        total: 1,
        page: 1,
        limit: 20,
      });

      const result = await service.findAll({});

      expect(employeeRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
          page: 1,
          limit: 20,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.data[0].currentSalaryCents).toBeUndefined();
    });
  });
});
