/**
 * AdminUserController - HTTP Adapter for user management.
 *
 * Translates HTTP requests to service calls.
 * All routes protected by JWT + CASL permissions.
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { AdminUserService } from './admin-user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../auth/authorization/domain/permission';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

  @Get()
  @RequirePermissions(['read', 'User'])
  findAll(@Query() query: PaginationQueryDto) {
    return this.adminUserService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'User'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminUserService.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'User'])
  create(@Body() dto: CreateUserDto) {
    return this.adminUserService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'User'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @Req() request: { user: AuthenticatedUser; ability: AppAbility },
  ) {
    return this.adminUserService.update(id, dto, request.user, request.ability);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'User'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminUserService.deactivate(id);
  }
}
