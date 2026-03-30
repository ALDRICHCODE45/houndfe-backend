/**
 * AdminModule - NestJS module for admin management endpoints.
 *
 * Imports AuthModule to reuse repository tokens, guards, and domain logic.
 * Leaf module (no exports) - only provides HTTP endpoints.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminUserController } from './admin-user.controller';
import { AdminRoleController } from './admin-role.controller';
import { AdminPermissionController } from './admin-permission.controller';
import { AdminUserService } from './admin-user.service';
import { AdminRoleService } from './admin-role.service';
import { AdminPermissionService } from './admin-permission.service';

@Module({
  imports: [AuthModule], // Provides repository tokens, guards, ability factory
  controllers: [
    AdminUserController,
    AdminRoleController,
    AdminPermissionController,
  ],
  providers: [AdminUserService, AdminRoleService, AdminPermissionService],
})
export class AdminModule {}
