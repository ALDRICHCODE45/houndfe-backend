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
    it('should query by tenantId and expiresAt cutoff ordered by expiresAt asc', async () => {
      const { service, documentFindMany, employeeFindMany } = makeService();
      const docs = [{ id: 'doc-1', expiresAt: new Date() }];
      documentFindMany.mockResolvedValue(docs);
      employeeFindMany.mockResolvedValue([]);

      const result = await service.listExpiringTenantWide(30);

      const call = documentFindMany.mock.calls[0][0];
      expect(call.where.tenantId).toBe('tenant-1');
      expect(call.where.expiresAt.lte).toBeInstanceOf(Date);
      expect(call.where.expiresAt.not).toBeNull();
      expect(call.orderBy).toEqual({ expiresAt: 'asc' });
      // Additive contract: the original document rows still flow through
      // unchanged (identity fields are asserted in the describe below).
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject(docs[0]);
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

      const result = await service.listExpiringTenantWide(30);

      expect(result.map((r: any) => r.id)).toEqual(['doc-1', 'doc-2']);
      expect(result[0]).toMatchObject({
        employeeId: 'emp-3',
        fullName: 'Luis Pérez',
        employeeNumber: 'E-003',
      });
      expect(result[1]).toMatchObject({
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

      await service.listExpiringTenantWide(30);

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

      const result = await service.listExpiringTenantWide(30);

      expect(result[0].fullName).toBe('(empleado)');
      expect(result[0].employeeNumber).toBeNull();
    });
  });
});
