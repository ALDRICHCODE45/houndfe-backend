/**
 * AdminRoleController - HTTP Adapter for role management.
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
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { AdminRoleService } from './admin-role.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';

@Controller('admin/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminRoleController {
  constructor(private readonly adminRoleService: AdminRoleService) {}

  @Get()
  @RequirePermissions(['read', 'Role'])
  findAll() {
    return this.adminRoleService.findAll();
  }

  @Get(':id')
  @RequirePermissions(['read', 'Role'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminRoleService.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Role'])
  create(@Body() dto: CreateRoleDto) {
    return this.adminRoleService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Role'])
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.adminRoleService.update(id, dto);
  }

  @Patch(':id/permissions')
  @RequirePermissions(['update', 'Role'])
  assignPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignPermissionsDto,
  ) {
    return this.adminRoleService.assignPermissions(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Role'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminRoleService.delete(id);
  }
}
