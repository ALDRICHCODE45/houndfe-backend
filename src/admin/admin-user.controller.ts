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
import { AssignRolesDto } from './dto/assign-roles.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

  @Get()
  @RequirePermissions(['read', 'User'])
  findAll(@Query() query: PaginationQueryDto) {
    return this.adminUserService.findAll(query.page ?? 1, query.limit ?? 20);
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
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.adminUserService.update(id, dto);
  }

  @Patch(':id/roles')
  @RequirePermissions(['update', 'User'])
  assignRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRolesDto,
  ) {
    return this.adminUserService.assignRoles(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'User'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminUserService.deactivate(id);
  }
}
