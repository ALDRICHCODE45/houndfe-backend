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
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { EmployeeEmergencyContactsService } from './application/employee-emergency-contacts.service';
import {
  CreateEmergencyContactDto,
  UpdateEmergencyContactDto,
} from './dto/emergency-contact.dto';

@Controller('admin/employees/:employeeId/emergency-contacts')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeeEmergencyContactsController {
  constructor(private readonly service: EmployeeEmergencyContactsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'EmployeeEmergencyContact'])
  create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateEmergencyContactDto,
  ) {
    return this.service.create(employeeId, dto);
  }

  @Get()
  @RequirePermissions(['read', 'EmployeeEmergencyContact'])
  list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.listForEmployee(employeeId);
  }

  @Patch(':contactId')
  @RequirePermissions(['update', 'EmployeeEmergencyContact'])
  update(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateEmergencyContactDto,
  ) {
    return this.service.update(employeeId, contactId, dto);
  }

  @Delete(':contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['delete', 'EmployeeEmergencyContact'])
  delete(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.service.delete(employeeId, contactId);
  }
}
