import { EmployeeTimeOffService } from './employee-time-off.service';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { TimeOffNotFoundError } from '../domain/errors/time-off-not-found.error';
import { TimeOffInvalidTransitionError } from '../domain/errors/time-off-invalid-transition.error';
import { TimeOffInvalidDateRangeError } from '../domain/errors/time-off-invalid-date-range.error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const timeOffCreate = jest.fn();
  const timeOffFindFirst = jest.fn();
  const timeOffFindMany = jest.fn();
  const timeOffCount = jest.fn();
  const timeOffUpdate = jest.fn();
  const employeeFindMany = jest.fn();
  const employeeFindFirst = jest.fn();

  const prismaClient = {
    employeeTimeOff: {
      create: timeOffCreate,
      findFirst: timeOffFindFirst,
      findMany: timeOffFindMany,
      count: timeOffCount,
      update: timeOffUpdate,
    },
    employee: {
      findMany: employeeFindMany,
      findFirst: employeeFindFirst,
    },
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(prismaClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const service = new EmployeeTimeOffService(employeeRepo, tenantPrisma);

  return {
    service,
    employeeRepo,
    tenantPrisma,
    prismaClient,
    timeOffCreate,
    timeOffFindFirst,
    timeOffFindMany,
    timeOffCount,
    timeOffUpdate,
    employeeFindMany,
    employeeFindFirst,
  };
}

function makeServiceWithCls(opts: {
  abilityCanResult: boolean;
  userId?: string | null;
}) {
  const base = makeService();
  const ability = { can: jest.fn().mockReturnValue(opts.abilityCanResult) };
  const cls = {
    get: jest.fn().mockReturnValue(
      opts.userId === null
        ? { isSuperAdmin: false }
        : {
            userId: opts.userId ?? 'user-1',
            tenantId: 'tenant-1',
            isSuperAdmin: false,
          },
    ),
  } as any;
  const caslAbilityFactory = {
    createForUser: jest.fn().mockResolvedValue(ability),
  } as any;
  const service = new EmployeeTimeOffService(
    base.employeeRepo,
    base.tenantPrisma,
    cls,
    caslAbilityFactory,
  );
  return { ...base, service, ability, cls, caslAbilityFactory };
}

const mockEmployee = {
  id: 'emp-1',
  tenantId: 'tenant-1',
  annualVacationDays: 15,
  managerId: null,
};

describe('EmployeeTimeOffService', () => {
  // ============================================================
  // request()
  // ============================================================
  describe('request()', () => {
    it('should throw EmployeeNotFoundError when employee missing', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(
        service.request('missing', {
          type: 'VACATION' as any,
          startDate: '2026-07-01',
          endDate: '2026-07-05',
        }),
      ).rejects.toThrow(EmployeeNotFoundError);
    });

    it('should throw TimeOffInvalidDateRangeError when endDate < startDate', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);

      await expect(
        service.request('emp-1', {
          type: 'VACATION' as any,
          startDate: '2026-07-05',
          endDate: '2026-07-01',
        }),
      ).rejects.toThrow(TimeOffInvalidDateRangeError);
    });

    it('should persist with status PENDING and correct fields', async () => {
      const { service, employeeRepo, timeOffCreate } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);

      const createdRow = {
        id: 'to-1',
        employeeId: 'emp-1',
        type: 'VACATION',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-07-05'),
        reason: 'Family trip',
        status: 'PENDING',
        requestedByUserId: 'user-1',
        tenantId: 'tenant-1',
      };
      timeOffCreate.mockResolvedValue(createdRow);

      const result = await service.request(
        'emp-1',
        {
          type: 'VACATION' as any,
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          reason: 'Family trip',
        },
        'user-1',
      );

      expect(timeOffCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          employeeId: 'emp-1',
          type: 'VACATION',
          status: 'PENDING',
          reason: 'Family trip',
          requestedByUserId: 'user-1',
          tenantId: 'tenant-1',
        }),
      });
      expect(result).toEqual(createdRow);
    });
  });

  // ============================================================
  // review()
  // ============================================================
  describe('review()', () => {
    it('should throw TimeOffNotFoundError when row not owned by employee', async () => {
      const { service, timeOffFindFirst } = makeService();
      timeOffFindFirst.mockResolvedValue(null);

      await expect(
        service.review(
          'emp-1',
          'to-wrong',
          { decision: 'APPROVED' as any },
          'reviewer-1',
        ),
      ).rejects.toThrow(TimeOffNotFoundError);
    });

    it('should throw TimeOffInvalidTransitionError when status is not PENDING', async () => {
      const { service, timeOffFindFirst } = makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'APPROVED',
      });

      await expect(
        service.review(
          'emp-1',
          'to-1',
          { decision: 'APPROVED' as any },
          'reviewer-1',
        ),
      ).rejects.toThrow(TimeOffInvalidTransitionError);
    });

    it('should update row to APPROVED with reviewer fields', async () => {
      const { service, timeOffFindFirst, timeOffUpdate } = makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'PENDING',
      });

      const updatedRow = {
        id: 'to-1',
        status: 'APPROVED',
        reviewerUserId: 'reviewer-1',
      };
      timeOffUpdate.mockResolvedValue(updatedRow);

      const result = await service.review(
        'emp-1',
        'to-1',
        { decision: 'APPROVED' as any, reviewerNotes: 'Enjoy!' },
        'reviewer-1',
      );

      expect(timeOffUpdate).toHaveBeenCalledWith({
        where: { id: 'to-1' },
        data: expect.objectContaining({
          status: 'APPROVED',
          reviewerUserId: 'reviewer-1',
          reviewerNotes: 'Enjoy!',
        }),
      });
      expect(result).toEqual(updatedRow);
    });
  });

  // ============================================================
  // cancel()
  // ============================================================
  describe('cancel()', () => {
    it('should allow cancellation when status is PENDING', async () => {
      const { service, timeOffFindFirst, timeOffUpdate } = makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'PENDING',
        startDate: new Date('2099-07-01'),
      });
      timeOffUpdate.mockResolvedValue({
        id: 'to-1',
        status: 'CANCELLED',
      });

      const result = await service.cancel('emp-1', 'to-1');

      expect(timeOffUpdate).toHaveBeenCalledWith({
        where: { id: 'to-1' },
        data: { status: 'CANCELLED' },
      });
      expect(result.status).toBe('CANCELLED');
    });

    it('should reject cancellation when APPROVED and startDate already passed', async () => {
      const { service, timeOffFindFirst } = makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'APPROVED',
        startDate: new Date('2020-01-01'), // past
      });

      await expect(service.cancel('emp-1', 'to-1')).rejects.toThrow(
        TimeOffInvalidTransitionError,
      );
    });
  });

  // ============================================================
  // getVacationBalance()
  // ============================================================
  describe('getVacationBalance()', () => {
    it('should compute correct entitlement, used, pending, remaining', async () => {
      const { service, employeeRepo, timeOffFindMany } = makeService();
      employeeRepo.findById.mockResolvedValue({
        ...mockEmployee,
        annualVacationDays: 15,
      });

      // First call: approved rows (5-day vacation)
      timeOffFindMany.mockResolvedValueOnce([
        {
          startDate: new Date('2026-07-01'),
          endDate: new Date('2026-07-05'),
          type: 'VACATION',
          status: 'APPROVED',
        },
      ]);
      // Second call: pending rows (3-day vacation)
      timeOffFindMany.mockResolvedValueOnce([
        {
          startDate: new Date('2026-08-01'),
          endDate: new Date('2026-08-03'),
          type: 'VACATION',
          status: 'PENDING',
        },
      ]);

      const balance = await service.getVacationBalance('emp-1', 2026);

      expect(balance.year).toBe(2026);
      expect(balance.entitlement).toBe(15);
      expect(balance.used).toBe(5);
      expect(balance.pending).toBe(3);
      expect(balance.remaining).toBe(10); // 15 - 5 (pending NOT subtracted)
    });
  });

  // ============================================================
  // listForEmployee() — medical sensitivity
  // ============================================================
  describe('listForEmployee()', () => {
    it('should strip reason on SICK rows when ability lacks read:EmployeeTimeOffMedical', async () => {
      const { service, employeeRepo, timeOffFindMany, timeOffCount } =
        makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);

      const sickRow = {
        id: 'to-1',
        type: 'SICK',
        reason: 'Flu recovery',
        status: 'APPROVED',
        startDate: new Date('2026-07-01'),
      };
      const vacationRow = {
        id: 'to-2',
        type: 'VACATION',
        reason: 'Family trip',
        status: 'APPROVED',
        startDate: new Date('2026-08-01'),
      };

      timeOffFindMany.mockResolvedValue([sickRow, vacationRow]);
      timeOffCount.mockResolvedValue(2);

      const abilityWithoutMedical = {
        can: jest.fn().mockReturnValue(false),
      } as any;

      const result = await service.listForEmployee(
        'emp-1',
        {},
        abilityWithoutMedical,
      );

      // SICK row reason stripped
      expect(result.data[0].reason).toBeNull();
      // VACATION row reason kept
      expect(result.data[1].reason).toBe('Family trip');
    });

    it('should keep reason on SICK rows when ability has read:EmployeeTimeOffMedical', async () => {
      const { service, employeeRepo, timeOffFindMany, timeOffCount } =
        makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);

      const sickRow = {
        id: 'to-1',
        type: 'SICK',
        reason: 'Flu recovery',
        status: 'APPROVED',
        startDate: new Date('2026-07-01'),
      };

      timeOffFindMany.mockResolvedValue([sickRow]);
      timeOffCount.mockResolvedValue(1);

      const abilityWithMedical = {
        can: jest.fn().mockImplementation((action: string, subject: string) => {
          if (action === 'read' && subject === 'EmployeeTimeOffMedical')
            return true;
          return false;
        }),
      } as any;

      const result = await service.listForEmployee(
        'emp-1',
        {},
        abilityWithMedical,
      );

      expect(result.data[0].reason).toBe('Flu recovery');
    });

    it('should leave non-SICK row reasons untouched regardless of ability', async () => {
      const { service, employeeRepo, timeOffFindMany, timeOffCount } =
        makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);

      const personalRow = {
        id: 'to-1',
        type: 'PERSONAL',
        reason: 'Moving day',
        status: 'APPROVED',
        startDate: new Date('2026-07-01'),
      };

      timeOffFindMany.mockResolvedValue([personalRow]);
      timeOffCount.mockResolvedValue(1);

      const noAbility = undefined;
      const result = await service.listForEmployee('emp-1', {}, noAbility);

      expect(result.data[0].reason).toBe('Moving day');
    });
  });

  // ============================================================
  // listPendingApprovalsForManager()
  // ============================================================
  describe('listPendingApprovalsForManager()', () => {
    it('should return empty array when manager has no subordinates', async () => {
      const { service, employeeFindMany } = makeService();
      employeeFindMany.mockResolvedValue([]);

      const result = await service.listPendingApprovalsForManager('mgr-1');
      expect(result).toEqual([]);
    });

    it('should return pending time-off for subordinates', async () => {
      const { service, employeeFindMany, timeOffFindMany } = makeService();
      employeeFindMany.mockResolvedValue([{ id: 'emp-2' }, { id: 'emp-3' }]);

      const pendingRows = [
        {
          id: 'to-1',
          employeeId: 'emp-2',
          type: 'VACATION',
          status: 'PENDING',
          reason: null,
          startDate: new Date('2026-07-01'),
        },
        {
          id: 'to-2',
          employeeId: 'emp-3',
          type: 'PERSONAL',
          status: 'PENDING',
          reason: 'Doctor',
          startDate: new Date('2026-07-05'),
        },
      ];
      timeOffFindMany.mockResolvedValue(pendingRows);

      const result = await service.listPendingApprovalsForManager('mgr-1');

      expect(employeeFindMany).toHaveBeenCalledWith({
        where: { managerId: 'mgr-1' },
        select: { id: true },
      });
      expect(timeOffFindMany).toHaveBeenCalledWith({
        where: {
          employeeId: { in: ['emp-2', 'emp-3'] },
          status: 'PENDING',
        },
        orderBy: { startDate: 'asc' },
      });
      expect(result).toHaveLength(2);
    });
  });

  // ============================================================
  // listPendingApprovalsForCurrentUser()
  // ============================================================
  describe('listPendingApprovalsForCurrentUser()', () => {
    it('should return empty array when current user is not linked to an employee', async () => {
      const { service, employeeFindFirst, employeeFindMany, timeOffFindMany } =
        makeService();
      employeeFindFirst.mockResolvedValue(null);

      const result = await service.listPendingApprovalsForCurrentUser('user-1');

      expect(employeeFindFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { id: true },
      });
      expect(employeeFindMany).not.toHaveBeenCalled();
      expect(timeOffFindMany).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('should resolve the linked employee and return pending subordinate requests', async () => {
      const { service, employeeFindFirst, employeeFindMany, timeOffFindMany } =
        makeService();
      employeeFindFirst.mockResolvedValue({ id: 'mgr-1' });
      employeeFindMany.mockResolvedValue([{ id: 'emp-2' }]);
      timeOffFindMany.mockResolvedValue([
        {
          id: 'to-1',
          employeeId: 'emp-2',
          type: 'VACATION',
          status: 'PENDING',
          reason: 'Family trip',
          startDate: new Date('2026-07-01'),
        },
      ]);

      const result = await service.listPendingApprovalsForCurrentUser('user-1');

      expect(employeeFindMany).toHaveBeenCalledWith({
        where: { managerId: 'mgr-1' },
        select: { id: true },
      });
      expect(timeOffFindMany).toHaveBeenCalledWith({
        where: {
          employeeId: { in: ['emp-2'] },
          status: 'PENDING',
        },
        orderBy: { startDate: 'asc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('runtime ability resolution (CLS-driven)', () => {
    it('listForEmployee uses CLS-built ability to strip SICK reason when permission missing', async () => {
      const {
        service,
        employeeRepo,
        prismaClient,
        ability,
        caslAbilityFactory,
      } = makeServiceWithCls({ abilityCanResult: false });
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      prismaClient.employeeTimeOff.findMany.mockResolvedValue([
        {
          id: 't1',
          employeeId: 'emp-1',
          type: 'SICK',
          status: 'APPROVED',
          startDate: new Date('2026-03-01'),
          endDate: new Date('2026-03-03'),
          reason: 'Gripe fuerte',
        },
      ]);
      prismaClient.employeeTimeOff.count.mockResolvedValue(1);

      const result = await service.listForEmployee('emp-1', {} as any);

      expect(caslAbilityFactory.createForUser).toHaveBeenCalledWith('user-1', {
        tenantId: 'tenant-1',
        isSuperAdmin: false,
      });
      expect(ability.can).toHaveBeenCalledWith(
        'read',
        'EmployeeTimeOffMedical',
      );
      expect(result.data[0].reason).toBeNull();
    });

    it('listForEmployee keeps SICK reason when CLS-built ability grants medical permission', async () => {
      const { service, employeeRepo, prismaClient, ability } =
        makeServiceWithCls({
          abilityCanResult: true,
        });
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      prismaClient.employeeTimeOff.findMany.mockResolvedValue([
        {
          id: 't1',
          employeeId: 'emp-1',
          type: 'SICK',
          status: 'APPROVED',
          startDate: new Date('2026-03-01'),
          endDate: new Date('2026-03-03'),
          reason: 'Gripe fuerte',
        },
      ]);
      prismaClient.employeeTimeOff.count.mockResolvedValue(1);

      const result = await service.listForEmployee('emp-1', {} as any);

      expect(ability.can).toHaveBeenCalledWith(
        'read',
        'EmployeeTimeOffMedical',
      );
      expect(result.data[0].reason).toBe('Gripe fuerte');
    });

    it('listPendingApprovalsForManager builds CLS ability and strips SICK reason when missing permission', async () => {
      const { service, prismaClient, ability } = makeServiceWithCls({
        abilityCanResult: false,
      });
      prismaClient.employee.findMany.mockResolvedValue([{ id: 'emp-2' }]);
      prismaClient.employeeTimeOff.findMany.mockResolvedValue([
        {
          id: 't9',
          employeeId: 'emp-2',
          type: 'SICK',
          status: 'PENDING',
          startDate: new Date('2026-04-01'),
          endDate: new Date('2026-04-02'),
          reason: 'Confidencial',
        },
      ]);

      const result = await service.listPendingApprovalsForManager('mgr-1');

      expect(ability.can).toHaveBeenCalledWith(
        'read',
        'EmployeeTimeOffMedical',
      );
      expect(result[0].reason).toBeNull();
    });
  });
});
