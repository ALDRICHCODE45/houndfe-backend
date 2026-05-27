import { EmployeeEmergencyContactsService } from './employee-emergency-contacts.service';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmergencyContactNotFoundError } from '../domain/errors/emergency-contact-not-found.error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const contactCreate = jest.fn();
  const contactFindMany = jest.fn();
  const contactFindUnique = jest.fn();
  const contactUpdate = jest.fn();
  const contactDelete = jest.fn();

  const prismaClient = {
    employeeEmergencyContact: {
      create: contactCreate,
      findMany: contactFindMany,
      findUnique: contactFindUnique,
      update: contactUpdate,
      delete: contactDelete,
    },
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(prismaClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const service = new EmployeeEmergencyContactsService(
    employeeRepo,
    tenantPrisma,
  );

  return {
    service,
    employeeRepo,
    tenantPrisma,
    prismaClient,
    contactCreate,
    contactFindMany,
    contactFindUnique,
    contactUpdate,
    contactDelete,
  };
}

describe('EmployeeEmergencyContactsService', () => {
  describe('create()', () => {
    it('should throw EmployeeNotFoundError when employee missing', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(
        service.create('missing', {
          name: 'Maria Garcia',
          relationship: 'Spouse',
          phone: '+52-555-1234',
        }),
      ).rejects.toThrow(EmployeeNotFoundError);
    });

    it('should trim fields and persist, defaulting email to null when missing', async () => {
      const { service, employeeRepo, contactCreate } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });

      const created = {
        id: 'ec-1',
        name: 'Maria Garcia',
        relationship: 'Spouse',
        phone: '+52-555-1234',
        email: null,
      };
      contactCreate.mockResolvedValue(created);

      const result = await service.create('emp-1', {
        name: '  Maria Garcia  ',
        relationship: '  Spouse  ',
        phone: '  +52-555-1234  ',
      });

      expect(contactCreate).toHaveBeenCalledWith({
        data: {
          employeeId: 'emp-1',
          name: 'Maria Garcia',
          relationship: 'Spouse',
          phone: '+52-555-1234',
          email: null,
          tenantId: 'tenant-1',
        },
      });
      expect(result).toEqual(created);
    });

    it('should lowercase email when provided', async () => {
      const { service, employeeRepo, contactCreate } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });
      contactCreate.mockResolvedValue({ id: 'ec-1' });

      await service.create('emp-1', {
        name: 'Ana Lopez',
        relationship: 'Sister',
        phone: '555-0000',
        email: '  ANA@Example.COM  ',
      });

      expect(contactCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: 'ana@example.com' }),
      });
    });
  });

  describe('listForEmployee()', () => {
    it('should return contacts ordered by createdAt asc', async () => {
      const { service, employeeRepo, contactFindMany } = makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });

      const rows = [
        { id: 'ec-1', createdAt: new Date('2026-01-01') },
        { id: 'ec-2', createdAt: new Date('2026-02-01') },
      ];
      contactFindMany.mockResolvedValue(rows);

      const result = await service.listForEmployee('emp-1');

      expect(contactFindMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual(rows);
    });

    it('should throw EmployeeNotFoundError when employee missing', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      await expect(service.listForEmployee('missing')).rejects.toThrow(
        EmployeeNotFoundError,
      );
    });
  });

  describe('update()', () => {
    it('should throw EmergencyContactNotFoundError when contact not owned by employee', async () => {
      const { service, contactFindUnique } = makeService();
      contactFindUnique.mockResolvedValue({
        id: 'ec-1',
        employeeId: 'other-emp',
      });

      await expect(
        service.update('emp-1', 'ec-1', { phone: '555-9999' }),
      ).rejects.toThrow(EmergencyContactNotFoundError);
    });

    it('should throw EmergencyContactNotFoundError when contact does not exist', async () => {
      const { service, contactFindUnique } = makeService();
      contactFindUnique.mockResolvedValue(null);

      await expect(
        service.update('emp-1', 'nonexistent', { phone: '555-9999' }),
      ).rejects.toThrow(EmergencyContactNotFoundError);
    });

    it('should patch only provided fields', async () => {
      const { service, contactFindUnique, contactUpdate } = makeService();
      contactFindUnique.mockResolvedValue({
        id: 'ec-1',
        employeeId: 'emp-1',
      });
      contactUpdate.mockResolvedValue({ id: 'ec-1', phone: '555-9999' });

      await service.update('emp-1', 'ec-1', { phone: '  555-9999  ' });

      expect(contactUpdate).toHaveBeenCalledWith({
        where: { id: 'ec-1' },
        data: { phone: '555-9999' },
      });
    });
  });

  describe('delete()', () => {
    it('should throw EmergencyContactNotFoundError when contact not owned by employee', async () => {
      const { service, contactFindUnique } = makeService();
      contactFindUnique.mockResolvedValue({
        id: 'ec-1',
        employeeId: 'other-emp',
      });

      await expect(service.delete('emp-1', 'ec-1')).rejects.toThrow(
        EmergencyContactNotFoundError,
      );
    });

    it('should remove row when owned', async () => {
      const { service, contactFindUnique, contactDelete } = makeService();
      contactFindUnique.mockResolvedValue({
        id: 'ec-1',
        employeeId: 'emp-1',
      });
      contactDelete.mockResolvedValue({});

      await service.delete('emp-1', 'ec-1');

      expect(contactDelete).toHaveBeenCalledWith({
        where: { id: 'ec-1' },
      });
    });
  });
});
