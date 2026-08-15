import { EmployeeDocumentsService } from './employee-documents.service';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmployeeDocumentNotFoundError } from '../domain/errors/employee-document-not-found.error';

function makeService() {
  const employeeRepo = {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
  };

  const documentCreate = jest.fn();
  const documentFindUnique = jest.fn();
  const documentFindMany = jest.fn();
  const documentCount = jest.fn();
  const documentDelete = jest.fn();
  const employeeFindMany = jest.fn();

  const prismaClient = {
    employeeDocument: {
      create: documentCreate,
      findUnique: documentFindUnique,
      findMany: documentFindMany,
      count: documentCount,
      delete: documentDelete,
    },
    employee: {
      findMany: employeeFindMany,
    },
  };

  const tenantPrisma = {
    getClient: jest.fn().mockReturnValue(prismaClient),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
  } as any;

  const filesService = {
    uploadAndRegister: jest.fn(),
    delete: jest.fn(),
    findById: jest.fn(),
  };

  const service = new EmployeeDocumentsService(
    employeeRepo,
    tenantPrisma,
    filesService as any,
  );

  return {
    service,
    employeeRepo,
    tenantPrisma,
    prismaClient,
    filesService,
    documentCreate,
    documentFindUnique,
    documentFindMany,
    documentCount,
    documentDelete,
    employeeFindMany,
  };
}

describe('EmployeeDocumentsService', () => {
  describe('upload()', () => {
    it('should throw EmployeeNotFoundError when employee missing', async () => {
      const { service, employeeRepo } = makeService();
      employeeRepo.findById.mockResolvedValue(null);

      const fakeFile = {
        buffer: Buffer.from('test'),
        mimetype: 'application/pdf',
        originalname: 'doc.pdf',
      } as Express.Multer.File;

      await expect(
        service.upload(
          'missing-emp',
          fakeFile,
          { category: 'CONTRACT' as any },
          'user-1',
        ),
      ).rejects.toThrow(EmployeeNotFoundError);
    });

    it('should call filesService.uploadAndRegister with allowed MIME types, then persist EmployeeDocument with fileId', async () => {
      const { service, employeeRepo, filesService, documentCreate } =
        makeService();
      employeeRepo.findById.mockResolvedValue({
        id: 'emp-1',
        tenantId: 'tenant-1',
      });
      filesService.uploadAndRegister.mockResolvedValue({
        id: 'file-1',
        url: 'https://example.com/file-1',
      });

      const createdRow = {
        id: 'doc-1',
        employeeId: 'emp-1',
        fileId: 'file-1',
        category: 'CONTRACT',
        expiresAt: null,
        notes: null,
        uploadedByUserId: 'user-1',
        tenantId: 'tenant-1',
      };
      documentCreate.mockResolvedValue(createdRow);

      const fakeFile = {
        buffer: Buffer.from('pdf-content'),
        mimetype: 'application/pdf',
        originalname: 'contract.pdf',
      } as Express.Multer.File;

      const result = await service.upload(
        'emp-1',
        fakeFile,
        { category: 'CONTRACT' as any },
        'user-1',
      );

      // Verify filesService was called with allowed MIME types
      expect(filesService.uploadAndRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: fakeFile.buffer,
          mimeType: 'application/pdf',
          originalName: 'contract.pdf',
          uploadedBy: 'user-1',
          allowedMimeTypes: expect.arrayContaining([
            'application/pdf',
            'application/msword',
            'image/jpeg',
          ]),
        }),
      );

      // Verify document row was created with returned fileId
      expect(documentCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          employeeId: 'emp-1',
          fileId: 'file-1',
          category: 'CONTRACT',
          uploadedByUserId: 'user-1',
          tenantId: 'tenant-1',
        }),
      });

      expect(result).toEqual(createdRow);
    });
  });

  describe('list()', () => {
    it('should filter by category when provided', async () => {
      const { service, employeeRepo, documentFindMany, documentCount } =
        makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });
      documentFindMany.mockResolvedValue([{ id: 'doc-1', category: 'NDA' }]);
      documentCount.mockResolvedValue(1);

      const result = await service.list('emp-1', { category: 'NDA' as any });

      expect(documentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            employeeId: 'emp-1',
            category: 'NDA',
          }),
        }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by expiringWithinDays cutoff', async () => {
      const { service, employeeRepo, documentFindMany, documentCount } =
        makeService();
      employeeRepo.findById.mockResolvedValue({ id: 'emp-1' });
      documentFindMany.mockResolvedValue([
        { id: 'doc-1', expiresAt: new Date() },
      ]);
      documentCount.mockResolvedValue(1);

      await service.list('emp-1', { expiringWithinDays: 30 });

      const findManyCall = documentFindMany.mock.calls[0][0];
      expect(findManyCall.where.expiresAt).toBeDefined();
      expect(findManyCall.where.expiresAt.lte).toBeInstanceOf(Date);
      expect(findManyCall.where.expiresAt.not).toBeNull();

      // Verify the cutoff is approximately now + 30 days
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() + 30);
      const actualCutoff = findManyCall.where.expiresAt.lte as Date;
      expect(
        Math.abs(actualCutoff.getTime() - expectedCutoff.getTime()),
      ).toBeLessThan(5000);
    });
  });

  describe('delete()', () => {
    it('should remove DB row and call filesService.delete when blob deletion succeeds', async () => {
      const { service, documentFindUnique, documentDelete, filesService } =
        makeService();
      documentFindUnique.mockResolvedValue({
        id: 'doc-1',
        employeeId: 'emp-1',
        fileId: 'file-1',
      });
      documentDelete.mockResolvedValue({});
      filesService.delete.mockResolvedValue(undefined);

      await service.delete('emp-1', 'doc-1');

      expect(documentDelete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
      expect(filesService.delete).toHaveBeenCalledWith('file-1');
    });

    it('should still delete DB row when filesService.delete throws (best-effort blob cleanup)', async () => {
      const { service, documentFindUnique, documentDelete, filesService } =
        makeService();
      documentFindUnique.mockResolvedValue({
        id: 'doc-1',
        employeeId: 'emp-1',
        fileId: 'file-1',
      });
      documentDelete.mockResolvedValue({});
      filesService.delete.mockRejectedValue(new Error('S3 unavailable'));

      // Should NOT throw
      await expect(service.delete('emp-1', 'doc-1')).resolves.not.toThrow();

      // DB row was deleted
      expect(documentDelete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
      // Blob delete was still attempted
      expect(filesService.delete).toHaveBeenCalledWith('file-1');
    });
  });

  describe('getDownloadInfo()', () => {
    it('should throw EmployeeDocumentNotFoundError when doc not owned by requested employee', async () => {
      const { service, documentFindUnique } = makeService();
      // Doc exists but belongs to a different employee
      documentFindUnique.mockResolvedValue({
        id: 'doc-1',
        employeeId: 'other-emp',
        fileId: 'file-1',
      });

      await expect(service.getDownloadInfo('emp-1', 'doc-1')).rejects.toThrow(
        EmployeeDocumentNotFoundError,
      );
    });

    it('should throw EmployeeDocumentNotFoundError when doc does not exist', async () => {
      const { service, documentFindUnique } = makeService();
      documentFindUnique.mockResolvedValue(null);

      await expect(
        service.getDownloadInfo('emp-1', 'nonexistent'),
      ).rejects.toThrow(EmployeeDocumentNotFoundError);
    });

    it('should return fileId when doc exists and belongs to requested employee', async () => {
      const { service, documentFindUnique } = makeService();
      documentFindUnique.mockResolvedValue({
        id: 'doc-1',
        employeeId: 'emp-1',
        fileId: 'file-1',
      });

      const result = await service.getDownloadInfo('emp-1', 'doc-1');
      expect(result).toEqual({ fileId: 'file-1' });
    });
  });

  describe('listExpiringTenantWide()', () => {
    it('should query by tenantId and expiresAt cutoff ordered by expiresAt asc by default', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      const docs = [{ id: 'doc-1', expiresAt: new Date() }];
      documentFindMany.mockResolvedValue(docs);
      employeeFindMany.mockResolvedValue([]);

      const result = await service.listExpiringTenantWide({});

      const call = documentFindMany.mock.calls[0][0];
      expect(call.where.tenantId).toBe('tenant-1');
      expect(call.where.expiresAt.lte).toBeInstanceOf(Date);
      expect(call.where.expiresAt.not).toBeNull();
      expect(call.orderBy).toEqual({ expiresAt: 'asc' });
      // Additive contract: the original document rows still flow through
      // unchanged (identity fields are asserted in the describe below).
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject(docs[0]);
    });

    it('should default the cutoff to now + 30 days when daysUntilExpiry is omitted', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({});

      const call = documentFindMany.mock.calls[0][0];
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() + 30);
      const actualCutoff = call.where.expiresAt.lte as Date;
      expect(
        Math.abs(actualCutoff.getTime() - expectedCutoff.getTime()),
      ).toBeLessThan(5000);
    });

    it('should use daysUntilExpiry from the query when provided', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({ daysUntilExpiry: 60 });

      const call = documentFindMany.mock.calls[0][0];
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() + 60);
      const actualCutoff = call.where.expiresAt.lte as Date;
      expect(
        Math.abs(actualCutoff.getTime() - expectedCutoff.getTime()),
      ).toBeLessThan(5000);
    });

    it('should return { data, meta } with totalPages = ceil(total / limit)', async () => {
      const { service, documentFindMany, documentCount, employeeFindMany } =
        makeService();
      documentFindMany.mockResolvedValue([
        { id: 'doc-1', employeeId: 'emp-1', expiresAt: new Date('2026-07-01') },
      ]);
      documentCount.mockResolvedValue(45);
      employeeFindMany.mockResolvedValue([]);

      const result = await service.listExpiringTenantWide({ page: 3, limit: 20 });

      expect(documentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 45, page: 3, limit: 20, totalPages: 3 });
    });

    it('should return totalPages 0 when there are no rows', async () => {
      const { service, documentFindMany, documentCount, employeeFindMany } =
        makeService();
      documentFindMany.mockResolvedValue([]);
      documentCount.mockResolvedValue(0);
      employeeFindMany.mockResolvedValue([]);

      const result = await service.listExpiringTenantWide({});

      expect(result.data).toHaveLength(0);
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
    });
  });

  describe('listExpiringTenantWide() — search', () => {
    it('should reject single-character searches with SEARCH_QUERY_TOO_SHORT', async () => {
      const { service } = makeService();

      await expect(service.listExpiringTenantWide({ search: 'a' })).rejects.toThrow(
        'SEARCH_QUERY_TOO_SHORT',
      );
    });

    it('should build a relation OR filter over employee identity for search >= 2 chars', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({ search: 'LUIS' });

      const call = documentFindMany.mock.calls[0][0];
      expect(call.where).toEqual({
        tenantId: 'tenant-1',
        expiresAt: { lte: expect.any(Date), not: null },
        OR: [
          {
            employee: {
              firstName: { contains: 'LUIS', mode: 'insensitive' },
            },
          },
          {
            employee: {
              lastName: { contains: 'LUIS', mode: 'insensitive' },
            },
          },
          {
            employee: {
              employeeNumber: { contains: 'LUIS', mode: 'insensitive' },
            },
          },
        ],
      });
    });

    it('should match category via the enum values that contain the search term (Prisma enums do not support contains)', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({ search: 'contract' });

      const call = documentFindMany.mock.calls[0][0];
      expect(call.where.OR).toEqual([
        {
          employee: {
            firstName: { contains: 'contract', mode: 'insensitive' },
          },
        },
        {
          employee: {
            lastName: { contains: 'contract', mode: 'insensitive' },
          },
        },
        {
          employee: {
            employeeNumber: { contains: 'contract', mode: 'insensitive' },
          },
        },
        { category: { in: ['CONTRACT'] } },
      ]);
    });

    it('should omit the OR filter when search is undefined', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({});

      const call = documentFindMany.mock.calls[0][0];
      expect(call.where.OR).toBeUndefined();
    });
  });

  describe('listExpiringTenantWide() — sorting', () => {
    it('should map sortBy employeeName to employee.firstName orderBy', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({
        sortBy: 'employeeName',
        sortOrder: 'desc',
      });

      expect(documentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { employee: { firstName: 'desc' } } }),
      );
    });

    it('should map other sort fields directly onto the document', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([]);
      employeeFindMany.mockResolvedValue([]);

      await service.listExpiringTenantWide({
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      expect(documentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'asc' } }),
      );
    });
  });

  describe('listExpiringTenantWide() — inline employee identity', () => {
    it('attaches fullName + employeeNumber from a batch employee lookup, preserving expiresAt order', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();

      // findMany already returns docs ordered by expiresAt asc; the
      // service must iterate DOCS (not employees) to keep that order.
      documentFindMany.mockResolvedValue([
        { id: 'doc-1', employeeId: 'emp-3', expiresAt: new Date('2026-07-01') },
        { id: 'doc-2', employeeId: 'emp-2', expiresAt: new Date('2026-07-05') },
      ]);
      employeeFindMany.mockResolvedValue([
        {
          id: 'emp-2',
          firstName: 'Ana',
          lastName: 'Gómez',
          employeeNumber: 'E-002',
        },
        {
          id: 'emp-3',
          firstName: 'Luis',
          lastName: 'Pérez',
          employeeNumber: 'E-003',
        },
      ]);

      const result = await service.listExpiringTenantWide({});

      expect(result.data.map((r: any) => r.id)).toEqual(['doc-1', 'doc-2']);
      expect(result.data[0]).toMatchObject({
        employeeId: 'emp-3',
        fullName: 'Luis Pérez',
        employeeNumber: 'E-003',
      });
      expect(result.data[1]).toMatchObject({
        employeeId: 'emp-2',
        fullName: 'Ana Gómez',
        employeeNumber: 'E-002',
      });
    });

    it('queries the employee lookup once with the de-duplicated employeeIds', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([
        { id: 'doc-1', employeeId: 'emp-2', expiresAt: new Date('2026-07-01') },
        { id: 'doc-2', employeeId: 'emp-2', expiresAt: new Date('2026-07-02') },
        { id: 'doc-3', employeeId: 'emp-3', expiresAt: new Date('2026-07-03') },
      ]);
      employeeFindMany.mockResolvedValue([
        {
          id: 'emp-2',
          firstName: 'Ana',
          lastName: 'Gómez',
          employeeNumber: 'E-002',
        },
        {
          id: 'emp-3',
          firstName: 'Luis',
          lastName: 'Pérez',
          employeeNumber: 'E-003',
        },
      ]);

      await service.listExpiringTenantWide({});

      // ONE batch read with the UNIQUE ids — no tenantId hand-added
      // (Employee is auto tenant-scoped).
      expect(employeeFindMany).toHaveBeenCalledTimes(1);
      expect(employeeFindMany).toHaveBeenCalledWith({
        where: { id: { in: ['emp-2', 'emp-3'] } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeNumber: true,
        },
      });
    });

    it('falls back to "(empleado)" and null employeeNumber when the employee is missing from the lookup', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      documentFindMany.mockResolvedValue([
        {
          id: 'doc-1',
          employeeId: 'emp-missing',
          expiresAt: new Date('2026-07-01'),
        },
      ]);
      employeeFindMany.mockResolvedValue([]); // lookup resolves nothing

      const result = await service.listExpiringTenantWide({});

      expect(result.data[0].fullName).toBe('(empleado)');
      expect(result.data[0].employeeNumber).toBeNull();
    });
  });
});
