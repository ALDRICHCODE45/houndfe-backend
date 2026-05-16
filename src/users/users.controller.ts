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
}
