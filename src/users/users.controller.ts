import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { UsersService } from './users.service';
import { AssignableUserDto } from './dto/assignable-user.dto';

@Controller('users')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('assignable')
  @RequirePermissions(['read', 'Sale'])
  findAssignable(): Promise<AssignableUserDto[]> {
    return this.usersService.findAssignable();
  }

  /**
   * Users assignable as `driverUserId` on a delivery route. Route-manager
   * only (`create:DeliveryRoute`) — the manager is the one who creates
   * routes and assigns the driver. Returns users whose tenant role is a
   * pure driver (read + update on DeliveryRoute, no create/delete).
   */
  @Get('assignable-drivers')
  @RequirePermissions(['create', 'DeliveryRoute'])
  findAssignableDrivers(): Promise<AssignableUserDto[]> {
    return this.usersService.findAssignableDrivers();
  }
}
