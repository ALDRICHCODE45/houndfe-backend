import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { EmployeeDocumentCategory, Prisma } from '@prisma/client';
import type { IEmployeeRepository } from '../domain/employee.repository';
import { EMPLOYEE_REPOSITORY } from '../domain/employee.repository';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { FilesService } from '../../files/files.service';
import { buildDisplayName } from './employee-display-name';
import { EmployeeNotFoundError } from '../domain/errors/employee-not-found.error';
import { EmployeeDocumentNotFoundError } from '../domain/errors/employee-document-not-found.error';
import type { UploadEmployeeDocumentDto } from '../dto/upload-employee-document.dto';
import type { ListEmployeeDocumentsQueryDto } from '../dto/list-employee-documents.query.dto';
import type {
  ExpiringDocumentSortField,
  ExpiringDocumentSortOrder,
  ListExpiringDocumentsQueryDto,
} from '../dto/list-expiring-documents.query.dto';

const EMPLOYEE_DOCUMENT_ALLOWED_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
];

@Injectable()
export class EmployeeDocumentsService {
  private readonly logger = new Logger(EmployeeDocumentsService.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepo: IEmployeeRepository,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly filesService: FilesService,
  ) {}

  async upload(
    employeeId: string,
    file: Express.Multer.File,
    dto: UploadEmployeeDocumentDto,
    uploadedByUserId: string,
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const uploaded = await this.filesService.uploadAndRegister({
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      uploadedBy: uploadedByUserId,
      ownerType: 'EmployeeDocument',
      ownerId: employeeId,
      allowedMimeTypes: EMPLOYEE_DOCUMENT_ALLOWED_MIMES,
    });

    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    return prisma.employeeDocument.create({
      data: {
        employeeId,
        fileId: uploaded.id,
        category: dto.category,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        notes: dto.notes ?? null,
        uploadedByUserId,
        tenantId,
      },
    });
  }

  async list(
    employeeId: string,
    query: Partial<ListEmployeeDocumentsQueryDto> = {},
  ) {
    const employee = await this.employeeRepo.findById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);

    const prisma = this.tenantPrisma.getClient();
    const where: any = { employeeId };

    if (query.category) {
      where.category = query.category;
    }

    if (query.expiringWithinDays !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + query.expiringWithinDays);
      where.expiresAt = { lte: cutoff, not: null };
    }

    const page = query.page ?? 1;
    const limit = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      prisma.employeeDocument.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.employeeDocument.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getDownloadInfo(employeeId: string, docId: string) {
    const prisma = this.tenantPrisma.getClient();
    const doc = await prisma.employeeDocument.findUnique({
      where: { id: docId },
    });

    if (!doc || doc.employeeId !== employeeId) {
      throw new EmployeeDocumentNotFoundError(docId);
    }

    // No getSignedUrl in FilesService — return fileId for frontend to hit GET /files/:id
    return { fileId: doc.fileId };
  }

  async delete(employeeId: string, docId: string) {
    const prisma = this.tenantPrisma.getClient();
    const doc = await prisma.employeeDocument.findUnique({
      where: { id: docId },
    });

    if (!doc || doc.employeeId !== employeeId) {
      throw new EmployeeDocumentNotFoundError(docId);
    }

    // Delete DB row FIRST
    await prisma.employeeDocument.delete({ where: { id: docId } });

    // Best-effort blob cleanup — log failure, don't throw
    try {
      await this.filesService.delete(doc.fileId);
    } catch (err) {
      this.logger.warn(
        `Failed to delete blob for fileId ${doc.fileId}: ${(err as Error).message}`,
      );
    }
  }

  async listExpiringTenantWide(query: ListExpiringDocumentsQueryDto) {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();

    const search = query.search;
    if (search !== undefined && search.length === 1) {
      throw new BadRequestException('SEARCH_QUERY_TOO_SHORT');
    }

    const daysUntilExpiry = query.daysUntilExpiry ?? 30;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy: ExpiringDocumentSortField = query.sortBy ?? 'expiresAt';
    const sortOrder: ExpiringDocumentSortOrder = query.sortOrder ?? 'asc';
    const skip = (page - 1) * limit;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + daysUntilExpiry);

    // `category` is a Prisma enum, whose filter only supports equals/in/notIn —
    // `contains` is NOT supported on enums. To keep case-insensitive "contains"
    // semantics for category searches, match the enum VALUES that contain the
    // term (e.g. search "contract" matches CONTRACT).
    const matchingCategories =
      typeof search === 'string' && search.length >= 2
        ? Object.values(EmployeeDocumentCategory).filter((category) =>
            category.toLowerCase().includes(search.toLowerCase()),
          )
        : [];

    const where: Prisma.EmployeeDocumentWhereInput = {
      tenantId,
      expiresAt: { lte: cutoff, not: null },
      ...(typeof search === 'string' && search.length >= 2
        ? {
            OR: [
              {
                employee: {
                  firstName: { contains: search, mode: 'insensitive' },
                },
              },
              {
                employee: {
                  lastName: { contains: search, mode: 'insensitive' },
                },
              },
              {
                employee: {
                  employeeNumber: { contains: search, mode: 'insensitive' },
                },
              },
              ...(matchingCategories.length > 0
                ? [{ category: { in: matchingCategories } }]
                : []),
            ],
          }
        : {}),
    };

    const orderBy: Prisma.EmployeeDocumentOrderByWithRelationInput =
      sortBy === 'employeeName'
        ? { employee: { firstName: sortOrder } }
        : { [sortBy]: sortOrder };

    const [rows, total] = await Promise.all([
      prisma.employeeDocument.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.employeeDocument.count({ where }),
    ]);

    // Denormalize employee identity inline so the frontend needs no
    // capped second lookup. ONE batch read on the Employee model, which
    // is auto tenant-scoped by the tenant Prisma client — do NOT hand-add
    // tenantId here (cross-tenant ids are silently filtered out already).
    // Only the CURRENT PAGE is denormalized (page subset), keeping the
    // lookup bounded by `limit`.
    const employeeIds = [...new Set(rows.map((row: any) => row.employeeId))];
    const employees =
      employeeIds.length > 0
        ? await prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
            },
          })
        : [];
    const employeeById = new Map<string, any>(
      employees.map((employee: any) => [employee.id, employee]),
    );

    const data = rows.map((row: any) => {
      const employee = employeeById.get(row.employeeId);
      return {
        ...row,
        fullName: buildDisplayName(employee?.firstName, employee?.lastName),
        employeeNumber: employee?.employeeNumber ?? null,
      };
    });

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
