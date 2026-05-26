import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { EligibleUsersListDto } from './dto/eligible-users-list.dto';
import { ListEligibleUsersQueryDto } from './dto/list-eligible-users-query.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { TenantsMembershipService } from './tenants-membership.service';
import { TenantsService } from './tenants.service';

@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly tenantsMembershipService: TenantsMembershipService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Tenant'])
  create(@Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Tenant'])
  findAll(@Query('includeInactive') includeInactive?: string) {
    return this.tenantsService.findAll(includeInactive === 'true');
  }

  @Get(':id/roles')
  @RequirePermissions(['read', 'Tenant'])
  findRoles(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.findRoles(id);
  }

  @Get(':tenantId/eligible-users')
  @RequirePermissions(['create', 'TenantMembership'])
  findEligibleUsers(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: ListEligibleUsersQueryDto,
  ): Promise<EligibleUsersListDto> {
    return this.tenantsMembershipService.findEligibleUsers(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'Tenant'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Tenant'])
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'Tenant'])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.deactivate(id);
  }
}
