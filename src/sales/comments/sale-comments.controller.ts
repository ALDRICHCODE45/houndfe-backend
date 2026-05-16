import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { SaleCommentsService } from './sale-comments.service';
import { CreateSaleCommentDto } from './dto/create-sale-comment.dto';
import { UpdateSaleCommentDto } from './dto/update-sale-comment.dto';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SaleCommentsController {
  constructor(private readonly saleCommentsService: SaleCommentsService) {}

  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'SaleComment'])
  create(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Body() dto: CreateSaleCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.saleCommentsService.create(saleId, user.userId, dto);
  }

  @Patch(':id/comments/:commentId')
  @RequirePermissions(['update', 'SaleComment'])
  update(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('commentId', new ParseUUIDPipe()) commentId: string,
    @Body() dto: UpdateSaleCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.saleCommentsService.update(saleId, commentId, user.userId, dto);
  }

  @Delete(':id/comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'SaleComment'])
  async softDelete(
    @Param('id', new ParseUUIDPipe()) saleId: string,
    @Param('commentId', new ParseUUIDPipe()) commentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.saleCommentsService.softDelete(saleId, commentId, user.userId);
  }
}
