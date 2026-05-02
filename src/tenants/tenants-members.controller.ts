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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { TenantsMembershipService } from './tenants-membership.service';

@Controller('admin/tenants/:tenantId/members')
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class TenantsMembersController {
  constructor(private readonly tenantsMembershipService: TenantsMembershipService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: CreateMembershipDto,
  ) {
    return this.tenantsMembershipService.create(tenantId, dto);
  }

  @Get()
  findByTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.tenantsMembershipService.findByTenant(tenantId);
  }

  @Patch(':membershipId')
  update(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.tenantsMembershipService.update(tenantId, membershipId, dto);
  }

  @Delete(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
  ) {
    return this.tenantsMembershipService.remove(tenantId, membershipId);
  }
}
