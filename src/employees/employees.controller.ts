import {
  Body,
  Controller,
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
import { EmployeesService } from './application/employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees.query.dto';
import { TerminateEmployeeDto } from './dto/terminate-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Controller('admin/employees')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(['create', 'Employee'])
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get()
  @RequirePermissions(['read', 'Employee'])
  findAll(@Query() query: ListEmployeesQueryDto) {
    return this.employeesService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions(['read', 'Employee'])
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions(['update', 'Employee'])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto);
  }

  @Post(':id/terminate')
  @RequirePermissions(['update', 'Employee'])
  terminate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateEmployeeDto,
  ) {
    return this.employeesService.terminate(id, dto);
  }

  @Post(':id/reactivate')
  @RequirePermissions(['update', 'Employee'])
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.reactivate(id);
  }
}
