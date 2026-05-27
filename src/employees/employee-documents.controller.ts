import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { EmployeeDocumentsService } from './application/employee-documents.service';
import { UploadEmployeeDocumentDto } from './dto/upload-employee-document.dto';
import { ListEmployeeDocumentsQueryDto } from './dto/list-employee-documents.query.dto';

@Controller()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeeDocumentsController {
  constructor(private readonly documentsService: EmployeeDocumentsService) {}

  /**
   * POST /admin/employees/:employeeId/documents — multipart upload
   */
  @Post('admin/employees/:employeeId/documents')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'EmployeeDocument'])
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    // Extract DTO fields from the multipart body
    const dto: UploadEmployeeDocumentDto = {
      category: req.body.category,
      expiresAt: req.body.expiresAt,
      notes: req.body.notes,
    };
    return this.documentsService.upload(
      employeeId,
      file,
      dto,
      req.user?.id ?? null,
    );
  }

  /**
   * GET /admin/employees/:employeeId/documents — list documents for employee
   */
  @Get('admin/employees/:employeeId/documents')
  @RequirePermissions(['read', 'EmployeeDocument'])
  list(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListEmployeeDocumentsQueryDto,
  ) {
    return this.documentsService.list(employeeId, query);
  }

  /**
   * GET /admin/employees/:employeeId/documents/:docId/download — download info
   */
  @Get('admin/employees/:employeeId/documents/:docId/download')
  @RequirePermissions(['read', 'EmployeeDocument'])
  download(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.documentsService.getDownloadInfo(employeeId, docId);
  }

  /**
   * DELETE /admin/employees/:employeeId/documents/:docId
   */
  @Delete('admin/employees/:employeeId/documents/:docId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'EmployeeDocument'])
  async remove(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    await this.documentsService.delete(employeeId, docId);
  }

  /**
   * GET /admin/employees-documents/expiring — tenant-wide expiring documents
   */
  @Get('admin/employees-documents/expiring')
  @RequirePermissions(['read', 'EmployeeDocument'])
  listExpiring(@Query('daysUntilExpiry') daysUntilExpiry: string) {
    const days = parseInt(daysUntilExpiry, 10) || 30;
    return this.documentsService.listExpiringTenantWide(days);
  }
}
