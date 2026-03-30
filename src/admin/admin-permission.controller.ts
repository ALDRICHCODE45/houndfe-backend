/**
 * AdminPermissionController - HTTP Adapter for permission listing.
 *
 * Read-only controller for listing permissions grouped by subject.
 * All routes protected by JWT + CASL permissions.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { AdminPermissionService } from './admin-permission.service';

@Controller('admin/permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminPermissionController {
  constructor(
    private readonly adminPermissionService: AdminPermissionService,
  ) {}

  @Get()
  @RequirePermissions(['read', 'Role'])
  findAll() {
    return this.adminPermissionService.findAll();
  }
}
