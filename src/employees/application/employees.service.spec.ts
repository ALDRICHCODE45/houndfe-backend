import { EmployeesService } from './employees.service';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmployeeNumberConflictError } from '../domain/errors/employee-number-conflict.error';
import { ManagerSelfReferenceError } from '../domain/errors/manager-self-reference.error';
import { ManagerCycleError } from '../domain/errors/manager-cycle.error';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';

function makeService(opts?: {
  withRuntimeAbility?: { can: jest.Mock };
  clsStore?: { userId?: string; tenantId?: string | null; isSuperAdmin?: boolean };
}) {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    findSubordinates: jest.fn(),
    findManagerIdOf: jest.fn(),
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue({}),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const cls = opts?.clsStore
    ? ({
        get: jest.fn().mockReturnValue(opts.clsStore),
      } as any)
    : undefined;

  const caslAbilityFactory = opts?.withRuntimeAbility
    ? ({
        createForUser: jest.fn().mockResolvedValue(opts.withRuntimeAbility),
      } as any)
    : undefined;

  const service = new EmployeesService(
    employeeRepo,
    tenantPrisma,
    cls,
    caslAbilityFactory,
  );

  return { service, employeeRepo, tenantPrisma, cls, caslAbilityFactory };
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

  describe('manager cycle prevention', () => {
    it('should reject direct self-reference (managerId === id)', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord());

      await expect(
        service.update('emp-1', { managerId: 'emp-1' }),
      ).rejects.toThrow(ManagerSelfReferenceError);
      expect(employeeRepo.update).not.toHaveBeenCalled();
    });

    it('should reject 2-hop cycle: A.manager=B, set B.manager=A', async () => {
      const { service, employeeRepo } = makeService();
      // B exists and A is B's proposed manager target
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ id: 'B', managerId: null }),
      );
      // Walk from A upward: A's manager is B
      employeeRepo.findManagerIdOf
        .mockResolvedValueOnce('B') // A's manager is B
        .mockResolvedValueOnce(null); // B's manager is null (won't reach this)

      // Trying to set B's manager to A. employeeId=B, proposedManagerId=A
      // Walk: start at A -> findManagerIdOf(A) returns B -> B === employeeId(B) -> CYCLE
      await expect(
        service.update('B', { managerId: 'A' }),
      ).rejects.toThrow(ManagerCycleError);
      expect(employeeRepo.update).not.toHaveBeenCalled();
    });

    it('should reject 3-hop cycle: A->B->C, set C.manager=A', async () => {
      const { service, employeeRepo } = makeService();
      // C exists
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ id: 'C', managerId: 'B' }),
      );
      // Walk from A upward: A's manager is B, B's manager is C
      employeeRepo.findManagerIdOf
        .mockResolvedValueOnce('B')  // A's manager is B
        .mockResolvedValueOnce('C'); // B's manager is C -> C === employeeId -> CYCLE

      await expect(
        service.update('C', { managerId: 'A' }),
      ).rejects.toThrow(ManagerCycleError);
      expect(employeeRepo.update).not.toHaveBeenCalled();
    });

    it('should allow valid manager assignment when no cycle exists', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(makeEmployeeRecord({ id: 'A' }));
      employeeRepo.findManagerIdOf.mockResolvedValue(null); // B has no manager
      employeeRepo.update.mockResolvedValue(
        makeEmployeeRecord({ id: 'A', managerId: 'B' }),
      );

      const result = await service.update('A', { managerId: 'B' });

      expect(result.managerId).toBe('B');
      expect(employeeRepo.update).toHaveBeenCalled();
    });

    it('should tolerate defensive iteration cap without infinite loop', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ id: 'emp-1' }),
      );
      // Simulate a very long chain that never hits employeeId
      let counter = 0;
      employeeRepo.findManagerIdOf.mockImplementation(async () => {
        counter++;
        return `manager-${counter}`;
      });
      employeeRepo.update.mockResolvedValue(
        makeEmployeeRecord({ id: 'emp-1', managerId: 'deep-manager' }),
      );

      // Should NOT throw — cap is hit but it allows the write
      const result = await service.update('emp-1', {
        managerId: 'deep-manager',
      });

      expect(result).toBeDefined();
      // findManagerIdOf should have been called exactly 50 times (cap)
      expect(employeeRepo.findManagerIdOf).toHaveBeenCalledTimes(50);
    });

    it('should reject create when managerId points to non-existent employee', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null); // manager does not exist

      await expect(
        service.create({
          employeeNumber: 'EMP-002',
          firstName: 'Carlos',
          lastName: 'Lopez',
          hireDate: '2026-01-15',
          managerId: 'nonexistent',
        }),
      ).rejects.toThrow(EmployeeNotFoundError);
      expect(employeeRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('findSubordinates()', () => {
    it('should return direct subordinates stripped of salary fields', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ id: 'manager-1' }),
      );
      employeeRepo.findSubordinates.mockResolvedValue([
        makeEmployeeRecord({
          id: 'sub-1',
          managerId: 'manager-1',
          currentSalaryCents: 3000000,
        }),
        makeEmployeeRecord({
          id: 'sub-2',
          managerId: 'manager-1',
          currentSalaryCents: 4000000,
        }),
      ]);

      const result = await service.findSubordinates('manager-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sub-1');
      expect(result[1].id).toBe('sub-2');
      // Salary stripped by default (no ability passed)
      expect(result[0].currentSalaryCents).toBeUndefined();
      expect(result[1].currentSalaryCents).toBeUndefined();
    });

    it('should throw EmployeeNotFoundError when employee does not exist', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.findSubordinates('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });
  });

  describe('findManagerChain()', () => {
    it('should return ancestors in order from direct manager up to top', async () => {
      const { service, employeeRepo } = makeService();
      const empC = makeEmployeeRecord({ id: 'C', managerId: 'B' });
      const empB = makeEmployeeRecord({ id: 'B', managerId: 'A' });
      const empA = makeEmployeeRecord({ id: 'A', managerId: null });

      employeeRepo.findById
        .mockResolvedValueOnce(empC)  // initial lookup of C
        .mockResolvedValueOnce(empB)  // lookup B (C's manager)
        .mockResolvedValueOnce(empA); // lookup A (B's manager)

      const result = await service.findManagerChain('C');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('B');
      expect(result[1].id).toBe('A');
    });

    it('should return empty array when employee has no manager', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ id: 'top', managerId: null }),
      );

      const result = await service.findManagerChain('top');

      expect(result).toEqual([]);
    });

    it('should throw EmployeeNotFoundError when employee does not exist', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.findManagerChain('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });
  });

  describe('runtime ability resolution', () => {
    it('should build ability from CLS + factory when no override passed and strip salary if permission missing', async () => {
      const denyingAbility = { can: jest.fn().mockReturnValue(false) };
      const { service, employeeRepo, caslAbilityFactory } = makeService({
        withRuntimeAbility: denyingAbility,
        clsStore: { userId: 'user-1', tenantId: 'tenant-1', isSuperAdmin: false },
      });
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ currentSalaryCents: 5000000 }),
      );

      const result = await service.findOne('emp-1');

      expect(caslAbilityFactory!.createForUser).toHaveBeenCalledWith('user-1', {
        tenantId: 'tenant-1',
        isSuperAdmin: false,
      });
      expect(denyingAbility.can).toHaveBeenCalledWith('read', 'EmployeeSalary');
      expect(result.currentSalaryCents).toBeUndefined();
    });

    it('should keep salary fields when CLS-built ability grants read:EmployeeSalary', async () => {
      const allowingAbility = { can: jest.fn().mockReturnValue(true) };
      const { service, employeeRepo } = makeService({
        withRuntimeAbility: allowingAbility,
        clsStore: { userId: 'user-1', tenantId: 'tenant-1', isSuperAdmin: false },
      });
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({
          currentSalaryCents: 5000000,
          currentSalaryCurrency: 'MXN',
        }),
      );

      const result = await service.findOne('emp-1');

      expect(allowingAbility.can).toHaveBeenCalledWith('read', 'EmployeeSalary');
      expect(result.currentSalaryCents).toBe(5000000);
      expect(result.currentSalaryCurrency).toBe('MXN');
    });

    it('should default to most-restrictive when CLS context lacks userId', async () => {
      const { service, employeeRepo } = makeService({
        clsStore: { isSuperAdmin: false }, // no userId
      });
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ currentSalaryCents: 5000000 }),
      );

      const result = await service.findOne('emp-1');

      expect(result.currentSalaryCents).toBeUndefined();
    });

    it('should prefer explicit ability override over CLS-built one', async () => {
      const clsAbility = { can: jest.fn().mockReturnValue(false) };
      const overrideAbility = { can: jest.fn().mockReturnValue(true) };
      const { service, employeeRepo } = makeService({
        withRuntimeAbility: clsAbility,
        clsStore: { userId: 'user-1', tenantId: 't', isSuperAdmin: false },
      });
      employeeRepo.findById.mockResolvedValue(
        makeEmployeeRecord({ currentSalaryCents: 5000000 }),
      );

      const result = await service.findOne('emp-1', overrideAbility as any);

      expect(overrideAbility.can).toHaveBeenCalledWith('read', 'EmployeeSalary');
      expect(clsAbility.can).not.toHaveBeenCalled();
      expect(result.currentSalaryCents).toBe(5000000);
    });
  });
});
