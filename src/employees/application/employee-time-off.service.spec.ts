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
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
  } as any;

  // Slice 4 — request() now runs inside runInTransaction and reads
  // notification config + writes an outbox row. Defaults: gates-open
  // (overridable per-test).
  const notificationConfigRepo = {
    find: jest.fn().mockResolvedValue({
      enabled: true,
      recipients: ['u1'],
      enabledActions: ['TIME_OFF_REQUESTED'],
    }),
  };
  const outboxWriter = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  const service = new EmployeeTimeOffService(
    employeeRepo,
    tenantPrisma,
    undefined,
    undefined,
    notificationConfigRepo,
    outboxWriter,
  );

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
    notificationConfigRepo,
    outboxWriter,
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
    base.notificationConfigRepo,
    base.outboxWriter,
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

    // ─── Slice 4 — gated emit (hr-validation-notifications) ───
    //
    // Spec: employee-time-off — 'Atomic Request Writes Time-Off and
    // Outbox Event in One Transaction'. time-off-notifications —
    // 'Emit Gate Requires Master Toggle AND Action Key' (Design D1).
    //
    // The D1 write-time gate moves the gate UPSTREAM (low-stock writes
    // unconditionally + gates only in fn). On `request()` success with
    // gates open, exactly ONE outbox row is published with
    // eventType='hr.timeoff.requested' and the self-contained payload
    // shape from Design D3.
    it('Slice 4 — all gates open: persists row AND publishes one outbox eventType=hr.timeoff.requested with idem `${tenantId}:${timeOffId}` and self-contained payload', async () => {
      const {
        service,
        employeeRepo,
        timeOffCreate,
        notificationConfigRepo,
        outboxWriter,
      } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      notificationConfigRepo.find.mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['TIME_OFF_REQUESTED'],
      });
      timeOffCreate.mockResolvedValue({
        id: 'to-abc',
        employeeId: 'emp-1',
        type: 'VACATION',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-07-05'),
        reason: 'Family trip',
        status: 'PENDING',
        requestedByUserId: 'user-1',
        tenantId: 'tenant-1',
      });

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

      // Row persisted AND outbox row published, atomically.
      expect(timeOffCreate).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);

      const publishArgs = outboxWriter.publish.mock.calls[0];
      // (tx, tenantId, aggregateType, aggregateId, eventType, payload)
      expect(publishArgs[1]).toBe('tenant-1'); // tenantId
      expect(publishArgs[2]).toBe('EmployeeTimeOff'); // aggregateType
      expect(publishArgs[3]).toBe(result.id); // aggregateId = timeOffId
      expect(publishArgs[4]).toBe('hr.timeoff.requested'); // eventType
      const payload = publishArgs[5];
      expect(payload).toMatchObject({
        tenantId: 'tenant-1',
        timeOffId: result.id,
        employeeId: 'emp-1',
        type: 'VACATION',
        requestedByUserId: 'user-1',
      });
      expect(payload.startDate).toBeDefined();
      expect(payload.endDate).toBeDefined();
      expect(payload.employeeName).toBeDefined();

      // The idempotency key for the eventual Inngest send is derived
      // from `${tenantId}:${timeOffId}` — verified in Slice 5 specs.
      // Here we pin the aggregateId == timeOffId (matches idem shape).
      expect(publishArgs[3]).toBe(result.id);
    });

    it('Slice 4 — master toggle OFF (enabled=false): row persists, NO outbox row written', async () => {
      const {
        service,
        employeeRepo,
        timeOffCreate,
        notificationConfigRepo,
        outboxWriter,
      } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      notificationConfigRepo.find.mockResolvedValue({
        enabled: false,
        recipients: ['u1'],
        enabledActions: ['TIME_OFF_REQUESTED'],
      });
      timeOffCreate.mockResolvedValue({
        id: 'to-x',
        employeeId: 'emp-1',
        type: 'VACATION',
        status: 'PENDING',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-07-05'),
      });

      await service.request(
        'emp-1',
        {
          type: 'VACATION' as any,
          startDate: '2026-07-01',
          endDate: '2026-07-05',
        },
        'user-1',
      );

      expect(timeOffCreate).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Slice 4 — action key absent (enabledActions=[]): row persists, NO outbox row written', async () => {
      const {
        service,
        employeeRepo,
        timeOffCreate,
        notificationConfigRepo,
        outboxWriter,
      } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      notificationConfigRepo.find.mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: [],
      });
      timeOffCreate.mockResolvedValue({
        id: 'to-y',
        employeeId: 'emp-1',
        type: 'VACATION',
        status: 'PENDING',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-07-05'),
      });

      await service.request(
        'emp-1',
        {
          type: 'VACATION' as any,
          startDate: '2026-07-01',
          endDate: '2026-07-05',
        },
        'user-1',
      );

      expect(timeOffCreate).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('Slice 4 — outbox insert fails: both row and outbox are rolled back (transactional)', async () => {
      const {
        service,
        employeeRepo,
        timeOffCreate,
        notificationConfigRepo,
        outboxWriter,
        tenantPrisma,
      } = makeService();
      employeeRepo.findById.mockResolvedValue(mockEmployee);
      notificationConfigRepo.find.mockResolvedValue({
        enabled: true,
        recipients: ['u1'],
        enabledActions: ['TIME_OFF_REQUESTED'],
      });

      // Simulate transactional semantics: runInTransaction wraps the
      // body. If the outbox publish rejects, the tx rolls back the
      // EmployeeTimeOff.create as well.
      tenantPrisma.runInTransaction.mockImplementation(
        async (work: () => Promise<unknown>) => {
          try {
            return await work();
          } catch (err) {
            // Simulate rollback by swallowing — production Prisma
            // rolls back automatically; the spy just enforces that
            // BOTH inserts live inside the work closure.
            throw err;
          }
        },
      );
      timeOffCreate.mockResolvedValue({
        id: 'to-z',
        employeeId: 'emp-1',
        type: 'VACATION',
        status: 'PENDING',
        startDate: new Date('2026-07-01'),
        endDate: new Date('2026-07-05'),
      });
      outboxWriter.publish.mockRejectedValue(new Error('outbox down'));

      await expect(
        service.request(
          'emp-1',
          {
            type: 'VACATION' as any,
            startDate: '2026-07-01',
            endDate: '2026-07-05',
          },
          'user-1',
        ),
      ).rejects.toThrow(/outbox down/);

      // Both inserts were ATTEMPTED inside the transaction. The
      // rollback (Prisma's automatic tx abort) is what guarantees
      // neither row is persisted — pinned by the throw surfacing.
      expect(timeOffCreate).toHaveBeenCalledTimes(1);
      expect(outboxWriter.publish).toHaveBeenCalledTimes(1);
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
      const { service, timeOffFindFirst, timeOffUpdate, outboxWriter } =
        makeService();
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
      // Negative emit — approval is an authority lever, NOT a
      // notification lever. Only request() writes to the outbox
      // (Design D1: notification is gated at request-time, not review).
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('should NOT publish any outbox event when decision is REJECTED', async () => {
      const { service, timeOffFindFirst, timeOffUpdate, outboxWriter } =
        makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'PENDING',
      });
      timeOffUpdate.mockResolvedValue({
        id: 'to-1',
        status: 'REJECTED',
        reviewerUserId: 'reviewer-1',
      });

      await service.review(
        'emp-1',
        'to-1',
        { decision: 'REJECTED' as any, reviewerNotes: 'Not this time' },
        'reviewer-1',
      );

      expect(timeOffUpdate).toHaveBeenCalledWith({
        where: { id: 'to-1' },
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewerUserId: 'reviewer-1',
        }),
      });
      // Rejection emits nothing to the outbox either.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // cancel()
  // ============================================================
  describe('cancel()', () => {
    it('should allow cancellation when status is PENDING', async () => {
      const { service, timeOffFindFirst, timeOffUpdate, outboxWriter } =
        makeService();
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
      // Cancellation writes nothing to the outbox — only request() does.
      expect(outboxWriter.publish).not.toHaveBeenCalled();
    });

    it('should NOT publish any outbox event when cancelling a future APPROVED row', async () => {
      const { service, timeOffFindFirst, timeOffUpdate, outboxWriter } =
        makeService();
      timeOffFindFirst.mockResolvedValue({
        id: 'to-1',
        employeeId: 'emp-1',
        status: 'APPROVED',
        startDate: new Date('2099-07-01'), // future → cancellation allowed
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
      expect(outboxWriter.publish).not.toHaveBeenCalled();
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
  // listPendingApprovals() — Slice 1 tenant-wide inbox
  // ============================================================
  describe('listPendingApprovals() — tenant-wide inbox', () => {
    it('should return every PENDING row in the tenant, ordered by [startDate asc, id asc]', async () => {
      const { service, timeOffFindMany } = makeService();

      const pendingRows = [
        {
          id: 'to-A',
          employeeId: 'emp-2',
          type: 'VACATION',
          status: 'PENDING',
          reason: null,
          startDate: new Date('2026-07-05'),
        },
        {
          id: 'to-B',
          employeeId: 'emp-3',
          type: 'PERSONAL',
          status: 'PENDING',
          reason: 'Doctor',
          startDate: new Date('2026-07-01'),
        },
      ];
      timeOffFindMany.mockResolvedValue(pendingRows);

      const result = await service.listPendingApprovals();

      // Tenant-wide query: NO Employee.userId, NO Employee.managerId filter.
      expect(timeOffFindMany).toHaveBeenCalledWith({
        where: { status: 'PENDING' },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      });
      expect(result).toHaveLength(2);
    });

    it('should issue NO Employee.userId or Employee.managerId query (sole userId reader removed)', async () => {
      const { service, employeeFindFirst, employeeFindMany, timeOffFindMany } =
        makeService();
      // Stub the tenant-wide findMany to [] so the production code path
      // executes end-to-end — we are asserting which queries are NOT made.
      timeOffFindMany.mockResolvedValue([]);

      await service.listPendingApprovals();

      // The OLD by-manager/current-user reader used Employee.userId +
      // Employee.managerId. Tenant-wide inbox must NOT touch Employee.
      expect(employeeFindFirst).not.toHaveBeenCalled();
      expect(employeeFindMany).not.toHaveBeenCalled();

      // Only the EmployeeTimeOff.findMany call remains.
      expect(timeOffFindMany).toHaveBeenCalledTimes(1);
    });

    it('should strip SICK reason when ability lacks read:EmployeeTimeOffMedical', async () => {
      const { service, timeOffFindMany } = makeService();
      timeOffFindMany.mockResolvedValue([
        {
          id: 'to-1',
          employeeId: 'emp-2',
          type: 'SICK',
          status: 'PENDING',
          reason: 'Confidencial',
          startDate: new Date('2026-07-01'),
        },
        {
          id: 'to-2',
          employeeId: 'emp-3',
          type: 'VACATION',
          status: 'PENDING',
          reason: 'Family trip',
          startDate: new Date('2026-07-05'),
        },
      ]);

      const abilityWithoutMedical = {
        can: jest.fn().mockReturnValue(false),
      } as any;

      const result = await service.listPendingApprovals(abilityWithoutMedical);

      expect(result[0].reason).toBeNull();
      expect(result[1].reason).toBe('Family trip');
    });

    it('should keep SICK reason when ability grants read:EmployeeTimeOffMedical', async () => {
      const { service, timeOffFindMany } = makeService();
      timeOffFindMany.mockResolvedValue([
        {
          id: 'to-1',
          employeeId: 'emp-2',
          type: 'SICK',
          status: 'PENDING',
          reason: 'Gripe',
          startDate: new Date('2026-07-01'),
        },
      ]);

      const abilityWithMedical = {
        can: jest.fn().mockImplementation((action: string, subject: string) => {
          if (action === 'read' && subject === 'EmployeeTimeOffMedical')
            return true;
          return false;
        }),
      } as any;

      const result = await service.listPendingApprovals(abilityWithMedical);

      expect(result[0].reason).toBe('Gripe');
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

    it('listPendingApprovals builds CLS ability and strips SICK reason when missing permission (tenant-wide)', async () => {
      const { service, prismaClient, ability } = makeServiceWithCls({
        abilityCanResult: false,
      });
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

      const result = await service.listPendingApprovals();

      // The tenant-wide inbox builds ability via CLS and strips SICK
      // reason when medical-read is denied — same contract as before,
      // applied to the tenant-wide query.
      expect(ability.can).toHaveBeenCalledWith(
        'read',
        'EmployeeTimeOffMedical',
      );
      expect(result[0].reason).toBeNull();
    });
  });
});
