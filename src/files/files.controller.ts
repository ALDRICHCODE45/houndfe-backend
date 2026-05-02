/**
 * FilesController - HTTP Adapter (Driver Port) for File Storage.
 *
 * Translates HTTP requests to FilesService calls.
 * Handles: file upload, retrieval, deletion with multipart support.
 */
import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { FilesService } from './files.service';
import { UploadFileDto } from './dto/upload-file.dto';

@Controller('files')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  /**
   * POST /files - Upload a file
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'File'])
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.filesService.uploadAndRegister({
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      uploadedBy: user.userId,
    });
  }

  /**
   * GET /files/:id - Get file metadata by ID
   */
  @Get(':id')
  @RequirePermissions(['read', 'File'])
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.findById(id);
  }

  /**
   * DELETE /files/:id - Delete file (remote + DB)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'File'])
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.delete(id);
  }
}
